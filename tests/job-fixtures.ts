import { afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteJobStore, type Job } from '../src/core/job-store';
const stores: SqliteJobStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close().catch(() => {}); });
export async function testJobs(databasePath?: string): Promise<SqliteJobStore> {
  const directory = databasePath ? path.dirname(databasePath) : await mkdtemp(path.join(os.tmpdir(),'pictether-jobs-'));
  const store = await SqliteJobStore.open(databasePath ?? path.join(directory,'jobs.sqlite'));
  stores.push(store); return store;
}
export async function allJobs(store: SqliteJobStore): Promise<Job[]> {
  const cutoff=await store.maximum(), result:Job[]=[];let after=0;
  for (;;) { const page=await store.page(after,cutoff);if(!page.length)return result;result.push(...page);after=page[page.length-1]!.seq; }
}
