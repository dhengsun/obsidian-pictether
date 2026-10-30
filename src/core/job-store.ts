import { SqliteDatabase, cooperativeBudget } from './sqlite-database';
import type { BackupJob } from './state';
export function safeSqliteFailure(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^(?:ERR_|SQLITE_|E)[A-Z0-9_]+$/.test(code) ? code : 'UNKNOWN';
}

export interface Job extends BackupJob { seq: number; revision: number }
export interface JobCounts { pending: number; done: number; conflict: number }
export interface DailyStats { attempts:number;success:number;conflict:number;failed:number }
export interface JobStore {
  enqueue(root: string, key: string, sha256: string, onlyIfNew?: boolean): Promise<boolean>;
  get(root: string, key: string): Promise<Job | undefined>;
  page(after: number, cutoff: number, limit?: number, root?: string): Promise<Job[]>;
  pending(after: number, cutoff: number, target: string, force: boolean, now: number, root?:string): Promise<Job[]>;
  maximum(root?: string): Promise<number>;
  clear(root: string, cutoff: number): Promise<number>;
  complete(job: Job, target: string): Promise<void>;
  fail(job: Job, target: string, conflict: boolean, error: string): Promise<void>;
  counts(root?: string): Promise<JobCounts>;
  errors(root: string): Promise<Job[]>;
  verify(root: string): Promise<void>;
  daily(root:string,target:string,day?:string):Promise<DailyStats>;
  reset():Promise<void>;
  close(): Promise<void>;
}
export class SqliteJobStore implements JobStore {
  private tail:Promise<unknown>=Promise.resolve();
  private closing?:Promise<void>;
  private yieldHost=cooperativeBudget();
  private constructor(private database:SqliteDatabase){}
  static async open(databasePath:string,legacyPath?:string,sourceVersion?:number):Promise<SqliteJobStore>{
    try{return new SqliteJobStore(await SqliteDatabase.open(databasePath,legacyPath,sourceVersion));}
    catch(error){
      const known=['SQLite database missing.','SQLite migration marker missing.','Legacy data.json missing or unsafe.','Legacy backup conflict.','Migration count mismatch.','Migration verification failed.','Unsupported SQLite schema.'];
      const reason=error instanceof Error?known.find(message=>error.message.startsWith(message)):undefined;
      throw new Error(`SQLite open failed [${safeSqliteFailure(error)}]. ${reason??'Check builtin support, disk permissions and preserved records.'}`);
    }
  }
  private run<T>(work:()=>T|Promise<T>):Promise<T>{
    if(this.closing)return Promise.reject(new Error('SQLite connection closed.'));
    const task=this.tail.then(async()=>{await this.yieldHost();return work();});
    this.tail=task.catch(()=>{});return task;
  }
  enqueue(root:string,key:string,sha256:string,onlyIfNew=false){return this.run(()=>this.database.enqueue(root,key,sha256,onlyIfNew));}
  get(root:string,key:string){return this.run(()=>this.database.get(root,key));}
  page(after:number,cutoff:number,limit=128,root?:string){return this.run(()=>this.database.page(after,cutoff,limit,root));}
  pending(after:number,cutoff:number,target:string,force:boolean,now:number,root?:string){return this.run(()=>this.database.pending(after,cutoff,target,force,now,root));}
  maximum(root?:string){return this.run(()=>this.database.maximum(root));}
  clear(root:string,cutoff:number){return this.run(()=>this.database.clearBatched(root,cutoff));}
  complete(job:Job,target:string){return this.run(()=>this.database.complete(job,target));}
  fail(job:Job,target:string,conflict:boolean,error:string){return this.run(()=>this.database.fail(job,target,conflict,error));}
  counts(root?:string){return this.run(()=>this.database.countsBatched(root));}
  errors(root:string){return this.run(()=>this.database.errors(root));}
  verify(root:string){return this.run(()=>this.database.verifyBatched(root));}
  daily(root:string,target:string,day?:string){return this.run(()=>this.database.daily(root,target,day));}
  reset(){return this.run(()=>this.database.resetBatched());}
  close():Promise<void>{return this.closing??=this.tail.then(()=>this.database.close());}
}
