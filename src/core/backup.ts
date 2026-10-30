import { AssetMetadata, AssetStorage, isMissing } from './storage';
import { digest } from './images';
import { referenceFromKey } from './references';
import { JobStore, Job } from './job-store';
import {
  BackupConflict,
  CloudAttachmentMissing,
  CloudBackup,
  cloudFailureMessage,
  remoteSource,
  verifyRemote,
} from './r2';

export class BackupQueue {
  private running?: Promise<void>;
  private stopped = false;
  private clearing?: Promise<number>;
  constructor(
    private state: JobStore,
    private cloud: CloudBackup,
    private onError: () => void = () => {},
    private root?: string,
  ) {}
  static async enqueue(
    state: JobStore,
    root: string,
    key: string,
    bytes: Uint8Array,
    onlyIfNew = false,
  ): Promise<boolean> {
    return this.enqueueHash(state, root, key, digest(bytes), onlyIfNew);
  }
  static async enqueueHash(
    state: JobStore,
    root: string,
    key: string,
    sha256: string,
    onlyIfNew = false,
  ): Promise<boolean> {
    return state.enqueue(root, key, sha256, onlyIfNew);
  }
  static async clearRecords(state: JobStore, root: string, cutoff?: number): Promise<number> {
    return state.clear(root, cutoff ?? (await state.maximum(root)));
  }
  clearRecords(root: string): Promise<number> {
    if (this.clearing) return this.clearing;
    this.clearing = (async () => {
      const cutoff = await this.state.maximum(root);
      await this.running;
      return BackupQueue.clearRecords(this.state, root, cutoff);
    })().finally(() => {
      this.clearing = undefined;
    });
    return this.clearing;
  }
  sync(force = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.clearing) return this.clearing.then(() => this.sync(force));
    if (this.running) return this.running;
    this.running = this.run(force).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async run(force: boolean): Promise<void> {
    const cutoff = await this.state.maximum(this.root);
    const now = Date.now();
    let after = 0;
    while (!this.stopped) {
      const jobs = await this.state.pending(
        after,
        cutoff,
        this.cloud.target,
        force,
        now,
        this.root,
      );
      if (!jobs.length) return;
      after = jobs[jobs.length - 1]!.seq;
      const groups = new Map<string, Job[]>();
      for (const job of jobs) {
        const group = groups.get(job.key) ?? [];
        group.push(job);
        groups.set(job.key, group);
      }
      const work = [...groups.values()];
      let index = 0;
      const worker = async () => {
        while (!this.stopped && index < work.length) {
          for (const job of work[index++]!) {
            if (this.stopped) return;
            await this.upload(job);
          }
        }
      };
      await Promise.all([worker(), worker()]);
    }
  }
  private async upload(job: Job): Promise<void> {
    try {
      try {
        referenceFromKey(job.key);
      } catch {
        throw new BackupConflict(
          'Attachment type is no longer managed; original file and record were retained.',
        );
      }
      const storage = new AssetStorage(job.root),
        asset = await storage.inspect(job.key);
      if (asset.sha256 !== job.sha256) throw new BackupConflict('Local content changed.');
      let remote = await remoteSource(this.cloud, job.key);
      if (!remote) {
        if (this.cloud.putSourceIfAbsent)
          await this.cloud.putSourceIfAbsent(job.key, asset, storage.stream(job.key));
        else await this.cloud.putIfAbsent(job.key, await storage.read(job.key));
        remote = await remoteSource(this.cloud, job.key);
      }
      if (!remote) throw new BackupConflict('Cloud object missing after upload.');
      await verifyRemote(remote, job.sha256);
      await this.state.complete(job, this.cloud.target);
    } catch (error) {
      await this.state.fail(
        job,
        this.cloud.target,
        error instanceof BackupConflict,
        error instanceof BackupConflict
          ? error.message
          : isMissing(error)
            ? 'Local attachment missing.'
            : cloudFailureMessage(error),
      );
      this.onError();
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
    await this.clearing;
  }
}

export class AssetRecovery {
  private inflight = new Map<string, Promise<AssetMetadata>>();
  private stopped = false;
  constructor(
    private storage: AssetStorage,
    private cloud: CloudBackup,
    private expectedHash: (key: string) => string | undefined | Promise<string | undefined> = () =>
      undefined,
  ) {}
  async ensureLocal(key: string, restore: boolean): Promise<AssetMetadata> {
    try {
      return await this.storage.describe(key);
    } catch (error) {
      if (!restore || !isMissing(error)) throw error;
    }
    if (this.stopped) throw new Error('Recovery paused.');
    let task = this.inflight.get(key);
    if (!task) {
      task = this.restore(key).finally(() => this.inflight.delete(key));
      this.inflight.set(key, task);
    }
    return task;
  }
  async load(key: string, restore: boolean): Promise<Uint8Array> {
    await this.ensureLocal(key, restore);
    return this.storage.read(key);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.inflight.values()]);
  }
  private async restore(key: string): Promise<AssetMetadata> {
    const expected = await this.expectedHash(key);
    const object = await remoteSource(this.cloud, key);
    if (!object) throw new CloudAttachmentMissing('Cloud attachment not found.');
    if (expected && expected !== object.sha256) {
      for await (const chunk of object.body) {
        void chunk; /* close the response before rejecting */
      }
      throw new BackupConflict('Restore checksum mismatch.');
    }
    try {
      const restored = await this.storage.writeSource(key, object.body, object.sha256, object.size);
      return restored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return this.storage.describe(key);
    }
  }
}
export { AssetRecovery as ImageRecovery };
