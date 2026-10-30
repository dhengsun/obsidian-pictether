import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { localDay, settingsState, validateBackupJob, isRecord, type BackupJob } from './state';
import { referenceFromKey } from './references';
import type { Job, JobCounts, DailyStats, BackupStats } from './job-store';
function decode(row: Record<string, unknown>): Job {
  const job = { ...row, error: row.error ?? undefined };
  validateBackupJob(job, new Set<string>());
  const seq = nonnegativeInteger(row.seq),
    revision = nonnegativeInteger(row.revision);
  if (seq === 0) throw new Error('Invalid SQLite job sequence.');
  return { ...job, seq, revision };
}
function nonnegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid SQLite counter.');
  }
  return value;
}
function jobStatus(value: unknown): keyof JobCounts {
  if (value === 'pending' || value === 'done' || value === 'conflict') return value;
  throw new Error('Invalid SQLite job status.');
}
export function cooperativeBudget(): () => Promise<void> {
  let start = performance.now();
  return async () => {
    if (performance.now() - start >= 4) {
      await yieldToHost();
      start = performance.now();
    }
  };
}
export class SqliteDatabase {
  private statements = new Map<string, StatementSync>();
  constructor(readonly db: DatabaseSync) {}
  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private async transactionAsync<T>(work: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  static async open(
    databasePath: string,
    legacyPath?: string,
    sourceVersion?: number,
  ): Promise<SqliteDatabase> {
    if (sourceVersion === 2 && !existsSync(databasePath))
      throw new Error('SQLite database missing.');
    if (existsSync(databasePath) && !lstatSync(databasePath).isFile())
      throw new Error('SQLite path must be a regular file.');
    // The build lowers this lazy import to CommonJS for the host loader.
    const { DatabaseSync: Database } = await import('node:sqlite');
    const db = new Database(databasePath, { allowExtension: false });
    try {
      const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
      if (version !== 0 && version !== 1 && version !== 2)
        throw new Error('Unsupported SQLite schema.');
      db.exec(
        'PRAGMA busy_timeout=25; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;',
      );
      const store = new SqliteDatabase(db),
        yieldHost = cooperativeBudget();
      store.transaction(() => {
        db.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS jobs (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
            root TEXT NOT NULL, key TEXT NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64),
            status TEXT NOT NULL CHECK(status IN ('pending','done','conflict')),
            target TEXT NOT NULL, attempts INTEGER NOT NULL CHECK(attempts>=0),
            nextAttempt INTEGER NOT NULL CHECK(nextAttempt>=0), error TEXT,
            revision INTEGER NOT NULL DEFAULT 0, UNIQUE(root,key));
          CREATE INDEX IF NOT EXISTS jobs_due ON jobs(target,status,nextAttempt,seq);
          CREATE INDEX IF NOT EXISTS jobs_root ON jobs(root,seq);
          CREATE INDEX IF NOT EXISTS jobs_errors ON jobs(root,seq) WHERE error IS NOT NULL;
          CREATE TABLE IF NOT EXISTS backup_daily (
            day TEXT NOT NULL,root TEXT NOT NULL,target TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,success INTEGER NOT NULL DEFAULT 0,
            conflict INTEGER NOT NULL DEFAULT 0,failed INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(day,root,target));
          PRAGMA user_version=2;`);
      });
      if (!db.prepare("SELECT value FROM metadata WHERE key='initialized'").get()) {
        if (sourceVersion === 2) throw new Error('SQLite migration marker missing.');
        const jobs: BackupJob[] = [];
        if (sourceVersion === 1) {
          if (!legacyPath || !(await fs.lstat(legacyPath)).isFile())
            throw new Error('Legacy data.json missing or unsafe.');
          const bytes = await fs.readFile(legacyPath),
            raw: unknown = JSON.parse(bytes.toString('utf8'));
          settingsState(raw);
          if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.jobs))
            throw new Error('Invalid legacy backup records.');
          const records: unknown[] = raw.jobs;
          const ids = new Set<string>();
          for (let i = 0; i < records.length; i++) {
            const record = records[i];
            validateBackupJob(record, ids);
            jobs.push(record);
            if (i % 128 === 0) await yieldHost();
          }
          const hash = createHash('sha256');
          for (let offset = 0; offset < bytes.length; offset += 65536) {
            hash.update(bytes.subarray(offset, offset + 65536));
            await yieldHost();
          }
          const backup = path.join(
            path.dirname(legacyPath),
            `data-v1.${hash.digest('hex')}.backup.json`,
          );
          const staging = `${backup}.${randomUUID()}.staging`;
          let ownsStaging = false;
          try {
            const file = await fs.open(staging, 'wx', 0o600);
            ownsStaging = true;
            try {
              await file.writeFile(bytes);
              await file.sync();
            } finally {
              await file.close();
            }
            try {
              await fs.link(staging, backup);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
              if (!(await fs.lstat(backup)).isFile() || !(await fs.readFile(backup)).equals(bytes))
                throw new Error('Legacy backup conflict.');
            }
          } finally {
            if (ownsStaging)
              await fs.unlink(staging).catch((error) => {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              });
          }
        }
        await store.transactionAsync(async () => {
          if (db.prepare("SELECT value FROM metadata WHERE key='initialized'").get()) return;
          const insert = store.statement(
            'INSERT INTO jobs(id,root,key,sha256,status,target,attempts,nextAttempt,error) VALUES(?,?,?,?,?,?,?,?,?)',
          );
          for (let i = 0; i < jobs.length; i++) {
            const job = jobs[i]!;
            insert.run(
              job.id,
              job.root,
              job.key,
              job.sha256,
              job.status,
              job.target,
              job.attempts,
              job.nextAttempt,
              job.error ?? null,
            );
            if (i % 128 === 0) await yieldHost();
          }
          if (Number(db.prepare('SELECT count(*) AS n FROM jobs').get()!.n) !== jobs.length)
            throw new Error('Migration count mismatch.');
          for (let i = 0; i < jobs.length; i++) {
            const job = jobs[i]!,
              row = store.get(job.root, job.key)!;
            for (const field of [
              'id',
              'root',
              'key',
              'sha256',
              'status',
              'target',
              'attempts',
              'nextAttempt',
              'error',
            ] as const)
              if (row[field] !== job[field]) throw new Error('Migration verification failed.');
            if (i % 128 === 0) await yieldHost();
          }
          db.prepare("INSERT INTO metadata(key,value) VALUES('initialized','1')").run();
        });
      }
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  get(root: string, key: string): Job | undefined {
    const row = this.statement('SELECT * FROM jobs WHERE root=? AND key=?').get(root, key);
    return row ? decode(row) : undefined;
  }
  enqueue(root: string, key: string, sha256: string, onlyIfNew = false): boolean {
    referenceFromKey(key);
    if (!path.isAbsolute(root) || !/^[a-f0-9]{64}$/.test(sha256))
      throw new Error('Invalid attachment record.');
    return this.transaction(() => {
      const found = this.get(root, key);
      if (found) {
        if (onlyIfNew) return false;
        if (found.sha256 !== sha256)
          this.statement(
            "UPDATE jobs SET status='conflict',error='Local content changed.',revision=revision+1 WHERE id=?",
          ).run(found.id);
        return true;
      }
      this.statement(
        "INSERT INTO jobs(id,root,key,sha256,status,target,attempts,nextAttempt) VALUES(?,?,?,?,'pending','',0,0)",
      ).run(randomUUID(), root, key, sha256);
      return true;
    });
  }
  page(after: number, cutoff: number, limit = 128, root?: string): Job[] {
    limit = Math.max(1, Math.min(512, limit));
    return (
      root === undefined
        ? this.statement('SELECT * FROM jobs WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?').all(
            after,
            cutoff,
            limit,
          )
        : this.statement(
            'SELECT * FROM jobs WHERE root=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?',
          ).all(root, after, cutoff, limit)
    ).map(decode);
  }
  pending(
    after: number,
    cutoff: number,
    target: string,
    force: boolean,
    now: number,
    root?: string,
  ): Job[] {
    // Disjoint branches let indexes skip completed jobs at the current target.
    const scope = root === undefined ? '' : ' AND root=?';
    const sql = `SELECT * FROM jobs INDEXED BY jobs_due WHERE target=? AND status='pending' AND nextAttempt<=? AND seq>? AND seq<=?${scope}
      UNION ALL SELECT * FROM jobs INDEXED BY jobs_due WHERE target<? AND seq>? AND seq<=? AND nextAttempt<=?${scope}
      UNION ALL SELECT * FROM jobs INDEXED BY jobs_due WHERE target>? AND seq>? AND seq<=? AND nextAttempt<=?${scope}
      ORDER BY seq LIMIT 128`;
    const due = force ? Number.MAX_SAFE_INTEGER : now;
    const binding = root === undefined ? [] : [root];
    return this.statement(sql)
      .all(
        target,
        due,
        after,
        cutoff,
        ...binding,
        target,
        after,
        cutoff,
        due,
        ...binding,
        target,
        after,
        cutoff,
        due,
        ...binding,
      )
      .map(decode);
  }
  maximum(root?: string): number {
    return Number(
      (root === undefined
        ? this.statement('SELECT max(seq) AS n FROM jobs').get()
        : this.statement('SELECT max(seq) AS n FROM jobs WHERE root=?').get(root))!.n ?? 0,
    );
  }
  clear(root: string, cutoff: number): number {
    return Number(
      this.statement('DELETE FROM jobs WHERE root=? AND seq<=?').run(root, cutoff).changes,
    );
  }
  complete(job: Job, target: string): void {
    this.transaction(() => {
      const result = this.statement(
        "UPDATE jobs SET status='done',target=?,attempts=0,nextAttempt=0,error=NULL,revision=revision+1 WHERE id=? AND revision=?",
      ).run(target, job.id, job.revision);
      if (Number(result.changes)) this.recordAttempt(job.root, target, 'success');
    });
  }
  fail(job: Job, target: string, conflict: boolean, error: string): void {
    const attempts = job.attempts + 1,
      next = Date.now() + Math.min(3_600_000, 5_000 * 2 ** Math.min(attempts, 10));
    this.transaction(() => {
      const result = this.statement(
        'UPDATE jobs SET status=?,target=?,attempts=?,nextAttempt=?,error=?,revision=revision+1 WHERE id=? AND revision=?',
      ).run(conflict ? 'conflict' : 'pending', target, attempts, next, error, job.id, job.revision);
      if (Number(result.changes))
        this.recordAttempt(job.root, target, conflict ? 'conflict' : 'failed');
    });
  }
  private recordAttempt(
    root: string,
    target: string,
    outcome: 'success' | 'conflict' | 'failed',
  ): void {
    this.statement(
      `INSERT INTO backup_daily(day,root,target,attempts,success,conflict,failed) VALUES(?,?,?,1,?,?,?)
      ON CONFLICT(day,root,target) DO UPDATE SET attempts=attempts+1,success=success+excluded.success,conflict=conflict+excluded.conflict,failed=failed+excluded.failed`,
    ).run(
      localDay(),
      root,
      target,
      outcome === 'success' ? 1 : 0,
      outcome === 'conflict' ? 1 : 0,
      outcome === 'failed' ? 1 : 0,
    );
  }
  daily(root: string, target: string, day = localDay()): DailyStats {
    const row = this.statement(
      'SELECT attempts,success,conflict,failed FROM backup_daily WHERE day=? AND root=? AND target=?',
    ).get(day, root, target);
    return {
      attempts: nonnegativeInteger(row?.attempts ?? 0),
      success: nonnegativeInteger(row?.success ?? 0),
      conflict: nonnegativeInteger(row?.conflict ?? 0),
      failed: nonnegativeInteger(row?.failed ?? 0),
    };
  }
  async totalsBatched(root: string, target: string): Promise<BackupStats> {
    const totals: BackupStats = { attempts: 0, success: 0, conflict: 0, failed: 0 };
    const cutoff = nonnegativeInteger(
      this.statement('SELECT max(rowid) AS n FROM backup_daily').get()?.n ?? 0,
    );
    const yieldHost = cooperativeBudget();
    let after = 0;
    for (;;) {
      // Rowid pages bound each synchronous read without adding a schema/index migration.
      const rows = this.statement(
        'SELECT rowid AS seq,root,target,attempts,success,conflict,failed FROM backup_daily WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 256',
      ).all(after, cutoff);
      if (!rows.length) return totals;
      for (const row of rows) {
        if (row.root !== root || row.target !== target) continue;
        for (const field of ['attempts', 'success', 'conflict', 'failed'] as const) {
          totals[field] = nonnegativeInteger(totals[field] + nonnegativeInteger(row[field]));
        }
      }
      after = nonnegativeInteger(rows[rows.length - 1]!.seq);
      await yieldHost();
    }
  }
  async resetBatched(): Promise<void> {
    const yieldHost = cooperativeBudget();
    await this.transactionAsync(async () => {
      for (const table of ['jobs', 'backup_daily'])
        for (;;) {
          const result = this.statement(
            `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} LIMIT 256)`,
          ).run();
          if (!Number(result.changes)) break;
          await yieldHost();
        }
      // Keep initialized metadata: a reset must never re-import legacy JSON.
      this.statement("DELETE FROM metadata WHERE key<>'initialized'").run();
      this.statement("DELETE FROM sqlite_sequence WHERE name='jobs'").run();
    });
  }
  counts(root?: string): JobCounts {
    const result: JobCounts = { pending: 0, done: 0, conflict: 0 };
    const rows =
      root === undefined
        ? this.statement('SELECT status,count(*) AS n FROM jobs GROUP BY status').all()
        : this.statement('SELECT status,count(*) AS n FROM jobs WHERE root=? GROUP BY status').all(
            root,
          );
    for (const row of rows) result[jobStatus(row.status)] = nonnegativeInteger(row.n);
    return result;
  }
  errors(root: string): Job[] {
    return this.statement(
      'SELECT * FROM jobs WHERE root=? AND error IS NOT NULL ORDER BY seq DESC LIMIT 20',
    )
      .all(root)
      .map(decode);
  }
  verify(root: string): void {
    this.statement(
      "UPDATE jobs SET status='pending',nextAttempt=0,revision=revision+1 WHERE root=? AND status='done'",
    ).run(root);
  }
  async clearBatched(root: string, cutoff: number): Promise<number> {
    const yieldHost = cooperativeBudget();
    return this.transactionAsync(async () => {
      let removed = 0,
        after = 0;
      for (;;) {
        const rows = this.statement(
          'SELECT seq FROM jobs WHERE root=? AND seq>? AND seq<=? ORDER BY seq LIMIT 256',
        ).all(root, after, cutoff);
        if (!rows.length) return removed;
        const end = Number(rows[rows.length - 1]!.seq);
        removed += Number(
          this.statement('DELETE FROM jobs WHERE root=? AND seq>? AND seq<=?').run(root, after, end)
            .changes,
        );
        after = end;
        await yieldHost();
      }
    });
  }
  async verifyBatched(root: string): Promise<void> {
    const yieldHost = cooperativeBudget(),
      cutoff = this.maximum(root);
    await this.transactionAsync(async () => {
      let after = 0;
      for (;;) {
        const rows = this.statement(
          "SELECT seq FROM jobs WHERE root=? AND seq>? AND seq<=? AND status='done' ORDER BY seq LIMIT 256",
        ).all(root, after, cutoff);
        if (!rows.length) return;
        const end = Number(rows[rows.length - 1]!.seq);
        this.statement(
          "UPDATE jobs SET status='pending',nextAttempt=0,revision=revision+1 WHERE root=? AND seq>? AND seq<=? AND status='done'",
        ).run(root, after, end);
        after = end;
        await yieldHost();
      }
    });
  }
  async countsBatched(root?: string): Promise<JobCounts> {
    const counts: JobCounts = { pending: 0, done: 0, conflict: 0 },
      cutoff = this.maximum(root),
      yieldHost = cooperativeBudget();
    let after = 0;
    for (;;) {
      const rows =
        root === undefined
          ? this.statement(
              'SELECT seq,status FROM jobs WHERE seq>? AND seq<=? ORDER BY seq LIMIT 256',
            ).all(after, cutoff)
          : this.statement(
              'SELECT seq,status FROM jobs WHERE root=? AND seq>? AND seq<=? ORDER BY seq LIMIT 256',
            ).all(root, after, cutoff);
      if (!rows.length) return counts;
      for (const row of rows) counts[jobStatus(row.status)]++;
      after = Number(rows[rows.length - 1]!.seq);
      await yieldHost();
    }
  }
  close(): void {
    this.db.close();
  }
}
