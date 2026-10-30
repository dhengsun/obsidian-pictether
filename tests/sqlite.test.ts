import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { SqliteDatabase } from '../src/core/sqlite-database';
import { SqliteJobStore, safeSqliteFailure } from '../src/core/job-store';
import { DEFAULT_SETTINGS, type BackupJob } from '../src/core/state';
import { testJobs } from './job-fixtures';
import { BackupQueue } from '../src/core/backup';
const hash='a'.repeat(64), key='vault/2026-10-29/120000-abcdef.png';
const handles:SqliteDatabase[]=[];
it('reports only safe error codes, never raw messages or paths',()=>{
  expect(safeSqliteFailure(Object.assign(new Error('credential and private file path'),{code:'ERR_UNKNOWN_BUILTIN_MODULE'}))).toBe('ERR_UNKNOWN_BUILTIN_MODULE');
  expect(safeSqliteFailure({code:'secret/path'})).toBe('UNKNOWN');
  expect(safeSqliteFailure(null)).toBe('UNKNOWN');
});
afterEach(()=>{for(const handle of handles.splice(0))handle.close();});
async function directory(){return mkdtemp(path.join(os.tmpdir(),'pictether-sqlite-'));}
function job(status:BackupJob['status']='pending'):BackupJob{return{id:'old-id',root:'/assets',key,sha256:hash,status,target:'r2',attempts:2,nextAttempt:123,error:'Offline'};}
async function legacy(jobs:BackupJob[]){
  const dir=await directory(),json=path.join(dir,'data.json'),db=path.join(dir,'pictether.sqlite');
  const bytes=JSON.stringify({version:1,settings:{...DEFAULT_SETTINGS},jobs});await writeFile(json,bytes);
  return{dir,json,db,bytes};
}
it.each(['pending','done','conflict'] as const)('migrates %s records exactly, backs up the JSON and never reimports cleared records',async status=>{
  const x=await legacy([job(status)]);
  const first=await SqliteDatabase.open(x.db,x.json,1);
  expect(first.get('/assets',key)).toMatchObject(job(status));expect(first.db.prepare('PRAGMA journal_mode').get()!.journal_mode).toBe('wal');
  expect(first.db.prepare('PRAGMA synchronous').get()!.synchronous).toBe(2);
  const backup=(await readdir(x.dir)).find(name=>name.endsWith('.backup.json'))!;
  expect(await readFile(path.join(x.dir,backup),'utf8')).toBe(x.bytes);
  first.clear('/assets',first.maximum());first.close();
  const restarted=await SqliteDatabase.open(x.db,x.json,1);handles.push(restarted);
  expect(restarted.counts()).toEqual({pending:0,done:0,conflict:0});
  expect(await readFile(x.json,'utf8')).toBe(x.bytes);
});
it('rolls back duplicate legacy keys and retains both original JSON and its backup',async()=>{
  const old=job(),x=await legacy([old,{...old,id:'other-id'}]);
  await expect(SqliteDatabase.open(x.db,x.json,1)).rejects.toThrow();
  const db=new DatabaseSync(x.db);expect(db.prepare('SELECT count(*) AS n FROM jobs').get()!.n).toBe(0);
  expect(db.prepare("SELECT * FROM metadata WHERE key='initialized'").get()).toBeUndefined();db.close();
  expect(await readFile(x.json,'utf8')).toBe(x.bytes);expect((await readdir(x.dir)).filter(name=>name.endsWith('.backup.json'))).toHaveLength(1);
});
it('refuses a missing v2 database and unknown schemas instead of silently recreating records',async()=>{
  const dir=await directory(),dbpath=path.join(dir,'db.sqlite');
  await expect(SqliteDatabase.open(dbpath,undefined,2)).rejects.toThrow('missing');
  const db=new DatabaseSync(dbpath);db.exec('PRAGMA user_version=42');db.close();
  await expect(SqliteDatabase.open(dbpath)).rejects.toThrow('schema');
});
it('uses indexed lookups, bounded pages and revision checks to preserve a concurrent conflict',async()=>{
  const store=await testJobs();await store.enqueue('/assets',key,hash);
  const current=(await store.get('/assets',key))!;
  await store.enqueue('/assets',key,'b'.repeat(64));await store.complete(current,'r2');
  expect((await store.get('/assets',key))!.status).toBe('conflict');
  expect((await store.page(0,await store.maximum(),9999))).toHaveLength(1);
  const native=await SqliteDatabase.open(path.join(await directory(),'index.sqlite'));handles.push(native);
  expect(native.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM jobs WHERE root=? AND key=?').all('/assets',key).map(row=>row.detail).join(' ')).toContain('INDEX');
});
async function childModule(dir:string):Promise<string>{
  const module=path.join(dir,'database.cjs');
  await build({entryPoints:['src/core/sqlite-database.ts'],bundle:true,platform:'node',format:'cjs',outfile:module,logLevel:'silent'});return module;
}
it('persists acknowledged intent across an abrupt process exit without a clean database close',async()=>{
  const dir=await directory(),db=path.join(dir,'crash.sqlite'),module=await childModule(dir);
  const child=spawn(process.execPath,['-e',`require(process.argv[1]).SqliteDatabase.open(process.argv[2]).then(db=>{db.enqueue('/assets',process.argv[3],'a'.repeat(64));process.send('committed');setInterval(()=>{},1000);});`,module,db,key],{stdio:['ignore','ignore','ignore','ipc']});
  try{await new Promise<void>((resolve,reject)=>{child.once('message',()=>resolve());child.once('error',reject);child.once('exit',code=>reject(new Error('Child exited '+code)));});}finally{child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}
  const restarted=await testJobs(db);expect((await restarted.get('/assets',key))!.status).toBe('pending');
});
it('retries interrupted batched migration without leaving partial records',async()=>{
  const jobs=Array.from({length:5000},(_,index)=>({...job(),id:`migration-${index}`,key:`vault/2026-10-29/120000-${index.toString(16).padStart(6,'0')}.png`}));
  const x=await legacy(jobs),module=await childModule(x.dir);
  const child=spawn(process.execPath,['-e',`require(process.argv[1]).SqliteDatabase.open(process.argv[2],process.argv[3],1).then(()=>{setInterval(()=>{},1000);});`,module,x.db,x.json],{stdio:'ignore'});
  try{
    const deadline=Date.now()+5000;
    while(!(await readdir(x.dir)).some(name=>name.endsWith('.backup.json'))){
      if(child.exitCode!==null)throw new Error('Migration child failed');
      if(Date.now()>deadline)throw new Error('Migration backup not created');
      await new Promise(resolve=>setTimeout(resolve,1));
    }
  }finally{child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}
  const reopened=await SqliteDatabase.open(x.db,x.json,1);handles.push(reopened);
  expect(reopened.counts().pending).toBe(5000);expect(await readFile(x.json,'utf8')).toBe(x.bytes);
});
it('preserves safe metadata for unsupported old attachments without enabling new imports',async()=>{
  const retired={...job(),key:'vault/2026-10-29/120000-abcdef.json'},x=await legacy([retired]);
  const database=await SqliteDatabase.open(x.db,x.json,1);handles.push(database);
  expect(database.get('/assets',retired.key)).toMatchObject(retired);
  expect(()=>database.enqueue('/assets',retired.key,hash)).toThrow();
  const store=await testJobs(x.db);let cloudReads=0;
  await new BackupQueue(store,{target:'new-bucket',get:async()=>{cloudReads++;return null;},putIfAbsent:async()=>{throw new Error('Unexpected upload');}}).sync(true);
  expect(cloudReads).toBe(0);expect((await store.get('/assets',retired.key))!.status).toBe('conflict');
});
it('rechecks a different cloud target and does not schedule completed jobs at the same target',async()=>{
  const store=await testJobs();await store.enqueue('/assets',key,hash);
  await store.complete((await store.get('/assets',key))!,'bucket-a');
  expect(await store.pending(0,await store.maximum(),'bucket-a',true,Date.now())).toEqual([]);
  expect(await store.pending(0,await store.maximum(),'bucket-b',true,Date.now())).toHaveLength(1);
});
