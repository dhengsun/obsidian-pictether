import { expect, it, vi } from 'vitest';
import { readFile, mkdtemp, writeFile, mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { StateField } from '@codemirror/state';
import { DEFAULT_SETTINGS, StateStore, type Settings } from '../src/core/state';
import type { SqliteJobStore } from '../src/core/job-store';
import type { LocalResetPlan } from '../src/core/reset';
import type { CredentialsManager } from '../src/obsidian/credentials';

it.each([true,false])('loads the shipped CommonJS bundle and preserves local commands when SQLite runtime is available=%s', async available => {
  const commands: { id: string }[] = [];
  const extensions: unknown[] = [];
  const cleanups: (() => void)[] = [];
  const notices:string[]=[];
  const directory = await mkdtemp(path.join(os.tmpdir(),'pictether-loader-'));
  const legacy = {version:1,settings:{...DEFAULT_SETTINGS,namespace:'test-vault'},jobs:[]};
  await writeFile(path.join(directory,'data.json'),JSON.stringify(legacy));
  let saved:unknown;
  class FileSystemAdapter { getBasePath() { return directory; } }
  const secrets=new Map<string,string>([['unrelated-entry','unrelated-value']]);
  const setSecret=vi.fn((name:string,value:string)=>{secrets.set(name,value);});
  const app = {
    secretStorage:{setSecret,getSecret:(name:string)=>secrets.get(name)??null,listSecrets:()=>[...secrets.keys()]},
    vault: { adapter: new FileSystemAdapter(), getName: () => 'test-vault' },
    workspace: { on: () => ({}), onLayoutReady: () => {} }
  };
  class Plugin {
    app = app;
    manifest = {id:'pictether',dir:'.'};
    async loadData() { return legacy; }
    async saveData(data: unknown) { saved=data; await writeFile(path.join(directory,'data.json'),JSON.stringify(data)); }
    addSettingTab(_tab: unknown) {}
    registerMarkdownPostProcessor(_processor: unknown) {}
    registerEditorExtension(extension: unknown) { extensions.push(extension); }
    registerEvent(_event: unknown) {}
    register(cleanup: () => void) { cleanups.push(cleanup); }
    addCommand(command: { id: string }) { commands.push(command); }
  }
  const api = {
    Plugin, FileSystemAdapter,
    PluginSettingTab: class {}, MarkdownRenderChild: class {},
    MarkdownView: class {}, Modal: class {}, Notice: class {constructor(message:string){notices.push(message);}},
    editorInfoField: StateField.define({ create: () => undefined, update: value => value }),
    editorLivePreviewField: StateField.define({ create: () => true, update: value => value })
  };
  const nodeRequire = createRequire(import.meta.url);
  const load = (id: string) => {
    if(id==='node:worker_threads')throw new Error('Node workers unavailable in renderer');
    if(id==='node:sqlite'&&!available)throw Object.assign(new Error('unavailable builtin'),{code:'ERR_UNKNOWN_BUILTIN_MODULE'});
    return id==='obsidian'?api:nodeRequire(id);
  };
  const module = { exports: {} as { default: new () => { onload(): Promise<void>; onunload(): void } } };
  // The host exposes require('obsidian'), not a package resolvable by Node's ESM importer.
  const wrapper = new Script(`(function(require, module, exports) {\n${await readFile(new URL('../main.js', import.meta.url), 'utf8')}\n})`, { filename: 'plugin:pictether' });
  wrapper.runInThisContext()(load, module, module.exports);
  const plugin = new module.exports.default();
  await plugin.onload();
  expect(commands.map(command => command.id)).toEqual([
    'insert-attachment', 'restore-missing-attachments', 'export-note-with-attachments'
  ]);
  expect(extensions).toHaveLength(2);
  if (available) expect(saved).toEqual({version:2,settings:legacy.settings});
  else { expect(saved).toBeUndefined(); expect(JSON.parse(await readFile(path.join(directory,'data.json'),'utf8'))).toEqual(legacy); }
  const runtime=plugin as unknown as {
    state:StateStore;
    config:Settings;
    cloud?:{checkConnection():Promise<void>;destroy():void};
    queue?:{stop():Promise<void>};
    requireCloud():void;
    jobs:SqliteJobStore;
    credentials:CredentialsManager;
    reviewReset():Promise<LocalResetPlan>;
    resetPlugin(review:LocalResetPlan):Promise<void>;
    installSettings():void;
    updateSettings(change:(settings:Settings)=>void):Promise<void>;
    autoSync():Promise<void>;
    importAttachments(files:File[],insertion:{insert(text:string):void;cancel():void}):Promise<void>;
    reportFailure(error:unknown):void;
  };
  if(available){
    const check=vi.fn(async()=>{});
    runtime.cloud={checkConnection:check,destroy:()=>{}};runtime.queue={stop:async()=>{}};
    expect(()=>runtime.requireCloud()).not.toThrow();
    await runtime.state.update(state=>{state.settings.bucket='changed-target';});
    expect(()=>runtime.requireCloud()).toThrow('重新加载');
    expect(check).not.toHaveBeenCalled();
    await runtime.state.update(state=>{state.settings.accessKeySecret=state.settings.secretKeySecret='shared-reference';});
    runtime.config=runtime.state.snapshot().settings;
    expect(()=>runtime.requireCloud()).toThrow('同一个凭据条目');
    expect(check).not.toHaveBeenCalled();
    const assetRoot=await mkdtemp(path.join(os.tmpdir(),'pictether-reset-assets-'));
    const claimFile=path.join(assetRoot,'.pictether/namespaces/test-vault.json');
    await mkdir(path.dirname(claimFile),{recursive:true});
    const locked=JSON.stringify({owner:'another-vault'});await writeFile(claimFile,locked);
    await runtime.state.update(state=>{Object.assign(state.settings,{assetsRoot:assetRoot,accessKeySecret:'',secretKeySecret:'',autoBackup:true});});
    runtime.installSettings();
    const sync=vi.fn(async()=>{});
    runtime.queue={stop:async()=>{},sync} as typeof runtime.queue;
    notices.length=0;
    await runtime.autoSync();expect(sync).toHaveBeenCalledOnce();
    expect(notices).toEqual([]);expect(await readFile(claimFile,'utf8')).toBe(locked);
    await runtime.updateSettings(settings=>{settings.autoBackup=false;});
    const insertion={insert:vi.fn(),cancel:vi.fn()};
    // A rejected attachment import never starts cloud discovery/sync.
    const automatic=vi.spyOn(runtime,'autoSync');automatic.mockClear();
    await runtime.importAttachments([{name:'example.png',stream(){throw new Error('invalid test source');}} as unknown as File],insertion);
    expect(automatic).not.toHaveBeenCalled();automatic.mockRestore();
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=','base64');
    await runtime.importAttachments([Object.assign(new Blob([png]),{name:'sample.png'}) as File],insertion);
    expect(insertion.insert).toHaveBeenCalledWith(expect.stringContaining('mdasset://test-vault/'));
    const attachmentKey='test-vault/2026-10-30/120000-abcdef.png',attachment=path.join(assetRoot,attachmentKey);
    await mkdir(path.dirname(attachment),{recursive:true});await writeFile(attachment,'preserved attachment');
    const note=path.join(directory,'note.md');await writeFile(note,`![kept](mdasset://${attachmentKey})`);
    await runtime.state.update(state=>{state.settings.assetsRoot=assetRoot;});
    await runtime.jobs.enqueue(assetRoot,attachmentKey,'a'.repeat(64));await runtime.jobs.complete((await runtime.jobs.get(assetRoot,attachmentKey))!,'target');
    await runtime.credentials.save({name:'test',accessKeyId:'placeholder-id',secretAccessKey:'placeholder-key'});
    const pair=runtime.state.snapshot().settings.credentials[0]!;
    const staleReview=await runtime.reviewReset();
    await writeFile(path.join(path.dirname(attachment),'120002-abcdef.png'),'new attachment');
    await expect(runtime.resetPlugin(staleReview)).rejects.toThrow('范围已变化');
    expect(runtime.state.snapshot().settings.resetPending).toBe(false);
    expect(await readFile(attachment,'utf8')).toBe('preserved attachment');expect((await runtime.jobs.counts()).done).toBe(1);
    let release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    runtime.queue={stop:async()=>{entered();await gate;}};
    const review=await runtime.reviewReset();
    const resetting=runtime.resetPlugin(review);await started;
    expect((await runtime.jobs.counts()).done).toBe(1);expect(secrets.get(pair.secretKeySecret)).toBe('placeholder-key');
    release();await resetting;
    await expect(readFile(attachment,'utf8')).rejects.toMatchObject({code:'ENOENT'});await expect(readFile(claimFile,'utf8')).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(note,'utf8')).toContain('mdasset://');
    expect(await runtime.jobs.counts()).toEqual({pending:0,done:0,conflict:0});expect((await runtime.jobs.daily(assetRoot,'target')).attempts).toBe(0);
    expect(secrets.get(pair.secretKeySecret)).toBe('');expect(secrets.get('unrelated-entry')).toBe('unrelated-value');
    expect(runtime.state.snapshot().settings.credentials).toEqual([]);expect(runtime.state.snapshot().settings.autoBackup).toBe(false);
    expect((await readdir(directory)).some(name=>/^data-v1\./.test(name))).toBe(false);
    // A failed cleanup leaves a durable retry marker and blocks cloud work.
    await runtime.state.update(state=>{state.settings.assetsRoot=assetRoot;});runtime.installSettings();
    await runtime.credentials.save({name:'retry',accessKeyId:'placeholder-id',secretAccessKey:'placeholder-key'});
    const original=setSecret.getMockImplementation()!;let fail=true;
    setSecret.mockImplementation((name,value)=>{if(fail&&value===''){fail=false;throw new Error('sensitive-marker');}original(name,value);});
    await expect(runtime.resetPlugin(await runtime.reviewReset())).rejects.toThrow('重置未完成');
    expect(runtime.state.snapshot().settings.resetPending).toBe(true);expect(()=>runtime.requireCloud()).toThrow('重置');
    expect(runtime.state.snapshot().settings.assetsRoot).toBe(assetRoot);
    expect(JSON.parse(await readFile(path.join(directory,'data.json'),'utf8')).settings.resetPending).toBe(true);
    setSecret.mockImplementation(original);await runtime.resetPlugin(await runtime.reviewReset());expect(runtime.state.snapshot().settings.resetPending).toBe(false);
  }else expect(()=>runtime.requireCloud()).toThrow('SQLite');
  plugin.onunload();
  for (const cleanup of cleanups.reverse()) cleanup();
});
