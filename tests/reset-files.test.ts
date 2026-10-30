import { expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clearStateBackups, clearLocalAttachments, scanLocalReset } from '../src/core/reset';
vi.mock('node:fs/promises',async importOriginal=>{
  const original=await importOriginal<typeof import('node:fs/promises')>();
  return {...original,unlink:vi.fn(original.unlink)};
});
const backup=`data-v1.${'a'.repeat(64)}.backup.json`;
it('removes only exact generated state-backup filenames inside the supplied plugin directory',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pictether-reset-files-'));
  const staging=`${backup}.00000000-0000-0000-0000-000000000001.staging`;
  for(const name of [backup,staging,'note.md','attachment.png','data.json','pictether.sqlite','main.js','data-v1.other.backup.json'])await fs.writeFile(path.join(directory,name),name);
  await clearStateBackups(directory);
  const remaining=await fs.readdir(directory);expect(remaining).not.toContain(backup);expect(remaining).not.toContain(staging);
  for(const name of ['note.md','attachment.png','data.json','pictether.sqlite','main.js','data-v1.other.backup.json'])expect(await fs.readFile(path.join(directory,name),'utf8')).toBe(name);
});
it('rejects a backup-shaped symlink without following or deleting its target',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pictether-reset-symlink-')),outside=await fs.mkdtemp(path.join(os.tmpdir(),'pictether-reset-target-'));
  const target=path.join(outside,'attachment.png');await fs.writeFile(target,'preserved');await fs.symlink(target,path.join(directory,backup));
  await expect(clearStateBackups(directory)).rejects.toThrow('Unsafe');expect(await fs.readFile(target,'utf8')).toBe('preserved');expect((await fs.lstat(path.join(directory,backup))).isSymbolicLink()).toBe(true);
});
async function fixture(){
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'pictether-reset-local-')));
  const root=path.join(directory,'assets'),vault=path.join(directory,'vault');
  await fs.mkdir(root);await fs.mkdir(vault);
  const put=async(key:string,value='attachment')=>{const file=path.join(root,key);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,value);return file;};
  return {root,vault,put};
}
it('deletes all recognized namespaces, retired formats and metadata while preserving unknown files, notes and the root',async()=>{
  const x=await fixture();
  const keys=['one/2026-10-30/120000-abcdef.png','two/2026-10-30/120001-abcdef.json','two/2026-10-30/3cf6dc21-d697-4ad5-bf16-cf29de29cb65.md'];
  for(const key of keys)await x.put(key);
  await x.put('.pictether/namespaces/one.json','old claim');await x.put('.pictether/staging/00000000-0000-0000-0000-000000000001','partial');
  await x.put('one/2026-10-30/user-photo.png','unknown');await x.put('keep.txt','keep');await fs.mkdir(path.join(x.root,'unrelated-empty'));
  await fs.writeFile(path.join(x.vault,'note.md'),'![kept](mdasset://one/2026-10-30/120000-abcdef.png)');
  const plan=await scanLocalReset(x.root,[x.vault]);expect(plan).toMatchObject({files:3,namespaces:2,unknown:3});
  const remaining=await clearLocalAttachments(plan,[x.vault]);expect(remaining.files).toBe(0);expect(remaining.unknown).toBe(3);
  for(const key of keys)await expect(fs.lstat(path.join(x.root,key))).rejects.toMatchObject({code:'ENOENT'});
  expect(await fs.readFile(path.join(x.root,'keep.txt'),'utf8')).toBe('keep');
  expect(await fs.readFile(path.join(x.root,'one/2026-10-30/user-photo.png'),'utf8')).toBe('unknown');
  expect((await fs.stat(path.join(x.root,'unrelated-empty'))).isDirectory()).toBe(true);
  expect(await fs.readFile(path.join(x.vault,'note.md'),'utf8')).toContain('mdasset://');expect((await fs.stat(x.root)).isDirectory()).toBe(true);
});
it('requires fresh confirmation when a file is added, modified or the root changes',async()=>{
  const x=await fixture();const first=await x.put('one/2026-10-30/120000-abcdef.png');
  const plan=await scanLocalReset(x.root,[x.vault]);await fs.writeFile(first,'changed');
  await expect(clearLocalAttachments(plan,[x.vault])).rejects.toThrow('范围已变化');expect(await fs.readFile(first,'utf8')).toBe('changed');
  const changed=await scanLocalReset(x.root,[x.vault]);await x.put('two/2026-10-30/120000-abcdef.png');
  await expect(clearLocalAttachments(changed,[x.vault])).rejects.toThrow('范围已变化');
});
it('rejects dangerous roots and any overlap with the vault',async()=>{
  const x=await fixture();
  for(const root of ['/',os.homedir(),x.vault,path.dirname(x.vault),path.join(x.vault,'attachments')])await expect(scanLocalReset(root,[x.vault])).rejects.toThrow('重置已停止');
  await expect(scanLocalReset(x.root,[x.vault])).resolves.toMatchObject({files:0});
});
it('refuses a root replaced after review even when attachment paths match',async()=>{
  const x=await fixture(),key='one/2026-10-30/120000-abcdef.png';await x.put(key,'original');
  const plan=await scanLocalReset(x.root,[x.vault]);await fs.rename(x.root,`${x.root}-previous`);await x.put(key,'replacement');
  await expect(clearLocalAttachments(plan,[x.vault])).rejects.toThrow('范围已变化');
  expect(await fs.readFile(path.join(x.root,key),'utf8')).toBe('replacement');
  expect(await fs.readFile(path.join(`${x.root}-previous`,key),'utf8')).toBe('original');
});
it('rejects symlinks without following their targets',async()=>{
  const x=await fixture(),outside=await fs.mkdtemp(path.join(os.tmpdir(),'pictether-reset-outside-'));
  await fs.writeFile(path.join(outside,'keep.txt'),'keep');await fs.symlink(outside,path.join(x.root,'shared'));
  await expect(scanLocalReset(x.root,[x.vault])).rejects.toThrow('符号链接');
  expect(await fs.readFile(path.join(outside,'keep.txt'),'utf8')).toBe('keep');
  await expect(scanLocalReset(path.join(x.root,'shared'),[x.vault])).rejects.toThrow('符号链接');
});
it('keeps partially deleted scope retryable after a filesystem failure',async()=>{
  const x=await fixture();
  const first=await x.put('one/2026-10-30/120000-aaaaaa.png'),second=await x.put('one/2026-10-30/120000-bbbbbb.png');
  const plan=await scanLocalReset(x.root,[x.vault]);const unlink=vi.mocked(fs.unlink),original=unlink.getMockImplementation()!;
  unlink.mockImplementation(async file=>{if(file===second)throw Object.assign(new Error('denied'),{code:'EACCES'});return original(file);});
  try{await expect(clearLocalAttachments(plan,[x.vault])).rejects.toMatchObject({code:'EACCES'});}finally{unlink.mockImplementation(original);}
  await expect(fs.stat(first)).rejects.toMatchObject({code:'ENOENT'});expect(await fs.readFile(second,'utf8')).toBe('attachment');
  const retry=await scanLocalReset(x.root,[x.vault]);expect(retry.files).toBe(1);await clearLocalAttachments(retry,[x.vault]);
  expect((await scanLocalReset(x.root,[x.vault])).files).toBe(0);
});
it('stops if another writer creates managed files during deletion',async()=>{
  const x=await fixture(),first=await x.put('one/2026-10-30/120000-aaaaaa.png');
  const plan=await scanLocalReset(x.root,[x.vault]),unlink=vi.mocked(fs.unlink),original=unlink.getMockImplementation()!;
  unlink.mockImplementation(async file=>{await original(file);if(file===first)await x.put('two/2026-10-30/120000-bbbbbb.png','new writer');});
  try{await expect(clearLocalAttachments(plan,[x.vault])).rejects.toThrow('范围发生变化');}finally{unlink.mockImplementation(original);}
  expect(await fs.readFile(path.join(x.root,'two/2026-10-30/120000-bbbbbb.png'),'utf8')).toBe('new writer');
});
it('can review a missing root without creating or deleting it',async()=>{
  const x=await fixture(),missing=path.join(x.root,'not-created');const plan=await scanLocalReset(missing,[x.vault]);
  expect(plan.files).toBe(0);await clearLocalAttachments(plan,[x.vault]);await expect(fs.stat(missing)).rejects.toMatchObject({code:'ENOENT'});
});
