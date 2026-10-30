import { t } from '../core/i18n';
import { App, Menu, Modal, Notice, Plugin, PluginSettingTab, Setting, SettingGroup, setIcon } from 'obsidian';
import path from 'node:path';
import type { LocalResetPlan } from '../core/reset';
import type { JobStore } from '../core/job-store';
import { credentialFingerprint, selectCredential, type Settings, type StateStore, type CredentialProfile } from '../core/state';
import { CloudConfigurationError, cloudFailureMessage, validateR2Bucket, validateR2Endpoint } from '../core/r2';
import { CredentialsManager } from './credentials';
import { CredentialDialog } from './credential-dialog';

export interface CloudSettingsActions {
  credentials:CredentialsManager;
  apply():Promise<void>;
  update(change:(settings:Settings)=>void):Promise<void>;
  removeCredential(id:string):Promise<void>;
  restore():Promise<void>;
  reviewReset():Promise<LocalResetPlan>;
  reset(review:LocalResetPlan):Promise<void>;
}
export function profileStatus(settings:Settings,profile:CredentialProfile):'ok'|'error'|'untested'{
  return profile.test?.fingerprint===credentialFingerprint(settings,profile)?profile.test.status:'untested';
}
function confirmAction(app:App,title:string,description:string,run:()=>Promise<void>):void {
  new class extends Modal {
    onOpen():void {
      this.modalEl.classList.add('pictether-confirm-modal');
      this.contentEl.createEl('h2',{text:title});this.contentEl.createEl('p',{text:description});
      const result=this.contentEl.createEl('p',{attr:{role:'alert'}});
      new Setting(this.contentEl).setClass('pictether-dialog-actions')
        .addButton(button=>button.setButtonText(t("取消")).onClick(()=>this.close()))
        .addButton(button=>button.setButtonText(t("确认")).setWarning().onClick(()=>{
          button.setDisabled(true);void run().then(()=>this.close()).catch(error=>{result.setText(cloudFailureMessage(error));button.setDisabled(false);});
        }));
    }
    onClose():void{this.contentEl.empty();}
  }(app).open();
}
export class PictetherSettings extends PluginSettingTab {
  private generation=0;
  private timer?:ReturnType<typeof setInterval>;
  private dialog?:CredentialDialog;
  private menu?:Menu;
  private resetDialog?:Modal;
  private confirmReset(done:()=>void):void {
    if(!this.actions)return;
    this.resetDialog?.close();
    const actions=this.actions;
    this.resetDialog=new class extends Modal {
      private closed=false;
      onOpen():void {
        this.modalEl.classList.add('pictether-reset-modal');
        this.contentEl.createEl('h2',{text:t("重置 Pictether")});
        this.contentEl.createEl('p',{text:t("删除当前附件根目录下所有命名空间的受管理附件，并清空配置、记录、统计与插件密钥。笔记和云端保留。")});
        const summary=this.contentEl.createEl('p',{text:t("正在检查本地附件…"),cls:'pictether-reset-summary'});
        const label=this.contentEl.createEl('label',{cls:'pictether-reset-ack'});
        const checkbox=label.createEl('input',{attr:{type:'checkbox'}});checkbox.disabled=true;
        label.createSpan({text:t("我确认共用此目录的其他库也受影响，未备份的本地附件将永久丢失。")});
        const feedback=this.contentEl.createEl('p',{attr:{role:'alert'}});
        let review:LocalResetPlan|undefined,working=false,confirm!:import('obsidian').ButtonComponent;
        checkbox.addEventListener('change',()=>confirm.setDisabled(!review||!checkbox.checked||working));
        new Setting(this.contentEl).setClass('pictether-dialog-actions')
          .addButton(button=>button.setButtonText(t("取消")).onClick(()=>{if(!working)this.close();}))
          .addButton(button=>{
            confirm=button;button.setButtonText(t("删除本地附件并重置")).setWarning().setDisabled(true).onClick(()=>{
              if(!review||!checkbox.checked||working)return;
              working=true;button.setDisabled(true);checkbox.disabled=true;
              void actions.reset(review).then(()=>{this.close();done();}).catch(error=>{
                feedback.setText(cloudFailureMessage(error));summary.setText(t("请关闭此窗口，重新检查范围后继续重置。"));
                review=undefined;working=false;done();
              });
            });
          });
        void actions.reviewReset().then(value=>{
          if(this.closed)return;review=value;
          summary.setText(t("本地目录：{0}\n{1} 个命名空间，{2} 个附件。{3}", value.root, value.namespaces, value.files, value.unknown?t("另有 {0} 个未识别项目会保留。", value.unknown):''));
          checkbox.disabled=false;
        }).catch(error=>{if(!this.closed){summary.setText(t("无法确认删除范围，重置未开始。"));feedback.setText(cloudFailureMessage(error));}});
      }
      onClose():void{this.closed=true;this.contentEl.empty();}
    }(this.app);
    this.resetDialog.open();
  }
  constructor(app:App,plugin:Plugin,private state:StateStore,private jobs?:JobStore,private actions?:CloudSettingsActions){super(app,plugin);}
  display():void {
    this.menu?.hide();this.menu=undefined;
    if(this.timer)clearInterval(this.timer);
    const generation=++this.generation,root=this.containerEl,settings=this.state.snapshot().settings;
    root.empty();root.classList.add('pictether-settings');
    const sections=new Map<HTMLElement,HTMLElement>();
    const section=(title:string)=>{
      const shell=root.createDiv({cls:'pictether-settings-section'});
      const group=new SettingGroup(shell).setHeading(title);
      sections.set(group.listEl,shell);return group.listEl;
    };
    const run=async(work:()=>Promise<void>)=>{
      try{await work();if(generation===this.generation)this.display();}
      catch(error){new Notice(`Pictether: ${cloudFailureMessage(error)}`,10000);}
    };
    const apply=()=>this.actions?.apply()??Promise.resolve();
    const commit=(change:(value:Settings)=>void)=>this.actions?this.actions.update(change):this.state.update(next=>change(next.settings));
    const general=section(t("通用设置"));let assetsRoot=settings.assetsRoot;
    new Setting(general).setClass('pictether-path-setting').setName(t("附件根目录")).setDesc(t("附件统一保存在此目录。")).addText(input=>input.setValue(assetsRoot).onChange(value=>{assetsRoot=value;}));
    const vaultName=this.app.vault.getName();
    new Setting(general).setName(t("仓库名")).setClass('pictether-vault-setting').controlEl.createSpan({text:vaultName,cls:'pictether-readonly-value',attr:{title:vaultName}});
    const saveGeneral=sections.get(general)!.createDiv({cls:'pictether-section-actions'}).createEl('button',{text:t("保存通用设置"),attr:{type:'button'}});
    saveGeneral.disabled=!this.jobs||settings.resetPending;
    saveGeneral.addEventListener('click',()=>{
      const values={assetsRoot};
      saveGeneral.disabled=true;void run(async()=>{
        if(!path.isAbsolute(values.assetsRoot))throw new CloudConfigurationError(t("附件根目录必须为绝对路径。"));
        await commit(next=>{next.assetsRoot=values.assetsRoot;});
      }).finally(()=>{if(generation===this.generation)saveGeneral.disabled=false;});
    });
    const oss=section(t("OSS 配置"));let endpoint=settings.endpoint,bucket=settings.bucket,region=settings.region,dirty=false;
    new Setting(oss).setName(t("服务地址")).addText(input=>input.setValue(endpoint).setPlaceholder('https://…').onChange(value=>{endpoint=value;dirty=true;}));
    new Setting(oss).setName(t("存储桶")).addText(input=>input.setValue(bucket).setPlaceholder('bucket-name').onChange(value=>{bucket=value;dirty=true;}));
    const advanced=oss.createEl('details',{cls:'pictether-settings-advanced'});advanced.createEl('summary',{text:t("高级设置")});
    new Setting(advanced).setName(t("签名区域")).setDesc(t("R2 使用 auto，其他服务按其 S3 配置填写。")).addText(input=>input.setValue(region).onChange(value=>{region=value;dirty=true;}));
    const saveOss=sections.get(oss)!.createDiv({cls:'pictether-section-actions'}).createEl('button',{text:t("保存 OSS 配置"),attr:{type:'button'}});
    saveOss.disabled=!this.jobs||settings.resetPending;
    saveOss.addEventListener('click',()=>{
      const values={endpoint:endpoint.trim(),bucket:bucket.trim(),region:region.trim()};
      saveOss.disabled=true;void run(async()=>{
        if(values.endpoint)validateR2Endpoint(values.endpoint);if(values.bucket)validateR2Bucket(values.bucket);
        if(!/^[a-zA-Z0-9-]{1,64}$/.test(values.region))throw new CloudConfigurationError(t("签名区域格式无效。"));
        await commit(next=>{next.endpoint=values.endpoint?new URL(values.endpoint).origin:'';next.bucket=values.bucket;next.region=values.region;});
      }).finally(()=>{if(generation===this.generation)saveOss.disabled=false;});
    });
    const credentials=sections.get(oss)!.createDiv({cls:'pictether-credentials'});
    const listHeader=credentials.createDiv({cls:'pictether-rk-heading'});listHeader.createSpan({text:t("RK 访问凭据")});
    const open=(profile?:CredentialProfile)=>{
      if(!this.actions||settings.resetPending)return;
      if(dirty){new Notice(t("请先保存 OSS 地址和存储桶。"));return;}
      this.dialog=new CredentialDialog(this.app,this.actions.credentials,async()=>{await apply();if(generation===this.generation)this.display();},profile,profile?profileStatus(settings,profile):'untested');this.dialog.open();
    };
    const add=listHeader.createEl('button',{cls:'clickable-icon pictether-icon-button',attr:{type:'button','aria-label':t("新增 RK"),title:t("新增 RK")}});
    setIcon(add,'plus');add.disabled=!this.jobs||settings.resetPending;add.addEventListener('click',()=>open());
    const list=credentials.createDiv({cls:'pictether-rk-list'});
    if(!settings.credentials.length){const empty=list.createDiv({cls:'pictether-rk-empty'});empty.createSpan({cls:'pictether-status-dot is-untested'});empty.createSpan({text:t("尚未添加凭据")});}
    for(const profile of settings.credentials){
      const status=profileStatus(settings,profile),row=list.createDiv({cls:'pictether-rk-row'});
      const info=row.createDiv({cls:'pictether-rk-info'});
      info.createSpan({cls:`pictether-status-dot is-${status}`});
      const identity=info.createSpan({cls:'pictether-rk-identity'});identity.createSpan({text:profile.name,cls:'pictether-rk-name',attr:{title:profile.name}});identity.createSpan({text:'••••••••',cls:'pictether-rk-mask'});
      info.createSpan({text:status==='ok'?t("连接正常"):status==='error'?t("连接失败"):t("未测试"),cls:'pictether-rk-status'});
      const controls=row.createDiv({cls:'pictether-rk-controls'});
      if(profile.id===settings.activeCredential)controls.createSpan({text:t("当前"),cls:'pictether-rk-current'});
      else{const activate=controls.createEl('button',{text:t("启用")});activate.disabled=settings.resetPending;activate.addEventListener('click',()=>{activate.disabled=true;void run(()=>commit(next=>selectCredential(next,profile.id)));});}
      const more=controls.createEl('button',{cls:'clickable-icon pictether-icon-button pictether-rk-more',attr:{type:'button','aria-label':t("{0} 的更多操作", profile.name),title:t("更多操作"),'aria-haspopup':'menu'}});
      setIcon(more,'ellipsis');more.disabled=settings.resetPending||!this.actions;
      more.addEventListener('click',()=>{
        this.menu?.hide();const menu=new Menu();this.menu=menu;
        menu.addItem(item=>item.setTitle(t("编辑")).setIcon('pencil').onClick(()=>{if(generation===this.generation)open(profile);}));
        menu.addItem(item=>item.setTitle(t("删除")).setIcon('trash-2').onClick(()=>{
          if(generation!==this.generation)return;
          confirmAction(this.app,t("删除 RK"),t("删除“{0}”及其专属密钥，笔记、本地附件和云端保持不变。", profile.name),async()=>{try{await this.actions!.removeCredential(profile.id);}finally{if(generation===this.generation)this.display();}});
        }));
        const rect=more.getBoundingClientRect();menu.showAtPosition({x:rect.left,y:rect.bottom},more.ownerDocument);
      });
    }
    const backup=section(t("备份与恢复"));
    const backupDescription=!settings.activeCredential?t("启用一组 RK 后，自动备份已有及新增附件。"):!settings.endpoint||!settings.bucket?t("填写服务地址和存储桶后开始备份。"):t("开启后自动备份已有及新增附件。");
    new Setting(backup).setName(t("自动备份")).setDesc(backupDescription).addToggle(toggle=>toggle.setValue(settings.autoBackup).setDisabled(!this.jobs||settings.resetPending).onChange(async value=>{
      await run(()=>commit(next=>{next.autoBackup=value;}));
    }));
    new Setting(backup).setClass('pictether-button-setting').setName(t("恢复缺失附件")).setDesc(t("从 OSS 补齐笔记引用的缺失文件。")).addButton(button=>button.setButtonText(t("恢复")).setDisabled(!this.jobs||settings.resetPending).onClick(()=>{
      button.setDisabled(true);void run(()=>this.actions?.restore()??Promise.resolve()).finally(()=>{if(generation===this.generation)button.setDisabled(false);});
    }));
    new Setting(backup).setClass('pictether-button-setting').setName(settings.resetPending?t("重置未完成"):t("重置插件")).setDesc(t("删除当前根目录内全部受管理附件，清空配置、记录、统计和插件密钥。保留笔记与云端。")).addButton(button=>button.setButtonText(settings.resetPending?t("继续重置"):t("重置")).setWarning().setDisabled(!this.jobs||!this.actions).onClick(()=>{
      this.confirmReset(()=>{if(generation===this.generation)this.display();});
    }));
    const today=section(t("今日概览")),numbers=today.createDiv({cls:'pictether-stats'}),values:HTMLElement[]=[];
    for(const label of [t("备份次数"),t("成功"),t("冲突"),t("失败")]){const item=numbers.createDiv({cls:'pictether-stat'});values.push(item.createSpan({text:'—',cls:'pictether-stat-value'}));item.createSpan({text:label,cls:'pictether-settings-caption'});}
    const caption=sections.get(today)!.createEl('p',{text:t("按本地自然日统计附件备份尝试。"),cls:'pictether-settings-caption'});
    if(!this.jobs)caption.setText(t("本地数据库暂不可用"));
    let refreshId=0;
    const refresh=async()=>{
      if(!this.jobs)return;const request=++refreshId,current=this.state.snapshot().settings;
      let target='';try{if(current.endpoint)target=`${new URL(current.endpoint).origin}/${current.bucket}`;}catch{ /* Incomplete configuration has no target. */ }
      try{
        const stats=await this.jobs.daily(current.assetsRoot,target);
        if(generation!==this.generation||request!==refreshId)return;
        [stats.attempts,stats.success,stats.conflict,stats.failed].forEach((value,index)=>values[index]!.setText(String(value)));
      }catch{if(generation===this.generation)caption.setText(t("今日统计暂不可用"));}
    };
    void refresh();this.timer=setInterval(()=>{if(root.isConnected)void refresh();},5000);
  }
  hide():void {this.generation++;if(this.timer)clearInterval(this.timer);this.timer=undefined;this.menu?.hide();this.menu=undefined;this.dialog?.close();this.dialog=undefined;this.resetDialog?.close();this.resetDialog=undefined;}
}
