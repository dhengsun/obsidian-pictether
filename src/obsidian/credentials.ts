import { createHash, randomUUID } from 'node:crypto';
import { CloudConfigurationError, S3Backup, cloudFailureMessage } from '../core/r2';
import { credentialFingerprint, selectCredential, type CredentialProfile, type StateStore } from '../core/state';

export interface CredentialDraft {id?:string;name:string;accessKeyId:string;secretAccessKey:string}
export interface CredentialTest {status:'ok'|'error';checkedAt:number;configuration:string;digest:string;message:string}
export interface SecretAccess {setSecret(id:string,value:string):void;getSecret(id:string):string|null;listSecrets():string[]}
const ownedSecret=(name:string)=>/^pictether-(?:oss|r2)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-(?:id|key)$/.test(name);
const configIdentity=(settings:{endpoint:string;bucket:string;region:string})=>JSON.stringify([settings.endpoint,settings.bucket,settings.region]);
const credentialDigest=(access:string,secret:string)=>createHash('sha256').update(JSON.stringify([access,secret])).digest('hex');

export class CredentialsManager {
  private tasks=new Set<Promise<unknown>>();
  private paused=false;
  constructor(private state:StateStore,private storage:SecretAccess|undefined,private createClient:(endpoint:string,bucket:string,access:string,secret:string,region:string)=>Pick<S3Backup,'checkConnection'|'destroy'>=(endpoint,bucket,access,secret,region)=>new S3Backup(endpoint,bucket,access,secret,region)){}
  pause():void{this.paused=true;}
  resume():void{this.paused=false;}
  private track<T>(work:()=>Promise<T>):Promise<T>{
    if(this.paused||this.state.snapshot().settings.resetPending)return Promise.reject(new CloudConfigurationError('配置正在切换或重置尚未完成，请稍后重试。'));
    const task=work();this.tasks.add(task);void task.then(()=>this.tasks.delete(task),()=>this.tasks.delete(task));return task;
  }
  async idle():Promise<void>{await Promise.allSettled([...this.tasks]);}
  private resolve(draft:CredentialDraft):{access:string;secret:string;profile?:CredentialProfile}{
    const profile=this.state.snapshot().settings.credentials.find(item=>item.id===draft.id);
    if(draft.id&&!profile)throw new CloudConfigurationError('该凭据已不存在，请重新打开设置。');
    const access=draft.accessKeyId.trim(),secret=draft.secretAccessKey.trim();
    if(!access&&!secret&&profile){
      const savedAccess=this.storage?.getSecret(profile.accessKeySecret),savedSecret=this.storage?.getSecret(profile.secretKeySecret);
      if(!savedAccess||!savedSecret)throw new CloudConfigurationError('已保存的凭据不可用，请重新填写 ID 和 Key。');
      return{access:savedAccess,secret:savedSecret,profile};
    }
    if(!access||!secret)throw new CloudConfigurationError('请同时填写 Access Key ID 和 Secret Access Key。');
    return{access,secret,profile};
  }
  test(draft:CredentialDraft):Promise<CredentialTest>{return this.track(async()=>{
    const settings=this.state.snapshot().settings,{access,secret}=this.resolve(draft);
    let client:ReturnType<CredentialsManager['createClient']>|undefined;
    const result={checkedAt:Date.now(),configuration:configIdentity(settings),digest:credentialDigest(access,secret)};
    try{
      client=this.createClient(settings.endpoint,settings.bucket,access,secret,settings.region);
      await client.checkConnection();return{...result,status:'ok',message:'连接正常'};
    }catch(error){return{...result,status:'error',message:cloudFailureMessage(error)};}
    finally{client?.destroy();}
  });}
  save(draft:CredentialDraft,test?:CredentialTest):Promise<void>{return this.track(async()=>{
    const name=draft.name.trim();if(!name||name.length>80)throw new CloudConfigurationError('请填写不超过 80 字的凭据名称。');
    const {access,secret,profile}=this.resolve(draft);
    let accessReference=profile?.accessKeySecret,secretReference=profile?.secretKeySecret;
    if(draft.accessKeyId.trim()||!profile){
      if(!this.storage)throw new CloudConfigurationError('SecretStorage 不可用，凭据未保存。');
      const prefix=`pictether-oss-${randomUUID()}`;accessReference=`${prefix}-id`;secretReference=`${prefix}-key`;
      try{this.storage.setSecret(accessReference,access);this.storage.setSecret(secretReference,secret);}
      catch{throw new CloudConfigurationError('凭据保存失败，原配置已保留。');}
    }
    await this.state.update(next=>{
      const settings=next.settings,existing=settings.credentials.find(item=>item.id===draft.id);
      if(draft.id&&!existing)throw new CloudConfigurationError('该凭据已不存在，修改未保存。');
      if(settings.resetPending)throw new CloudConfigurationError('重置正在进行，修改未保存。');
      const saved:CredentialProfile={id:existing?.id??randomUUID(),name,accessKeySecret:accessReference!,secretKeySecret:secretReference!};
      if(test&&test.configuration===configIdentity(settings)&&test.digest===credentialDigest(access,secret))saved.test={status:test.status,checkedAt:test.checkedAt,fingerprint:credentialFingerprint(settings,saved)};
      else if(!test&&existing&&existing.accessKeySecret===saved.accessKeySecret&&existing.secretKeySecret===saved.secretKeySecret)saved.test=existing.test;
      if(existing)settings.credentials[settings.credentials.indexOf(existing)]=saved;else settings.credentials.push(saved);
      if(!settings.activeCredential||settings.activeCredential===saved.id)selectCredential(settings,saved.id);
    });
  });}
  async remove(id:string):Promise<void>{
    await this.state.update(next=>{
      const settings=next.settings,profile=settings.credentials.find(item=>item.id===id);if(!profile)return;
      settings.credentials=settings.credentials.filter(item=>item.id!==id);
      if(settings.activeCredential===id)selectCredential(settings,'');
      for(const name of [profile.accessKeySecret,profile.secretKeySecret])if(ownedSecret(name)&&!settings.credentials.some(item=>item.accessKeySecret===name||item.secretKeySecret===name))settings.retiredSecrets.push(name);
    });
    await this.cleanupRetired();
  }
  async cleanupRetired():Promise<void>{
    const names=this.state.snapshot().settings.retiredSecrets;if(!names.length)return;
    if(!this.storage)throw new CloudConfigurationError('SecretStorage 不可用，凭据清理待重试。');
    try{for(const name of names)if(ownedSecret(name)&&!this.state.snapshot().settings.credentials.some(item=>item.accessKeySecret===name||item.secretKeySecret===name))this.storage.setSecret(name,'');}
    catch{throw new CloudConfigurationError('凭据清理未完成，请重试删除或重置。');}
    await this.state.update(next=>{next.settings.retiredSecrets=next.settings.retiredSecrets.filter(name=>!names.includes(name));});
  }
  async eraseManaged():Promise<void>{
    if(!this.storage)throw new CloudConfigurationError('SecretStorage 不可用，重置未完成。');
    try{for(const name of this.storage.listSecrets())if(ownedSecret(name))this.storage.setSecret(name,'');}
    catch{throw new CloudConfigurationError('密钥清理失败，重置待重试。');}
  }
}

/** Publish a complete pair without modifying any existing/shared secret entry. */
export async function saveR2Credentials(state:StateStore,storage:{setSecret(id:string,value:string):void}|undefined,accessKeyId:string,secretAccessKey:string):Promise<void>{
  const access=accessKeyId.trim(),secret=secretAccessKey.trim();
  if(!access||!secret)throw new CloudConfigurationError('请同时填写 Access Key ID 和 Secret Access Key。');
  if(access===secret)throw new CloudConfigurationError('Access Key ID 和 Secret Access Key 不能相同，请填写 Cloudflare 提供的对应两项值。');
  if(!storage)throw new CloudConfigurationError('Obsidian SecretStorage 不可用，凭据未保存。');
  const prefix=`pictether-r2-${randomUUID()}`,accessReference=`${prefix}-id`,secretReference=`${prefix}-key`;
  try{
    storage.setSecret(accessReference,access);
    storage.setSecret(secretReference,secret);
    await state.update(next=>{next.settings.accessKeySecret=accessReference;next.settings.secretKeySecret=secretReference;});
  }catch{
    // Do not echo storage errors: they may contain secret values. Existing
    // references stay active; owned unreferenced entries are never auto-deleted.
    throw new CloudConfigurationError('凭据保存失败，原配置已保留。请检查 SecretStorage 和插件存储后重试。');
  }
}
