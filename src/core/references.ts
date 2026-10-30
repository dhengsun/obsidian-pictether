import { randomBytes } from 'node:crypto';

export interface AssetReference { namespace: string; date: string; filename: string; key: string }
export const UUID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpe?g|webp|gif|bmp|avif|svg|mkv|mov|mp4|ogv|webm|pdf|md)$/;
export const SHORT_FILE = /^(?:[01][0-9]|2[0-3])[0-5][0-9][0-5][0-9]-[0-9a-f]{6}\.(png|jpe?g|webp|gif|bmp|avif|svg|mkv|mov|mp4|ogv|webm|pdf|md)$/;
export function validateNamespace(value: string): string {
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,79}$/u.test(value) || value !== value.normalize('NFC')) {
    throw new Error('Namespace must contain 1–80 letters, numbers, underscores or hyphens; start with a letter or number.');
  }
  return value;
}
export function defaultNamespace(name: string): string {
  const candidate = name.normalize('NFC').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 80);
  return validateNamespace(candidate || 'vault');
}
export function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function parseReference(uri: string): AssetReference {
  const match = /^mdasset:\/\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/([^/?#]+)$/.exec(uri);
  if (!match) throw new Error(`Invalid Pictether reference: ${uri}`);
  const namespace = validateNamespace(decodeURIComponent(match[1]!));
  const date = match[2]!;
  const calendar = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== date) throw new Error('Invalid import date.');
  const filename = match[3]!;
  if (!UUID_FILE.test(filename) && !SHORT_FILE.test(filename)) throw new Error('Invalid image filename.');
  return { namespace, date, filename, key: `${namespace}/${date}/${filename}` };
}
export function referenceFromKey(key: string): string {
  const [namespace, date, filename, extra] = key.split('/');
  if (extra !== undefined || !namespace || !date || !filename) throw new Error('Invalid asset key.');
  const uri = `mdasset://${encodeURIComponent(namespace)}/${date}/${filename}`;
  parseReference(uri);
  return uri;
}
export function newReference(namespace: string, extension: string, now = new Date()): AssetReference {
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map(value => String(value).padStart(2, '0')).join('');
  return parseReference(`mdasset://${encodeURIComponent(validateNamespace(namespace))}/${localDate(now)}/${time}-${randomBytes(3).toString('hex')}.${extension}`);
}

/** Text attachments are files, rather than image embeds; escape labels as literal Markdown. */
export function attachmentMarkdown(key: string, label = 'Attachment'): string {
  const uri = referenceFromKey(key);
  const text = label.replace(/[\r\n]/g, ' ').replace(/[\\[\]]/g, '\\$&');
  return `${/\.md$/.test(key) ? '' : '!'}[${text}](${uri})`;
}


/** Archived backup metadata may outlive format support. Validate its address
 * without advertising that extension as a supported attachment type. */
export function validateRecordKey(key: string): void {
  const parts=key.split('/');
  if(parts.length!==3)throw new Error('Invalid backup record key.');
  const [namespace,date,filename]=parts;
  const match=/^(.+)\.([a-z0-9]{1,12})$/.exec(filename!);
  if(!match)throw new Error('Invalid backup filename.');
  parseReference(`mdasset://${encodeURIComponent(namespace!)}/${date}/${match[1]}.png`);
}
/** Well-formed addresses for retired formats are left untouched in notes. */
export function supportedReference(uri:string):AssetReference|undefined{
  const match=/^mdasset:\/\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/([^/?#]+)$/.exec(uri);
  if(!match)throw new Error('Invalid attachment reference.');
  validateRecordKey(`${decodeURIComponent(match[1]!)}/${match[2]}/${match[3]}`);
  return UUID_FILE.test(match[3]!)||SHORT_FILE.test(match[3]!)?parseReference(uri):undefined;
}
