import {describe,expect,it,vi} from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {identifyAsset} from '../src/core/assets';
import {AssetStorage,bufferSource,ByteSource,CheckedAsset} from '../src/core/storage';
import {attachmentMarkdown,parseReference,referenceFromKey} from '../src/core/references';
import {findMarkdownAssets} from '../src/core/markdown';
import {exportNote} from '../src/core/export';
import {AssetRecovery,BackupQueue} from '../src/core/backup';
import {CloudBackup,RemoteSource} from '../src/core/r2';
import {initialState, DEFAULT_SETTINGS} from '../src/core/state';
import {testJobs,allJobs} from './job-fixtures';
import {openSystemAsset} from '../src/obsidian/system-opener';
import {SVG,PDF,MP4,MOV,WEBM,MKV,OGV} from './media-fixtures';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const key=(extension:string)=>`vault/2026-10-28/120000-abcdef.${extension}`;
const temporary=()=>fs.mkdtemp(path.join(os.tmpdir(),'pictether-media-'));
const samples=[['svg',SVG,'image'],['pdf',PDF,'pdf'],['mp4',MP4,'video'],['mov',MOV,'video'],['webm',WEBM,'video'],['mkv',MKV,'video'],['ogv',OGV,'video']] as const;
describe('attachment protocol and format policy',()=>{
  it.each(samples)('identifies %s contents and allocates mdasset references',async(extension,bytes,kind)=>{
    expect(identifyAsset(bytes)).toMatchObject({extension,kind});
    const storage=new AssetStorage(await temporary());
    const ref=await storage.importSource('vault',bufferSource(bytes),`wrong-name.png`);
    expect(referenceFromKey(ref.key)).toMatch(new RegExp(`^mdasset://vault/\\d{4}-\\d{2}-\\d{2}/\\d{6}-[a-f0-9]{6}\\.${extension}$`));
    expect(await storage.read(ref.key)).toEqual(bytes);
  });
  it('does not parse or discover removed mdimg references',()=>{
    const old=`mdimg://${key('png')}`;
    expect(()=>parseReference(old)).toThrow();
    expect(findMarkdownAssets(`![old](${old})`)).toEqual([]);
  });
  it('rejects malformed SVG, unsafe XML declarations and mismatched extensions',async()=>{
    expect(()=>identifyAsset(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>'))).toThrow();
    expect(()=>identifyAsset(Buffer.from('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>'))).toThrow();
    const storage=new AssetStorage(await temporary());
    await expect(storage.write(key('pdf'),SVG)).rejects.toThrow('does not match');
  });
});
describe('streaming storage and portable export',()=>{
  it('imports, hashes and copies a large source in bounded chunks',async()=>{
    const storage=new AssetStorage(await temporary());
    const part=Buffer.alloc(64*1024,7),expected=createHash('sha256');expected.update(MP4);
    for(let i=0;i<96;i++)expected.update(part);
    const source:ByteSource={async *[Symbol.asyncIterator](){yield MP4;for(let i=0;i<96;i++)yield part;}};
    let journalHash='';
    const ref=await storage.importSource('vault',source,'video.mp4',async(_ref,asset)=>{journalHash=asset.sha256;});
    const actual=await storage.inspect(ref.key);
    expect(actual.sha256).toBe(expected.digest('hex'));expect(journalHash).toBe(actual.sha256);
    expect(actual.size).toBe(MP4.length+96*part.length);
    for await(const chunk of storage.stream(ref.key))expect(chunk.byteLength).toBeLessThanOrEqual(64*1024);
    const target=path.join(await temporary(),'copy.mp4');await storage.copyTo(ref.key,target);
    expect((await fs.stat(target)).size).toBe(actual.size);
  });
  it('does not publish interrupted, wrong-hash or wrong-length sources',async()=>{
    const storage=new AssetStorage(await temporary());
    const interrupted:ByteSource={async *[Symbol.asyncIterator](){yield MP4;throw new Error('stream interrupted');}};
    await expect(storage.writeSource(key('mp4'),interrupted)).rejects.toThrow('interrupted');
    await expect(storage.writeSource(key('mp4'),bufferSource(MP4),'0'.repeat(64))).rejects.toThrow('checksum');
    await expect(storage.writeSource(key('mp4'),bufferSource(MP4),hash(MP4),MP4.length+1)).rejects.toThrow('length');
    await expect(storage.describe(key('mp4'))).rejects.toMatchObject({code:'ENOENT'});
  });
  it('keeps images embedded and exports video/PDF as standard links, including reference-style embeds',async()=>{
    const root=await temporary(),storage=new AssetStorage(root);
    await storage.write(key('svg'),SVG);await storage.write(key('pdf'),PDF);await storage.write(key('mp4'),MP4);
    const uri=(ext:string)=>referenceFromKey(key(ext));
    const input=`# Note\n![vector](${uri('svg')})\n![video](${uri('mp4')} "title")\n![document][pdf]\n[direct](${uri('pdf')})\n\n[pdf]: ${uri('pdf')}\n\n\`![example](${uri('mp4')})\`\n`;
    const read=vi.spyOn(storage,'read').mockRejectedValue(new Error('Full-file read must not be used by export.'));
    const output=await exportNote(input,'note.md',root,storage),markdown=await fs.readFile(path.join(output,'note.md'),'utf8');
    expect(markdown).toContain('![vector](assets/120000-abcdef.svg)');
    expect(markdown).toContain('[video](assets/120000-abcdef.mp4 "title")');
    expect(markdown).toContain('[document][pdf]');expect(markdown).toContain('[pdf]: assets/120000-abcdef.pdf');
    expect(markdown).toContain(`[example](${uri('mp4')})`);expect(read).not.toHaveBeenCalled();
    expect(await fs.readdir(path.join(output,'assets'))).toHaveLength(3);
  });
});
class StreamingCloud implements CloudBackup{
  target='test-bucket';objects=new Map<string,Buffer>();reads=0;writes=0;
  async get():Promise<never>{throw new Error('Buffer API must not be used.');}
  async putIfAbsent():Promise<never>{throw new Error('Buffer API must not be used.');}
  async getSource(key:string):Promise<RemoteSource|null>{this.reads++;const bytes=this.objects.get(key);return bytes?{body:bufferSource(bytes),sha256:hash(bytes),size:bytes.length}:null;}
  async putSourceIfAbsent(key:string,_asset:CheckedAsset,source:ByteSource):Promise<void>{this.writes++;const chunks:Buffer[]=[];for await(const chunk of source)chunks.push(Buffer.from(chunk));if(!this.objects.has(key))this.objects.set(key,Buffer.concat(chunks));}
}
describe('streaming cloud path',()=>{
  it('backs up and coalesces recovery of non-image attachments without buffer APIs',async()=>{
    const storage=new AssetStorage(await temporary()),state=await testJobs(),cloud=new StreamingCloud();
    const ref=await storage.importSource('vault',bufferSource(PDF),'note.pdf',async(ref,asset)=>BackupQueue.enqueueHash(state,storage.root,ref.key,asset.sha256,true));
    await new BackupQueue(state,cloud).sync(true);
    expect((await allJobs(state))[0]?.status).toBe('done');expect(cloud.writes).toBe(1);
    const destination=new AssetStorage(await temporary()),recovery=new AssetRecovery(destination,cloud,()=>hash(PDF));
    const before=cloud.reads;
    await Promise.all([recovery.ensureLocal(ref.key,true),recovery.ensureLocal(ref.key,true)]);
    expect(cloud.reads-before).toBe(1);expect(await destination.read(ref.key)).toEqual(PDF);
  });
  it('does not publish a downloaded object whose declared size is wrong',async()=>{
    const storage=new AssetStorage(await temporary()),cloud=new StreamingCloud();
    cloud.getSource=async()=>({body:bufferSource(PDF),sha256:hash(PDF),size:PDF.length+1});
    await expect(new AssetRecovery(storage,cloud).ensureLocal(key('pdf'),true)).rejects.toThrow('length');
    await expect(storage.describe(key('pdf'))).rejects.toMatchObject({code:'ENOENT'});
  });
});


describe('clearing backup records',()=>{
  it('clears every status in the selected root, preserves other roots and attachment bytes, and persists',async()=>{
    const root=await temporary(),storage=new AssetStorage(root);await storage.write(key('pdf'),PDF);
    const state=await testJobs();
    for(const ext of ['pdf','mp4','md'])await BackupQueue.enqueueHash(state,root,key(ext),hash(PDF));
    await BackupQueue.enqueueHash(state,root+'-other',key('pdf'),hash(PDF));
    const rows=await allJobs(state);await state.complete(rows[1]!, 'test');await state.fail(rows[2]!, 'test',true,'conflict');
    expect(await BackupQueue.clearRecords(state,root)).toBe(3);
    expect((await allJobs(state)).map(job=>job.root)).toEqual([root+'-other']);
    expect(await storage.read(key('pdf'))).toEqual(PDF);
  });
  it('waits for an active upload, holds new syncs and preserves new import intents',async()=>{
    const root=await temporary(),storage=new AssetStorage(root),state=await testJobs(),cloud=new StreamingCloud();
    await storage.write(key('pdf'),PDF);await BackupQueue.enqueueHash(state,root,key('pdf'),hash(PDF));
    let release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    const original=cloud.putSourceIfAbsent.bind(cloud);
    cloud.putSourceIfAbsent=async(...args)=>{entered();await gate;await original(...args);};
    const queue=new BackupQueue(state,cloud),upload=queue.sync();await started;
    const clearing=queue.clearRecords(root);
    await storage.write(key('mp4'),MP4);await BackupQueue.enqueueHash(state,root,key('mp4'),hash(MP4));
    const nextSync=queue.sync();
    expect((await allJobs(state))).toHaveLength(2);
    release();await upload;expect(await clearing).toBe(1);await nextSync;
    expect((await allJobs(state)).map(job=>job.key)).toEqual([key('mp4')]);
    expect((await allJobs(state))[0]!.status).toBe('done');
    expect(cloud.objects.get(key('pdf'))).toEqual(PDF);
  });
  it('preserves records when persistence fails',async()=>{
    const databasePath=path.join(await temporary(),'jobs.sqlite'),state=await testJobs(databasePath);
    await BackupQueue.enqueueHash(state,'/assets',key('pdf'),hash(PDF));const before=await allJobs(state);
    await state.close();
    await expect(BackupQueue.clearRecords(state,'/assets')).rejects.toThrow();
    const reopened=await testJobs(databasePath);expect(await allJobs(reopened)).toEqual(before);
  });
});


describe('system default application opening',()=>{
  it('passes only a revalidated local path and reports OS file association errors',async()=>{
    const root=await temporary(),storage=new AssetStorage(root);await storage.write(key('pdf'),PDF);
    const open=vi.fn(async()=> '');await openSystemAsset(storage,key('pdf'),open);
    expect(open).toHaveBeenCalledWith(path.join(await fs.realpath(root),key('pdf')));
    await expect(openSystemAsset(storage,key('pdf'),async()=> 'No app')).rejects.toThrow('default application');
  });
  it('rejects a symlink or missing attachment before invoking the system opener',async()=>{
    const root=await temporary(),storage=new AssetStorage(root);await storage.write(key('md'),Buffer.from('# Note'));
    await fs.symlink(path.join(root,key('md')),path.join(root,key('pdf')));
    const open=vi.fn(async()=> '');await expect(openSystemAsset(storage,key('pdf'),open)).rejects.toThrow('Symlink');
    await expect(openSystemAsset(storage,key('png'),open)).rejects.toMatchObject({code:'ENOENT'});
    expect(open).not.toHaveBeenCalled();
  });
  it('retains ordinary links only for existing Markdown records and embeds managed images',()=>{
    expect(attachmentMarkdown(key('md'),'readme.md').startsWith('!')).toBe(false);
    expect(attachmentMarkdown(key('png')).startsWith('![')).toBe(true);
  });
});


it('declines new Markdown imports without writing, while keeping existing MD records readable',async()=>{
  const root=await temporary(),storage=new AssetStorage(root),bytes=Buffer.from('# Existing Markdown');
  await expect(storage.importSource('vault',bufferSource(bytes),'README.MD')).rejects.toThrow('handled by Obsidian');
  expect(await fs.readdir(root)).toEqual([]);
  await storage.write(key('md'),bytes);
  const state=await testJobs();await BackupQueue.enqueueHash(state,root,key('md'),hash(bytes));
  expect(initialState({version:1,settings:{...DEFAULT_SETTINGS},jobs:await allJobs(state)}).jobs[0]!.key).toBe(key('md'));
  expect(await storage.read(key('md'))).toEqual(bytes);
});


it('leaves JSON imports to Obsidian and rejects managed JSON references without writing files',async()=>{
  const root=await temporary(),storage=new AssetStorage(root);
  await expect(storage.importSource('vault',bufferSource(Buffer.from('{}')),'settings.json')).rejects.toThrow('handled by Obsidian');
  expect(await fs.readdir(root)).toEqual([]);
  expect(()=>referenceFromKey(key('json'))).toThrow();
  expect(findMarkdownAssets(`![old](mdasset://${key('json')})`)).toEqual([]);
});
