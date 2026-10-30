// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { App, Plugin } from 'obsidian';
import type { LocalResetPlan } from '../src/core/reset';
import type { JobStore } from '../src/core/job-store';
import { credentialFingerprint, StateStore, settingsState, type Settings } from '../src/core/state';
import { CredentialsManager } from '../src/obsidian/credentials';
import { PictetherSettings, profileStatus, type CloudSettingsActions } from '../src/obsidian/settings';

interface Button {text:string;disabled:boolean;click():void}
interface Row {name:string;buttons:Button[];change?:(value:string)=>void;toggle?:(value:boolean)=>Promise<void>;input?:HTMLInputElement}
const ui=vi.hoisted(()=>({rows:[] as Row[],notices:[] as string[],menu:[] as {title:string;click:()=>void}[]}));
vi.mock('obsidian',()=>({
  setIcon:(el:HTMLElement,icon:string)=>{el.dataset.icon=icon;},
  Menu:class{
    constructor(){ui.menu=[];}
    addItem(callback:(item:unknown)=>void){const entry={title:'',click:()=>{}};ui.menu.push(entry);const item={setTitle:(title:string)=>{entry.title=title;return item;},setIcon:()=>item,onClick:(click:()=>void)=>{entry.click=click;return item;}};callback(item);return this;}
    showAtPosition(){return this;}hide(){return this;}
  },
  PluginSettingTab:class{containerEl=document.createElement('div');constructor(readonly app:unknown){}},
  Modal:class{
    modalEl=document.createElement('div');contentEl=document.createElement('div');
    constructor(readonly app:unknown){this.modalEl.appendChild(this.contentEl);this.modalEl.className='modal';}
    onOpen(){}onClose(){}
    open(){document.body.appendChild(this.modalEl);this.onOpen();}
    close(){this.onClose();this.modalEl.remove();}
  },
  Notice:class{constructor(message:string){ui.notices.push(message);}},
  Setting:class{
    row:Row={name:'',buttons:[]};el=document.createElement('div');nameEl=document.createElement('span');
    constructor(readonly container:HTMLElement){ui.rows.push(this.row);this.el.appendChild(this.nameEl);container.appendChild(this.el);}
    setName(name:string){this.row.name=name;this.nameEl.textContent=name;return this;}
    setDesc(){return this;}setClass(name:string){this.el.classList.add(name);return this;}
    addText(callback:(control:unknown)=>void){
      const inputEl=document.createElement('input');this.row.input=inputEl;this.el.appendChild(inputEl);
      const control={inputEl,setValue:(value:string)=>{inputEl.value=value;return control;},setPlaceholder:(value:string)=>{inputEl.placeholder=value;return control;},setDisabled:(value:boolean)=>{inputEl.disabled=value;return control;},onChange:(change:(value:string)=>void)=>{this.row.change=change;return control;}};
      callback(control);return this;
    }
    addToggle(callback:(control:unknown)=>void){const control={setValue:()=>control,setDisabled:()=>control,onChange:(change:(value:boolean)=>Promise<void>)=>{this.row.toggle=change;return control;}};callback(control);return this;}
    addButton(callback:(control:unknown)=>void){
      const button:Button={text:'',disabled:false,click:()=>{}};this.row.buttons.push(button);
      const el=document.createElement('button');this.el.appendChild(el);el.addEventListener('click',()=>button.click());
      const control={setButtonText:(text:string)=>{button.text=el.textContent=text;return control;},setDisabled:(disabled:boolean)=>{button.disabled=el.disabled=disabled;return control;},setCta:()=>control,setWarning:()=>control,onClick:(click:()=>void)=>{button.click=click;return control;}};
      callback(control);return this;
    }
  }
}));
const tabs:PictetherSettings[]=[];
afterEach(()=>{for(const tab of tabs.splice(0))tab.hide();});
beforeEach(()=>{
  ui.rows.length=0;ui.notices.length=0;ui.menu.length=0;document.body.innerHTML='';
  const create=function(this:HTMLElement,tag:string,options:{text?:string;cls?:string;attr?:Record<string,string>}={}){const node=document.createElement(tag);node.textContent=options.text??'';node.className=options.cls??'';for(const[key,value]of Object.entries(options.attr??{}))node.setAttribute(key,value);this.appendChild(node);return node;};
  Object.assign(HTMLElement.prototype,{
    empty(this:HTMLElement){this.replaceChildren();},setText(this:HTMLElement,text:string){this.textContent=text;},createEl:create,
    createDiv(this:HTMLElement,options:unknown={}){return create.call(this,'div',options as never);},
    createSpan(this:HTMLElement,options:unknown={}){return create.call(this,'span',options as never);}
  });
});
function setup(patch:Partial<Settings>={}){
  const initial=settingsState(null);Object.assign(initial.settings,patch);
  const persisted:unknown[]=[];const state=new StateStore(initial,async value=>{persisted.push(structuredClone(value));});
  const entries=new Map<string,string>(),storage={setSecret:vi.fn((name:string,value:string)=>{entries.set(name,value);}),getSecret:vi.fn((name:string)=>entries.get(name)??null),listSecrets:()=>[...entries.keys()]};
  const check=vi.fn(async()=>{}),destroy=vi.fn();
  const manager=new CredentialsManager(state,storage,()=>({checkConnection:check,destroy}));
  const daily=vi.fn(async()=>({attempts:5,success:3,conflict:1,failed:1})),errors=vi.fn(async()=>[{error:'raw-log-marker'}]);
  const jobs={daily,errors} as unknown as JobStore;
  const apply=vi.fn(async()=>{});
  const callbacks:CloudSettingsActions={credentials:manager,apply,update:vi.fn(async change=>{await state.update(next=>change(next.settings));await apply();}),removeCredential:vi.fn(async id=>{await manager.remove(id);}),restore:vi.fn(async()=>{}),reviewReset:vi.fn(async()=>({root:'/tmp/attachments',files:12,namespaces:2,unknown:1,fingerprint:'review'} as LocalResetPlan)),reset:vi.fn(async()=>{})};
  const tab=new PictetherSettings({secretStorage:storage,vault:{getName:()=> 'System Vault'}} as unknown as App,{} as Plugin,state,jobs,callbacks);tabs.push(tab);
  document.body.appendChild(tab.containerEl);tab.display();return{tab,state,persisted,entries,storage,manager,check,destroy,daily,errors,callbacks};
}
const row=(name:string)=>[...ui.rows].reverse().find(item=>item.name===name)!;
const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].reverse().find(item=>item.textContent===text)!;
const nativeButton=(root:HTMLElement,text:string)=>[...root.querySelectorAll('button')].find(item=>item.textContent===text)!;
const add=(x:ReturnType<typeof setup>)=>x.tab.containerEl.querySelector<HTMLButtonElement>('[aria-label="新增 RK"]')!.click();
const action=(x:ReturnType<typeof setup>,name:string)=>{x.tab.containerEl.querySelector<HTMLButtonElement>('.pictether-rk-more')!.click();ui.menu.find(item=>item.title===name)!.click();};

it('renders four Chinese sections, compact daily figures and no log list or immediate-backup controls',async()=>{
  const x=setup();
  expect([...x.tab.containerEl.querySelectorAll('h3')].map(item=>item.textContent)).toEqual(['通用设置','OSS 配置','备份与恢复','今日概览']);
  await vi.waitFor(()=>expect(x.tab.containerEl.querySelector('.pictether-stat-value')?.textContent).toBe('5'));
  expect(x.errors).not.toHaveBeenCalled();expect(x.tab.containerEl.textContent).not.toMatch(/raw-log-marker|立即备份|Auto Backup|Sync on Startup/);
  expect(x.tab.containerEl.querySelector('.is-untested')).not.toBeNull();
  expect(row('仓库名').input).toBeUndefined();
  expect(x.tab.containerEl.querySelectorAll('.pictether-section-actions')).toHaveLength(2);
  expect(x.tab.containerEl.querySelector('.setting-item.pictether-section-actions')).toBeNull();
});
it('validates an OSS address before saving and applies valid changes',async()=>{
  const x=setup();row('服务地址').change!('http://invalid.example');button('保存 OSS 配置').click();
  await vi.waitFor(()=>expect(ui.notices.join()).toContain('HTTPS'));expect(x.persisted).toEqual([]);
  row('服务地址').change!('https://storage.example');row('存储桶').change!('test-bucket');button('保存 OSS 配置').click();
  await vi.waitFor(()=>expect(x.state.snapshot().settings.endpoint).toBe('https://storage.example'));
  expect(x.callbacks.apply).toHaveBeenCalledOnce();
});
it('tests a draft without saving, and cancellation leaves settings and secrets untouched',async()=>{
  const x=setup({endpoint:'https://storage.example',bucket:'test-bucket'});add(x);
  row('Access Key ID').change!('placeholder-id');row('Secret Access Key').change!('placeholder-key');
  expect(row('Secret Access Key').input!.type).toBe('password');button('测试连接').click();
  await vi.waitFor(()=>expect(document.querySelector('.pictether-credential-feedback .is-ok')).not.toBeNull());
  expect(x.check).toHaveBeenCalledOnce();expect(x.storage.setSecret).not.toHaveBeenCalled();
  button('取消').click();expect(x.state.snapshot().settings.credentials).toEqual([]);expect(x.persisted).toEqual([]);
  expect(x.destroy).toHaveBeenCalledOnce();expect(document.querySelector('.modal')).toBeNull();
});
it('saves a tested credential once, displays only masks and invalidates green status when endpoint changes',async()=>{
  const x=setup({endpoint:'https://storage.example',bucket:'test-bucket'});add(x);
  row('名称').change!('工作备份');row('Access Key ID').change!('placeholder-id');row('Secret Access Key').change!('placeholder-key');button('测试连接').click();
  await vi.waitFor(()=>expect(document.querySelector('.pictether-credential-feedback .is-ok')).not.toBeNull());
  button('保存').click();button('保存').click();
  await vi.waitFor(()=>expect(x.state.snapshot().settings.credentials).toHaveLength(1));
  await vi.waitFor(()=>expect(document.querySelector('.modal')).toBeNull());
  expect(x.storage.setSecret).toHaveBeenCalledTimes(2);expect(x.tab.containerEl.textContent).toContain('工作备份');
  expect(x.tab.containerEl.textContent).not.toMatch(/placeholder-id|placeholder-key/);expect(JSON.stringify(x.persisted)).not.toContain('placeholder-key');
  const settings=x.state.snapshot().settings;expect(profileStatus(settings,settings.credentials[0]!)).toBe('ok');
  expect(profileStatus({...settings,endpoint:'https://other.example'},settings.credentials[0]!)).toBe('untested');
});
it('retains a failed test as red only after saving and does not print raw error messages',async()=>{
  const x=setup({endpoint:'https://storage.example',bucket:'test-bucket'});x.check.mockRejectedValue({name:'AccessDenied',message:'raw-secret-marker'} as never);add(x);
  row('Access Key ID').change!('placeholder-id');row('Secret Access Key').change!('placeholder-key');button('测试连接').click();
  await vi.waitFor(()=>expect(document.querySelector('.pictether-credential-feedback .is-error')).not.toBeNull());
  expect(document.body.textContent).not.toContain('raw-secret-marker');button('保存').click();
  await vi.waitFor(()=>expect(x.state.snapshot().settings.credentials[0]?.test?.status).toBe('error'));
});
it('requires confirmation before deleting a credential or resetting',async()=>{
  const profile={id:'one',name:'现有 RK',accessKeySecret:'external-id',secretKeySecret:'external-key'};
  const x=setup({credentials:[profile],activeCredential:'one',accessKeySecret:profile.accessKeySecret,secretKeySecret:profile.secretKeySecret});
  expect(x.tab.containerEl.querySelector('.pictether-rk-info')!.tagName).toBe('DIV');
  expect(x.tab.containerEl.textContent).not.toContain('删除');
  expect(x.tab.containerEl.querySelector<HTMLElement>('[aria-label="新增 RK"]')!.dataset.icon).toBe('plus');
  action(x,'删除');expect(ui.menu.map(item=>item.title)).toEqual(['编辑','删除']);
  expect(x.callbacks.removeCredential).not.toHaveBeenCalled();button('取消').click();
  expect(x.state.snapshot().settings.credentials).toHaveLength(1);
  button('重置').click();expect(x.callbacks.reset).not.toHaveBeenCalled();
  await vi.waitFor(()=>expect(document.body.textContent).toContain('12 个附件'));
  expect(button('删除本地附件并重置').disabled).toBe(true);
  const ack=document.querySelector<HTMLInputElement>('.pictether-reset-ack input')!;ack.checked=true;ack.dispatchEvent(new Event('change'));
  button('删除本地附件并重置').click();
  await vi.waitFor(()=>expect(x.callbacks.reset).toHaveBeenCalledOnce());
});
it('has one automatic backup toggle and applies it through the runtime callback',async()=>{
  const x=setup();await row('自动备份').toggle!(true);
  expect(x.state.snapshot().settings.autoBackup).toBe(true);expect(x.callbacks.apply).toHaveBeenCalledOnce();
});
it('clears modal drafts on settings close and rejects saved test results for changed connection identities',()=>{
  const profile={id:'one',name:'RK',accessKeySecret:'id-ref',secretKeySecret:'key-ref'};
  const x=setup({credentials:[profile],activeCredential:'one'});x.entries.set('id-ref','placeholder-id');x.entries.set('key-ref','placeholder-key');
  action(x,'编辑');
  const input=row('Secret Access Key').input!;input.value='transient-value';x.tab.hide();expect(input.value).toBe('');
  const settings=x.state.snapshot().settings,tested={...profile,test:{status:'ok' as const,checkedAt:Date.now(),fingerprint:credentialFingerprint(settings,profile)}};
  expect(profileStatus(settings,tested)).toBe('ok');expect(profileStatus({...settings,bucket:'changed'},tested)).toBe('untested');
});
