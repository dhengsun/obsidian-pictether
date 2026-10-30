import { expect, it, vi } from 'vitest';
import { CredentialsManager, type CredentialDraft } from '../src/obsidian/credentials';
import { StateStore, settingsState, credentialFingerprint } from '../src/core/state';
function setup(){
  const initial=settingsState(null);Object.assign(initial.settings,{endpoint:'https://storage.example',bucket:'test-bucket'});
  const saved:unknown[]=[],state=new StateStore(initial,async value=>{saved.push(structuredClone(value));}),entries=new Map<string,string>();
  const storage={getSecret:(name:string)=>entries.get(name)??null,setSecret:vi.fn((name:string,value:string)=>{entries.set(name,value);}),listSecrets:()=>[...entries.keys()]};
  const check=vi.fn(async()=>{}),destroy=vi.fn(),factory=vi.fn(()=>({checkConnection:check,destroy}));
  const manager=new CredentialsManager(state,storage,factory);return{state,saved,entries,storage,check,destroy,factory,manager};
}
const draft:CredentialDraft={name:'主备份',accessKeyId:'placeholder-id',secretAccessKey:'placeholder-key'};
it('does not impose R2-only credential-value rules on other S3 providers',async()=>{
  const x=setup();await x.manager.save({...draft,accessKeyId:'local-example-value',secretAccessKey:'local-example-value'});
  const profile=x.state.snapshot().settings.credentials[0]!;expect(profile.accessKeySecret).not.toBe(profile.secretKeySecret);
});
it('tests drafts without writes and publishes a tested pair without raw values or test digests in settings',async()=>{
  const x=setup(),receipt=await x.manager.test(draft);
  expect(receipt.status).toBe('ok');expect(x.saved).toEqual([]);expect(x.storage.setSecret).not.toHaveBeenCalled();
  await x.manager.save(draft,receipt);
  const settings=x.state.snapshot().settings,profile=settings.credentials[0]!;
  expect(profile.test?.fingerprint).toBe(credentialFingerprint(settings,profile));expect(profile.test?.fingerprint).not.toBe(receipt.digest);
  expect(settings.activeCredential).toBe(profile.id);expect(settings.accessKeySecret).toBe(profile.accessKeySecret);
  expect(profile.accessKeySecret).toMatch(/^pictether-oss-/);expect(JSON.stringify(x.saved)).not.toMatch(/placeholder-id|placeholder-key/);
  expect(x.destroy).toHaveBeenCalledOnce();
});
it('does not accept test receipts after connection or credential inputs change',async()=>{
  const x=setup(),receipt=await x.manager.test(draft);
  await x.state.update(next=>{next.settings.region='new-region';});await x.manager.save(draft,receipt);
  expect(x.state.snapshot().settings.credentials[0]?.test).toBeUndefined();
  const next=await x.manager.test(draft);await x.manager.save({...draft,secretAccessKey:'changed-key'},next);
  expect(x.state.snapshot().settings.credentials[1]?.test).toBeUndefined();
});
it('drops old green status when a supplied receipt no longer matches a saved credential value',async()=>{
  const x=setup(),receipt=await x.manager.test(draft);await x.manager.save(draft,receipt);
  const profile=x.state.snapshot().settings.credentials[0]!,edit={id:profile.id,name:profile.name,accessKeyId:'',secretAccessKey:''};
  const tested=await x.manager.test(edit);x.entries.set(profile.secretKeySecret,'externally-changed-key');
  await x.manager.save(edit,tested);expect(x.state.snapshot().settings.credentials[0]?.test).toBeUndefined();
});
it('can test and rename a saved pair with blank fields without rewriting secret entries',async()=>{
  const x=setup();await x.manager.save(draft);const profile=x.state.snapshot().settings.credentials[0]!,writes=x.storage.setSecret.mock.calls.length;
  const edit={id:profile.id,name:'新名称',accessKeyId:'',secretAccessKey:''},receipt=await x.manager.test(edit);await x.manager.save(edit,receipt);
  expect(x.storage.setSecret).toHaveBeenCalledTimes(writes);expect(x.state.snapshot().settings.credentials[0]?.name).toBe('新名称');
  expect(x.state.snapshot().settings.credentials[0]?.test?.status).toBe('ok');
  await expect(x.manager.save({...edit,accessKeyId:'partial-edit'})).rejects.toThrow('同时填写');
});
it('clears only owned unshared values after deletion and never automatically picks another active key',async()=>{
  const x=setup();await x.manager.save(draft);const first=x.state.snapshot().settings.credentials[0]!;
  await x.manager.save({...draft,name:'第二组'});const second=x.state.snapshot().settings.credentials[1]!;
  x.entries.set('unrelated-secret','unrelated-value');
  await x.manager.remove(first.id);
  const settings=x.state.snapshot().settings;expect(settings.activeCredential).toBe('');expect(settings.accessKeySecret).toBe('');
  expect(settings.credentials.map(item=>item.id)).toEqual([second.id]);expect(x.entries.get(first.accessKeySecret)).toBe('');expect(x.entries.get(second.accessKeySecret)).toBe('placeholder-id');
  expect(x.entries.get('unrelated-secret')).toBe('unrelated-value');expect(settings.retiredSecrets).toEqual([]);
});
it('preserves values still referenced by another saved profile',async()=>{
  const x=setup();await x.manager.save(draft);const first=x.state.snapshot().settings.credentials[0]!;
  await x.state.update(next=>{next.settings.credentials.push({...first,id:'shared-profile',name:'共享'});});
  await x.manager.remove(first.id);expect(x.entries.get(first.accessKeySecret)).toBe('placeholder-id');
});
it('journals a failed explicit key cleanup and completes it on retry',async()=>{
  const x=setup();await x.manager.save(draft);const profile=x.state.snapshot().settings.credentials[0]!;
  const original=x.storage.setSecret.getMockImplementation()!;
  x.storage.setSecret.mockImplementation(()=>{throw new Error('sensitive-marker');});
  await expect(x.manager.remove(profile.id)).rejects.toThrow('清理未完成');
  expect(x.state.snapshot().settings.credentials).toEqual([]);expect(x.state.snapshot().settings.retiredSecrets).toHaveLength(2);
  x.storage.setSecret.mockImplementation(original);await x.manager.cleanupRetired();
  expect(x.state.snapshot().settings.retiredSecrets).toEqual([]);expect(x.entries.get(profile.secretKeySecret)).toBe('');
});
it('erases generated orphan/old entries during reset while preserving unrelated storage',async()=>{
  const x=setup();await x.manager.save(draft);await x.manager.save(draft);
  x.entries.set('user-managed-entry','untouched');await x.manager.eraseManaged();
  for(const[name,value]of x.entries)expect(value).toBe(name==='user-managed-entry'?'untouched':'');
});
it('pauses new tests and waits for already-started tests before connection changes',async()=>{
  const x=setup();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});x.check.mockImplementation(()=>gate);
  const running=x.manager.test(draft);x.manager.pause();let idle=false;const wait=x.manager.idle().then(()=>{idle=true;});
  await expect(x.manager.test(draft)).rejects.toThrow('正在切换');await Promise.resolve();expect(idle).toBe(false);
  release();await running;await wait;expect(idle).toBe(true);x.manager.resume();
  await x.state.update(next=>{next.settings.resetPending=true;});await expect(x.manager.save(draft)).rejects.toThrow('重置');
});
