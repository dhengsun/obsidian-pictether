import { FileSystemAdapter, MarkdownView, Modal, Notice, Plugin, Setting } from 'obsidian';
import path from 'node:path';
import { AssetStorage, blobSource } from './core/storage';
import { attachmentMarkdown, defaultNamespace, parseReference, referenceFromKey } from './core/references';
import { DEFAULT_SETTINGS, settingsState, Settings, StateStore } from './core/state';
import { SqliteJobStore } from './core/job-store';
import { BackupQueue, AssetRecovery } from './core/backup';
import { CloudConfigurationError, R2Backup, cloudFailureMessage, validateR2SecretReferences } from './core/r2';
import { findMarkdownAssets } from './core/markdown';
import { exportNote } from './core/export';
import { AssetResources, registerRendering } from './obsidian/rendering';
import { mountAsset } from './obsidian/media-renderer';
import { ImportAnchors, Insertion, selectImages, supportedFile } from './obsidian/importing';
import { openSystemAsset } from './obsidian/system-opener';
import { PictetherSettings } from './obsidian/settings';
import { CredentialsManager } from './obsidian/credentials';
import { clearStateBackups, clearLocalAttachments, scanLocalReset, LocalResetError, type LocalResetPlan } from './core/reset';

export default class PictetherPlugin extends Plugin {
  private state!: StateStore;
  private jobs?: SqliteJobStore;
  private config!: Settings;
  private storage!: AssetStorage;
  private queue?: BackupQueue;
  private recovery?: AssetRecovery;
  private anchors!: ImportAnchors;
  private disposed = false;
  private cloud?: R2Backup;
  private importTasks = new Set<Promise<void>>();
  private credentials!:CredentialsManager;
  private changing=false;
  private mutationTail:Promise<unknown>=Promise.resolve();
  private autoTask?:Promise<void>;
  private autoDiscovered=false;
  private cloudTasks=new Set<Promise<void>>();
  private pluginDirectory='';
  private vaultDirectory='';
  async onload(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error('Pictether requires a desktop filesystem vault.');
    this.vaultDirectory=adapter.getBasePath();
    const raw = await this.loadData();
    const settings = settingsState(raw);
    const directory = path.resolve(adapter.getBasePath(), this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`);
    this.pluginDirectory=directory;
    try {
      this.jobs = await SqliteJobStore.open(path.join(directory,'pictether.sqlite'),path.join(directory,'data.json'),raw?.version);
    } catch (error) {
      const detail = error instanceof Error && /^SQLite/.test(error.message) ? error.message : 'SQLite startup failed.';
      new Notice(`Pictether: ${detail} Node ${process.versions.node}; Electron ${process.versions.electron ?? 'none'}. Local attachments and original records are preserved.`,20000);
    }
    this.state = new StateStore(settings, state => {
      if (!this.jobs) return Promise.reject(new Error('SQLite unavailable. Original settings/records are preserved; fix database support before saving settings.'));
      return this.saveData(state);
    });
    if (this.jobs) {
      try {
        if (!settings.settings.namespace) await this.state.update(state => { state.settings.namespace = defaultNamespace(this.app.vault.getName()); });
        else if (raw?.version !== 2||!Array.isArray(raw?.settings?.credentials)) await this.state.update(() => {});
      } catch { new Notice('Pictether: SQLite records are safe, but settings could not be saved. Original JSON was preserved; retry after fixing disk permissions.',15000); }
    }
    this.config = { ...DEFAULT_SETTINGS, ...this.state.snapshot().settings };
    if (!this.config.namespace) this.config.namespace = defaultNamespace(this.app.vault.getName());
    this.storage = new AssetStorage(this.config.assetsRoot);
    this.credentials=new CredentialsManager(this.state,this.app.secretStorage);
    if(this.state.snapshot().settings.retiredSecrets.length)this.background(()=>this.credentials.cleanupRetired());
    const settingsTab=new PictetherSettings(this.app, this, this.state, this.jobs, {
      credentials:this.credentials,apply:()=>this.applySettings(),removeCredential:id=>this.mutateConnection(()=>this.credentials.remove(id)),
      update:change=>this.updateSettings(change),
      restore:()=>this.restoreMissing(),reviewReset:()=>this.reviewReset(),reset:review=>this.resetPlugin(review)
    });
    this.addSettingTab(settingsTab);this.register(()=>settingsTab.hide());
    this.configureCloud();
    const resources: AssetResources = new AssetResources(async uri => {
      const key = parseReference(uri).key;
      const storage=this.storage,recovery=this.recovery;
      const local = !this.changing&&!this.state.snapshot().settings.resetPending&&recovery ? await recovery.ensureLocal(key,true) : await storage.describe(key);
      // Only a verified managed path reaches the public desktop resource API.
      const relative=path.relative(adapter.getBasePath(),local.path).split(path.sep).join('/');
      return {url:adapter.getResourcePath(relative),format:local.format,open:()=>openSystemAsset(storage,key)};
    }, (url, alt, uri) => {
      new class extends Modal {
        private release = () => {};
        onOpen(): void {
          this.modalEl.addClass('pictether-preview-modal');
          if (uri) this.release = mountAsset(this.contentEl, uri, alt, resources);
          else this.contentEl.createEl('img', { attr: { src: url, alt }, cls: 'pictether-preview' });
        }
        onClose(): void { this.release();this.contentEl.empty(); }
      }(this.app).open();
    });
    registerRendering(this, resources);
    this.register(() => resources.dispose());
    this.anchors = new ImportAnchors(this);
    this.registerEvent(this.app.workspace.on('editor-paste', (event, editor) => {
      if (event.defaultPrevented || !event.clipboardData) return;
      const files = Array.from(event.clipboardData.files);
      // Mixed/text clipboard data stays with the native text handler.
      if (!files.length || !files.every(supportedFile) || event.clipboardData.getData('text/plain')) return;
      let insertion: Insertion;
      try { insertion = this.anchors.capture(editor); } catch { return; }
      event.preventDefault();
      this.startImport(files, insertion);
    }));
    this.registerEvent(this.app.workspace.on('editor-drop', (event, editor) => {
      if (event.defaultPrevented || !event.dataTransfer) return;
      const files = Array.from(event.dataTransfer.files);
      if (!files.length || !files.every(supportedFile)) return;
      let insertion: Insertion;
      try { insertion = this.anchors.capture(editor, { x: event.clientX, y: event.clientY }); } catch { return; }
      event.preventDefault();
      this.startImport(files, insertion);
    }));
    this.addCommand({ id: 'insert-attachment', name: 'Insert Attachment', editorCallback: (editor, view) => {
      try {
        const insertion = this.anchors.capture(editor);
        selectImages(view instanceof MarkdownView ? view.containerEl.ownerDocument : document, files => this.startImport(files, insertion), () => insertion.cancel());
      } catch { new Notice('Pictether: Open a Markdown editor to insert attachments.'); }
    } });
    this.addCommand({ id: 'restore-missing-attachments', name: 'Restore Missing Attachments', callback: () => this.background(() => this.restoreMissing()) });
    this.addCommand({ id: 'export-note-with-attachments', name: 'Export Note with Attachments', checkCallback: checking => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view?.file) return false;
      if (!checking) {
        const markdown = view.getViewData(), name = view.file.name;
        this.askExportDirectory(markdown, name);
      }
      return true;
    } });
    const timer=setInterval(()=>this.background(()=>this.autoSync()),30_000);this.register(()=>clearInterval(timer));
    this.app.workspace.onLayoutReady(() => {if(!this.disposed)this.background(()=>this.autoSync());});
  }
  private configureCloud(): void {
    const s = this.config;
    if (s.resetPending||!s.activeCredential||!this.jobs || !s.endpoint || !s.bucket || !s.accessKeySecret || !s.secretKeySecret) return;
    try {
      validateR2SecretReferences(s.accessKeySecret,s.secretKeySecret);
      const access = this.app.secretStorage?.getSecret(s.accessKeySecret), secret = this.app.secretStorage?.getSecret(s.secretKeySecret);
      if (!access || !secret) { new Notice('Pictether: OSS 凭据不可用，请编辑 RK 重新填写。'); return; }
      this.cloud = new R2Backup(s.endpoint, s.bucket, access, secret,s.region);
      this.queue = new BackupQueue(this.jobs, this.cloud, undefined, s.assetsRoot);
      this.recovery = new AssetRecovery(this.storage, this.cloud, async key => (await this.jobs!.get(s.assetsRoot,key))?.sha256);
    } catch(error) { new Notice(`Pictether: OSS 初始化失败：${cloudFailureMessage(error)}`,15000); }
  }
  private async quiesce():Promise<void>{
    const results=await Promise.allSettled([this.queue?.stop(),this.recovery?.stop(),this.autoTask,this.credentials.idle(),...this.importTasks,...this.cloudTasks]);
    const failure=results.find(result=>result.status==='rejected');
    if(failure?.status==='rejected')throw failure.reason;
  }
  private installSettings():void {
    this.cloud?.destroy();this.cloud=undefined;this.queue=undefined;this.recovery=undefined;
    this.config=this.state.snapshot().settings;this.storage=new AssetStorage(this.config.assetsRoot);this.autoDiscovered=false;
    this.configureCloud();
  }
  private mutateConnection(work:()=>Promise<void>):Promise<void>{
    const task=this.mutationTail.then(async()=>{
      if(this.disposed)throw new CloudConfigurationError('插件已停用。');
      this.changing=true;this.credentials.pause();
      try{await this.quiesce();await work();}
      finally{
        this.installSettings();this.changing=false;
        if(!this.config.resetPending)this.credentials.resume();
      }
    });
    this.mutationTail=task.catch(()=>{});
    return task.then(()=>{this.background(()=>this.autoSync());});
  }
  private applySettings():Promise<void>{return this.mutateConnection(async()=>{
    if(this.state.snapshot().settings.resetPending)throw new CloudConfigurationError('请先完成重置。');
  });}
  private updateSettings(change:(settings:Settings)=>void):Promise<void>{
    if(this.changing||this.state.snapshot().settings.resetPending)return Promise.reject(new CloudConfigurationError('配置正在切换或重置，请稍后重试。'));
    return this.mutateConnection(async()=>{
      const proposed=this.state.snapshot().settings;change(proposed);
      await this.state.update(next=>{next.settings=proposed;});
    });
  }
  private async reviewReset():Promise<LocalResetPlan>{
    try{return await scanLocalReset(this.state.snapshot().settings.assetsRoot,[this.vaultDirectory,this.pluginDirectory]);}
    catch(error){if(error instanceof LocalResetError)throw error;throw new LocalResetError('无法读取本地附件清理范围，请检查目录权限后重试。');}
  }
  private resetPlugin(review:LocalResetPlan):Promise<void>{return this.mutateConnection(async()=>{
    if(!this.jobs)throw new CloudConfigurationError('数据库不可用，重置未开始。');
    const current=await this.reviewReset();
    if(current.fingerprint!==review?.fingerprint)throw new LocalResetError('本地附件范围已变化，请重新打开重置确认框。');
    try{
      await this.state.update(next=>{next.settings.resetPending=true;next.settings.autoBackup=false;});
      const remaining=await clearLocalAttachments(current,[this.vaultDirectory,this.pluginDirectory]);
      current.unknown=remaining.unknown;
      await this.jobs.reset();
      await this.credentials.eraseManaged();
      await clearStateBackups(this.pluginDirectory);
      await this.state.update(next=>{next.settings=structuredClone(DEFAULT_SETTINGS);next.settings.namespace=defaultNamespace(this.app.vault.getName());});
    }catch(error){if(error instanceof LocalResetError)throw error;throw new CloudConfigurationError('重置未完成，部分本地附件可能已删除。笔记和云端已保留，请检查本地权限与 SecretStorage 后点击“继续重置”。');}
    new Notice(`Pictether 已重置，本地受管理附件已删除，笔记和云端已保留。${current.unknown?'目录中另有未识别项目，已保留，请人工检查。':''}`);
  });}
  private autoSync():Promise<void>{
    if(this.autoTask)return this.autoTask;
    if(this.disposed||this.changing||this.state.snapshot().settings.resetPending||!this.config.autoBackup||!this.queue||JSON.stringify(this.config)!==JSON.stringify(this.state.snapshot().settings))return Promise.resolve();
    const queue=this.queue;
    this.autoTask=(async()=>{
      if(!this.autoDiscovered){
        for await(const key of this.storage.keys(this.config.namespace)){
          if(this.disposed||this.changing)return;
          await BackupQueue.enqueueHash(this.requireRecords(),this.config.assetsRoot,key,(await this.storage.inspect(key)).sha256);
        }
        this.autoDiscovered=true;
      }
      if(!this.disposed&&!this.changing)await queue.sync();
    })().finally(()=>{this.autoTask=undefined;});
    return this.autoTask;
  }
  private startImport(files: File[], insertion: Insertion): void {
    if (this.disposed||this.changing||this.state.snapshot().settings.resetPending) { insertion.cancel();new Notice('Pictether: 配置正在切换或重置，请稍后导入。'); return; }
    const task = this.importAttachments(files, insertion);
    this.importTasks.add(task);
    void task.then(() => this.importTasks.delete(task),()=>this.importTasks.delete(task));
  }
  private async importAttachments(files: File[], insertion: Insertion): Promise<void> {
    const references: string[] = [];
    try {
      for (const file of files) {
        if (this.disposed) break;
        try {
          const ref = await this.storage.importSource(this.config.namespace,blobSource(file),file.name,async(candidate,asset)=>{
            try{return await BackupQueue.enqueueHash(this.requireRecords(),this.config.assetsRoot,candidate.key,asset.sha256,true);}
            catch{new Notice('Pictether: 附件已保留在本地，但备份记录无法保存。修复存储后自动备份会重新发现。');}
          });
          references.push(attachmentMarkdown(ref.key, 'Attachment'));
        } catch (error) { new Notice(`Pictether: Attachment import failed. ${error instanceof Error ? error.message : 'Check attachment content and directory permissions.'}`, 10_000); }
      }
      if (references.length && !this.disposed) {
        try { insertion.insert(references.join('\n') + '\n'); }
        catch { new Notice(`Pictether: Attachments saved, but the target editor changed. References:\n${references.join('\n')}`, 0); }
      }
    } catch (error) {
      new Notice(`Pictether: ${error instanceof Error ? error.message : 'Import failed.'}`, 10_000);
    }
    finally { insertion.cancel(); }
    if (!this.disposed && references.length) this.background(() => this.autoSync());
  }
  private requireCloud(): void {
    if(this.disposed)throw new CloudConfigurationError('插件已停用，请重新加载后操作。');
    if(this.changing||this.state.snapshot().settings.resetPending)throw new CloudConfigurationError('配置正在切换或重置，请稍后重试。');
    const saved=this.state.snapshot().settings;
    if(JSON.stringify(this.config)!==JSON.stringify(saved))throw new CloudConfigurationError('设置已修改，请重新加载 Pictether 后再执行云端操作。');
    validateR2SecretReferences(saved.accessKeySecret,saved.secretKeySecret);
    if(!this.jobs)throw new CloudConfigurationError('SQLite 备份记录不可用，请先修复数据库问题；本地附件仍可使用。');
    if (!this.cloud || !this.queue) throw new CloudConfigurationError('请配置 OSS 地址、存储桶并启用一组 RK。');
  }
  private requireRecords(): SqliteJobStore {
    if (!this.jobs) throw new Error('SQLite backup records unavailable.');
    return this.jobs;
  }
  private restoreMissing():Promise<void>{
    const task=this.doRestoreMissing();this.cloudTasks.add(task);
    void task.then(()=>this.cloudTasks.delete(task),()=>this.cloudTasks.delete(task));return task;
  }
  private async doRestoreMissing(): Promise<void> {
    this.requireCloud();
    const keys = new Set<string>();
    const cutoff = await this.jobs!.maximum(this.config.assetsRoot);
    let after = 0;
    for (;;) {
      const page = await this.jobs!.page(after,cutoff,128,this.config.assetsRoot);
      if (!page.length) break;
      for (const job of page) { try { referenceFromKey(job.key); keys.add(job.key); } catch { /* Archived unsupported metadata is not restored. */ } }
      after = page[page.length-1]!.seq;
    }
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.disposed||this.changing) return;
      for (const ref of findMarkdownAssets(await this.app.vault.cachedRead(file))) keys.add(ref.reference.key);
    }
    let restored = 0, failed = 0;
    for (const key of keys) {
      if (this.disposed||this.changing) return;
      try { await this.recovery!.ensureLocal(key, true); restored++; }
      catch { failed++; }
    }
    new Notice(`Pictether: ${restored} 个附件可用，${failed} 个恢复失败。重新打开笔记可刷新预览。`, 10_000);
  }
  private askExportDirectory(markdown: string, name: string): void {
    const plugin = this;
    new class extends Modal {
      onOpen(): void {
        this.contentEl.createEl('h2', { text: 'Export Note with Attachments' });
        let directory = '';
        new Setting(this.contentEl).setName('Export parent directory').setDesc('Existing absolute directory. A new unique subdirectory will be created.').addText(text => text.onChange(value => { directory = value; }));
        new Setting(this.contentEl).addButton(button => button.setButtonText('Export').setCta().onClick(() => {
          button.setDisabled(true);
          void exportNote(markdown, name, directory, plugin.storage).then(output => { new Notice(`Pictether: Exported to ${output}`, 15_000); this.close(); }, error => { button.setDisabled(false); new Notice(`Pictether: ${error instanceof Error ? error.message : 'Export failed.'}`, 10_000); });
        }));
      }
    }(this.app).open();
  }
  private background(task: () => Promise<void>): void {
    if (!this.disposed) void task().catch(error => this.reportFailure(error));
  }
  private reportFailure(error:unknown):void {
    if(this.disposed)return;
    new Notice(`Pictether: ${cloudFailureMessage(error)}`,10_000);
  }
  onunload(): void {
    this.disposed = true;
    this.credentials?.pause();
    void Promise.allSettled([this.mutationTail,this.queue?.stop(),this.recovery?.stop(),this.autoTask,this.credentials?.idle(),...this.cloudTasks,...this.importTasks]).then(async () => { this.cloud?.destroy(); await this.state?.idle(); await this.jobs?.close(); }).catch(() => {});
  }
}
