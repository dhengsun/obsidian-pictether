import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digest } from '../src/core/images';
import { AssetStorage } from '../src/core/storage';
import { BackupQueue, ImageRecovery } from '../src/core/backup';
import { initialState, settingsState, StateStore } from '../src/core/state';
import { CloudBackup, RemoteImage } from '../src/core/r2';
import { testJobs, allJobs } from './job-fixtures';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=', 'base64');
const key = 'vault/2026-10-26/3cf6dc21-d697-4ad5-bf16-cf29de29cb65.png';
class MemoryCloud implements CloudBackup {
  target = 'private-bucket'; objects = new Map<string, RemoteImage>(); online = true; puts = 0; reads = 0; active = 0; maxActive = 0;
  async get(key: string) { this.reads++; if (!this.online) throw new Error('offline'); return this.objects.get(key) ?? null; }
  async putIfAbsent(key: string, bytes: Uint8Array) { this.puts++; this.active++; this.maxActive = Math.max(this.maxActive, this.active); await new Promise(resolve => setTimeout(resolve, 3)); if (!this.objects.has(key)) this.objects.set(key, { bytes, sha256: digest(bytes) }); this.active--; }
}
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pictether-backup-'));
  const storage = new AssetStorage(root);
  await storage.write(key, PNG);
  const databasePath = path.join(root,'jobs.sqlite');
  const state = await testJobs(databasePath);
  const cloud = new MemoryCloud();
  await BackupQueue.enqueue(state, root, key, PNG);
  return { root, storage, state, cloud, databasePath };
}
describe('persistent backup', () => {
  it('retains offline work, recovers on restart and deduplicates successful uploads', async () => {
    const x = await setup(); x.cloud.online = false;
    await new BackupQueue(x.state, x.cloud).sync();
    expect((await allJobs(x.state))[0]?.status).toBe('pending');
    expect((await allJobs(x.state))[0]?.attempts).toBe(1);
    await x.state.close();
    const restarted = await testJobs(x.databasePath);
    x.cloud.online = true;
    const queue = new BackupQueue(restarted, x.cloud);
    await Promise.all([queue.sync(true), queue.sync(true)]);
    expect((await allJobs(restarted))[0]?.status).toBe('done');
    await queue.sync(true);
    expect(x.cloud.puts).toBe(1);
  });
  it('records cloud conflicts without uploading or overwriting', async () => {
    const x = await setup();
    const different = Buffer.concat([PNG, Buffer.from('different')]);
    x.cloud.objects.set(key, { bytes: different, sha256: digest(different) });
    await new BackupQueue(x.state, x.cloud).sync(true);
    expect((await allJobs(x.state))[0]?.status).toBe('conflict');
    expect(x.cloud.puts).toBe(0);
  });
  it('rechecks completed work when bucket target changes', async () => {
    const x = await setup(); const queue = new BackupQueue(x.state, x.cloud);
    await queue.sync(true);
    x.cloud.target = 'another-private-bucket'; x.cloud.objects.clear();
    await queue.sync(true);
    expect(x.cloud.puts).toBe(2);
    expect((await allJobs(x.state))[0]?.target).toBe(x.cloud.target);
  });
  it('keeps durable intent when the file has not yet been published', async () => {
    const x = await setup();
    const missing = key.replace('3cf6dc21', '4cf6dc21');
    await BackupQueue.enqueue(x.state, x.root, missing, PNG);
    await new BackupQueue(x.state, x.cloud).sync(true);
    expect((await allJobs(x.state)).find(j => j.key === missing)?.status).toBe('pending');
  });
  it('serializes concurrent state writes and survives failed persistence', async () => {
    let count = 0;
    const state = new StateStore(settingsState(null), async () => { if (++count === 1) throw new Error('disk full'); });
    await expect(state.update(s => { s.settings.bucket = 'failed'; })).rejects.toThrow('disk full');
    await Promise.all([state.update(s => { s.settings.bucket = 'saved'; }), state.update(s => { s.settings.namespace = 'vault'; })]);
    expect(state.snapshot().settings).toMatchObject({ bucket: 'saved', namespace: 'vault' });
    expect(() => initialState({ version: 2 })).toThrow();
  });
  it('limits concurrent cloud writes to two', async () => {
    const x = await setup();
    for (let i = 6; i < 11; i++) {
      const k = key.replace('3cf6dc21', `${i.toString(16)}cf6dc21`);
      await x.storage.write(k, PNG); await BackupQueue.enqueue(x.state, x.root, k, PNG);
    }
    await new BackupQueue(x.state, x.cloud).sync(true);
    expect(x.cloud.maxActive).toBeLessThanOrEqual(2);
    expect((await allJobs(x.state)).every(j => j.status === 'done')).toBe(true);
  });
  it('scopes pending work before pagination and never reads or updates another attachment root',async()=>{
    const x=await setup();
    for(let index=0;index<140;index++)await BackupQueue.enqueue(x.state,`${x.root}-other-${index}`,key,PNG);
    const second=key.replace('3cf6dc21','4cf6dc21');
    await x.storage.write(second,PNG);await BackupQueue.enqueue(x.state,x.root,second,PNG);
    const third=key.replace('3cf6dc21','5cf6dc21');
    await x.storage.write(third,PNG);await BackupQueue.enqueue(x.state,x.root,third,PNG);
    await x.state.complete((await x.state.get(x.root,second))!,'a-old-target');
    await x.state.complete((await x.state.get(x.root,third))!,'z-old-target');
    const before=(await allJobs(x.state)).filter(job=>job.root!==x.root);
    const queue=new BackupQueue(x.state,x.cloud,undefined,x.root);
    await queue.sync(true);
    expect((await allJobs(x.state)).filter(job=>job.root!==x.root)).toEqual(before);
    expect((await x.state.counts(x.root)).done).toBe(3);expect(x.cloud.puts).toBe(3);
  });
});
describe('restore', () => {
  it('recovers from a note key and cloud metadata without historical task records',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'pictether-fresh-restore-'));
    const state=await testJobs(),cloud=new MemoryCloud();cloud.objects.set(key,{bytes:PNG,sha256:digest(PNG)});
    const storage=new AssetStorage(root),recovery=new ImageRecovery(storage,cloud,async assetKey=>(await state.get(root,assetKey))?.sha256);
    await recovery.ensureLocal(key,true);
    expect(await storage.read(key)).toEqual(PNG);expect(await allJobs(state)).toEqual([]);expect(cloud.reads).toBe(1);
  });
  it('does not open a cloud response when the asynchronous checksum lookup fails', async () => {
    const cloud = new MemoryCloud(), root = await fs.mkdtemp(path.join(os.tmpdir(),'pictether-lookup-failure-'));
    const recovery = new ImageRecovery(new AssetStorage(root),cloud,async () => { throw new Error('SQLite unavailable'); });
    await expect(recovery.load(key,true)).rejects.toThrow('SQLite unavailable');
    expect(cloud.reads).toBe(0);
  });
  it('coalesces missing image requests and verifies bytes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pictether-restore-'));
    const cloud = new MemoryCloud(); cloud.objects.set(key, { bytes: PNG, sha256: digest(PNG) });
    const recovery = new ImageRecovery(new AssetStorage(root), cloud, () => digest(PNG));
    const results = await Promise.all([recovery.load(key, true), recovery.load(key, true)]);
    expect(results[0]).toEqual(PNG); expect(cloud.reads).toBe(1);
    await recovery.load(key, true); expect(cloud.reads).toBe(1);
  });
  it('does not restore automatically when disabled or overwrite local bytes', async () => {
    const x = await setup(); const recovery = new ImageRecovery(x.storage, x.cloud);
    await recovery.load(key, true); expect(x.cloud.reads).toBe(0);
    await expect(recovery.load(key.replace('3cf6dc21', '4cf6dc21'), false)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(x.cloud.reads).toBe(0);
  });
  it('refuses a mismatched cloud digest before writing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pictether-restore-bad-'));
    const cloud = new MemoryCloud(); cloud.objects.set(key, { bytes: PNG, sha256: 'bad' });
    const storage = new AssetStorage(root);
    await expect(new ImageRecovery(storage, cloud).load(key, true)).rejects.toThrow('checksum');
    await expect(storage.read(key)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
