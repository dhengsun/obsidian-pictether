import { expect, it } from 'vitest';
import { mkdtemp, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { SqliteJobStore } from '../src/core/job-store';
import { DEFAULT_SETTINGS } from '../src/core/state';
const hash='a'.repeat(64);
const key=(index:number)=>`vault/2026-10-29/120000-${index.toString(16).padStart(6,'0')}.png`;
it.each([10_000,50_000,100_000])('migrates and queries %i real SQLite records with bounded responses and cooperative event-loop scheduling',async count=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'pictether-scale-'));
  const json=path.join(directory,'data.json'),database=path.join(directory,'pictether.sqlite');
  const jobs=Array.from({length:count},(_,index)=>({id:`scale-${index}`,root:'/assets',key:key(index),sha256:hash,status:index===count-1?'pending':'done',target:'r2',attempts:0,nextAttempt:0}));
  await writeFile(json,JSON.stringify({version:1,settings:{...DEFAULT_SETTINGS},jobs}));
  let last=performance.now(),maxLag=0,ticks=0;
  const timer=setInterval(()=>{const now=performance.now();maxLag=Math.max(maxLag,now-last-10);last=now;ticks++;},10);
  const start=performance.now();let store:SqliteJobStore|undefined;
  try{
    store=await SqliteJobStore.open(database,json,1);
    const migrationMs=performance.now()-start;
    const samples:number[]=[];
    for(let index=0;index<100;index++){
      const begin=performance.now();expect((await store.get('/assets',key((index*997)%count)))!.sha256).toBe(hash);samples.push(performance.now()-begin);
    }
    const pendingStart=performance.now(),pending=await store.pending(0,await store.maximum(),'r2',false,Date.now()),pendingMs=performance.now()-pendingStart;
    expect(pending).toHaveLength(1);expect((await store.page(0,await store.maximum(),9999)).length).toBeLessThanOrEqual(512);
    const updateStart=performance.now();await store.complete(pending[0]!,'r2');const updateMs=performance.now()-updateStart;
    await store.close();store=undefined;
    const reopenStart=performance.now();store=await SqliteJobStore.open(database,json,2);const reopenMs=performance.now()-reopenStart;
    expect(await store.counts()).toEqual({pending:0,done:count,conflict:0});expect(ticks).toBeGreaterThan(0);
    samples.sort((a,b)=>a-b);
    console.info('SQLITE_SCALE '+JSON.stringify({records:count,migrationMs:Math.round(migrationMs),reopenMs:Math.round(reopenMs),lookupP95Ms:Number(samples[94]!.toFixed(2)),pendingMs:Number(pendingMs.toFixed(2)),updateMs:Number(updateMs.toFixed(2)),mainThreadMaxLagMs:Math.round(maxLag),databaseBytes:(await stat(database)).size}));
  }finally{clearInterval(timer);await store?.close();}
},30_000);
