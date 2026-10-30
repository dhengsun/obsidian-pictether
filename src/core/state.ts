import { t } from './i18n';
import path from 'node:path';
import os from 'node:os';
import { validateRecordKey } from './references';
import { createHash } from 'node:crypto';
export interface CredentialProfile {
  id: string;
  name: string;
  accessKeySecret: string;
  secretKeySecret: string;
  test?: { status: 'ok' | 'error'; fingerprint: string; checkedAt: number };
}
export interface Settings {
  assetsRoot: string;
  namespace: string;
  autoBackup: boolean;
  restoreMissing: boolean;
  syncOnStartup: boolean;
  endpoint: string;
  bucket: string;
  accessKeySecret: string;
  secretKeySecret: string;
  region: string;
  credentials: CredentialProfile[];
  activeCredential: string;
  resetPending: boolean;
  retiredSecrets: string[];
}
export interface BackupJob {
  id: string;
  root: string;
  key: string;
  sha256: string;
  status: 'pending' | 'done' | 'conflict';
  target: string;
  attempts: number;
  nextAttempt: number;
  error?: string;
}
export interface State {
  version: 1;
  settings: Settings;
  jobs: BackupJob[];
}
export const DEFAULT_SETTINGS: Settings = {
  assetsRoot: path.join(os.homedir(), 'Pictures', 'markdown-assets'),
  namespace: '',
  autoBackup: false,
  restoreMissing: true,
  syncOnStartup: true,
  endpoint: '',
  bucket: '',
  accessKeySecret: '',
  secretKeySecret: '',
  region: 'auto',
  credentials: [],
  activeCredential: '',
  resetPending: false,
  retiredSecrets: [],
};
export function credentialFingerprint(
  settings: Pick<Settings, 'endpoint' | 'bucket' | 'region'>,
  profile: Pick<CredentialProfile, 'accessKeySecret' | 'secretKeySecret'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        settings.endpoint,
        settings.bucket,
        settings.region,
        profile.accessKeySecret,
        profile.secretKeySecret,
      ]),
    )
    .digest('hex');
}
export function activeProfile(settings: Settings): CredentialProfile | undefined {
  return settings.credentials.find((profile) => profile.id === settings.activeCredential);
}
export function selectCredential(settings: Settings, id: string): void {
  const profile = settings.credentials.find((item) => item.id === id);
  if (id && !profile) throw new Error('Unknown credential.');
  settings.activeCredential = id;
  settings.accessKeySecret = profile?.accessKeySecret ?? '';
  settings.secretKeySecret = profile?.secretKeySecret ?? '';
}
export function localDay(time: Date = new Date()): string {
  return `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, '0')}-${String(time.getDate()).padStart(2, '0')}`;
}
export function initialState(raw: unknown): State {
  if (raw == null) return { version: 1, settings: structuredClone(DEFAULT_SETTINGS), jobs: [] };
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.jobs))
    throw new Error(
      'Unsupported or damaged Pictether state. Preserve data.json and inspect it before continuing.',
    );
  const settings = settingsState(raw).settings;
  const records: unknown[] = raw.jobs,
    jobs: BackupJob[] = [],
    ids = new Set<string>();
  for (const record of records) {
    validateBackupJob(record, ids);
    jobs.push(record);
  }
  return { version: 1, settings, jobs };
}
export function validateBackupJob(job: unknown, ids: Set<string>): asserts job is BackupJob {
  if (
    !isRecord(job) ||
    typeof job.id !== 'string' ||
    ids.has(job.id) ||
    typeof job.key !== 'string' ||
    typeof job.root !== 'string' ||
    typeof job.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(job.sha256) ||
    (job.status !== 'pending' && job.status !== 'done' && job.status !== 'conflict') ||
    typeof job.target !== 'string' ||
    typeof job.attempts !== 'number' ||
    typeof job.nextAttempt !== 'number'
  )
    throw new Error('Damaged backup queue.');
  validateRecordKey(job.key);
  if (
    !path.isAbsolute(job.root) ||
    !Number.isSafeInteger(job.attempts) ||
    job.attempts < 0 ||
    !Number.isFinite(job.nextAttempt) ||
    job.nextAttempt < 0
  )
    throw new Error('Invalid backup task path or retry state.');
  if (job.error !== undefined && typeof job.error !== 'string')
    throw new Error('Invalid backup error record.');
  ids.add(job.id);
}
export interface SettingsState {
  version: 2;
  settings: Settings;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function settingsState(raw: unknown): SettingsState {
  if (raw == null) return { version: 2, settings: structuredClone(DEFAULT_SETTINGS) };
  if (!isRecord(raw) || (raw.version !== 1 && raw.version !== 2) || !isRecord(raw.settings))
    throw new Error('Unsupported or damaged Pictether settings.');
  const value = raw;
  const settings = { ...structuredClone(DEFAULT_SETTINGS), ...raw.settings };
  validateSettings(settings);
  if (
    !Object.prototype.hasOwnProperty.call(value.settings, 'credentials') &&
    settings.accessKeySecret &&
    settings.secretKeySecret
  ) {
    settings.credentials = [
      {
        id: 'legacy-default',
        name: t('默认凭据'),
        accessKeySecret: settings.accessKeySecret,
        secretKeySecret: settings.secretKeySecret,
      },
    ];
    settings.activeCredential = 'legacy-default';
  }
  if (settings.credentials.length) selectCredential(settings, settings.activeCredential);
  return { version: 2, settings };
}
function validateSettings(settings: unknown): asserts settings is Settings {
  if (!isRecord(settings)) throw new Error('Invalid settings object.');
  for (const [key, expected] of Object.entries(DEFAULT_SETTINGS)) {
    if (typeof settings[key] !== typeof expected) throw new Error(`Invalid setting: ${key}`);
  }
  if (!Array.isArray(settings.credentials)) throw new Error('Invalid credential list.');
  if (!Array.isArray(settings.retiredSecrets))
    throw new Error('Invalid retired secret references.');
  const retired: unknown[] = settings.retiredSecrets;
  if (
    retired.some(
      (name) =>
        typeof name !== 'string' || !/^pictether-(?:oss|r2)-[a-f0-9-]{36}-(?:id|key)$/.test(name),
    )
  )
    throw new Error('Invalid retired secret references.');
  const ids = new Set<string>(),
    profiles: unknown[] = settings.credentials;
  for (const profile of profiles) {
    if (
      !isRecord(profile) ||
      typeof profile.id !== 'string' ||
      !profile.id ||
      ids.has(profile.id) ||
      typeof profile.name !== 'string' ||
      typeof profile.accessKeySecret !== 'string' ||
      typeof profile.secretKeySecret !== 'string'
    )
      throw new Error('Invalid credential profile.');
    if (profile.test !== undefined) {
      const test = profile.test;
      if (
        !isRecord(test) ||
        (test.status !== 'ok' && test.status !== 'error') ||
        typeof test.fingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/.test(test.fingerprint) ||
        typeof test.checkedAt !== 'number' ||
        !Number.isSafeInteger(test.checkedAt) ||
        test.checkedAt < 0
      )
        throw new Error('Invalid credential test result.');
    }
    ids.add(profile.id);
  }
  if (
    typeof settings.activeCredential !== 'string' ||
    (settings.activeCredential && !ids.has(settings.activeCredential))
  )
    throw new Error('Unknown active credential.');
}
/** Serialize only small settings mutations; backup jobs never enter this store. */
export class StateStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private state: SettingsState,
    private persist: (state: SettingsState) => Promise<void>,
  ) {}
  snapshot(): SettingsState {
    return structuredClone(this.state);
  }
  update(mutate: (state: SettingsState) => void): Promise<void> {
    const task = this.tail.then(async () => {
      const next = structuredClone(this.state);
      mutate(next);
      validateSettings(next.settings);
      await this.persist(next);
      this.state = next;
    });
    this.tail = task.catch(() => {});
    return task;
  }
  async idle(): Promise<void> {
    await this.tail;
  }
}
