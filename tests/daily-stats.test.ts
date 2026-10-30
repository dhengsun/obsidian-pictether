import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { testJobs } from './job-fixtures';
import { localDay } from '../src/core/state';
const key=(number:number)=>`vault/2026-10-30/120000-${number.toString(16).padStart(6,'0')}.png`;
const hash='a'.repeat(64),empty={attempts:0,success:0,conflict:0,failed:0};
afterEach(()=>vi.useRealTimers());
it('counts revision-accepted outcomes atomically, isolates dates/targets/roots and persists across reopen',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(2026,9,30,23,59));
  const directory=await mkdtemp(path.join(os.tmpdir(),'pictether-daily-')),file=path.join(directory,'jobs.sqlite'),store=await testJobs(file);
  await store.enqueue('/assets',key(1),hash);const first=(await store.get('/assets',key(1)))!;
  await store.complete(first,'bucket');await store.complete(first,'bucket');await store.fail(first,'bucket',true,'stale');
  expect(await store.daily('/assets','bucket')).toEqual({attempts:1,success:1,conflict:0,failed:0});
  expect(await store.daily('/other','bucket')).toEqual(empty);expect(await store.daily('/assets','other')).toEqual(empty);
  vi.setSystemTime(new Date(2026,9,31,0,1));
  await store.enqueue('/assets',key(2),hash);await store.fail((await store.get('/assets',key(2)))!,'bucket',false,'offline');
  await store.fail((await store.get('/assets',key(2)))!,'bucket',true,'mismatch');
  expect(await store.daily('/assets','bucket')).toEqual({attempts:2,success:0,conflict:1,failed:1});
  expect(await store.daily('/assets','bucket','2026-10-30')).toEqual({attempts:1,success:1,conflict:0,failed:0});
  expect(localDay()).toBe('2026-10-31');await store.close();
  const reopened=await testJobs(file);expect((await reopened.daily('/assets','bucket')).attempts).toBe(2);
});
it('rolls back job completion if its daily counter cannot be committed',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'pictether-daily-atomic-')),file=path.join(directory,'jobs.sqlite'),store=await testJobs(file);
  await store.enqueue('/assets',key(1),hash);const before=(await store.get('/assets',key(1)))!;
  const database=new DatabaseSync(file);database.exec("CREATE TRIGGER reject_daily BEFORE INSERT ON backup_daily BEGIN SELECT RAISE(ABORT,'injected'); END;");database.close();
  await expect(store.complete(before,'bucket')).rejects.toThrow('injected');expect(await store.get('/assets',key(1))).toEqual(before);
  expect(await store.daily('/assets','bucket')).toEqual(empty);
});
it('upgrades a real schema-v1 database without changing existing tasks or fabricating history',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'pictether-schema2-')),file=path.join(directory,'jobs.sqlite');
  const database=new DatabaseSync(file);
  database.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO metadata VALUES('initialized','1');
    CREATE TABLE jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,root TEXT NOT NULL,key TEXT NOT NULL,sha256 TEXT NOT NULL,status TEXT NOT NULL,target TEXT NOT NULL,attempts INTEGER NOT NULL,nextAttempt INTEGER NOT NULL,error TEXT,revision INTEGER NOT NULL DEFAULT 0,UNIQUE(root,key));PRAGMA user_version=1;`);
  database.prepare("INSERT INTO jobs(id,root,key,sha256,status,target,attempts,nextAttempt) VALUES('existing','/assets',?,?,'done','bucket',0,0)").run(key(1),hash);database.close();
  const store=await testJobs(file);expect((await store.get('/assets',key(1)))?.status).toBe('done');expect(await store.daily('/assets','bucket')).toEqual(empty);
  const check=new DatabaseSync(file);expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(2);check.close();
});
it('resets all roots and statistics but keeps the migration marker, including after reopen',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'pictether-reset-db-')),file=path.join(directory,'jobs.sqlite'),store=await testJobs(file);
  for(const root of ['/first','/second']){await store.enqueue(root,key(1),hash);await store.complete((await store.get(root,key(1)))!,'bucket');}
  await store.reset();expect(await store.counts()).toEqual({pending:0,done:0,conflict:0});expect(await store.daily('/first','bucket')).toEqual(empty);
  await store.close();const reopened=await testJobs(file);expect(await reopened.counts()).toEqual({pending:0,done:0,conflict:0});
  const check=new DatabaseSync(file);expect(check.prepare("SELECT value FROM metadata WHERE key='initialized'").get()!.value).toBe('1');check.close();
});
it('rolls back an interrupted batched reset instead of publishing a partial clear',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'pictether-reset-atomic-')),file=path.join(directory,'jobs.sqlite'),store=await testJobs(file);
  for(let index=0;index<300;index++)await store.enqueue('/assets',key(index),hash);
  const database=new DatabaseSync(file);database.exec("CREATE TRIGGER reject_reset BEFORE DELETE ON jobs WHEN OLD.seq>256 BEGIN SELECT RAISE(ABORT,'injected'); END;");database.close();
  await expect(store.reset()).rejects.toThrow('injected');expect((await store.counts()).pending).toBe(300);
});
