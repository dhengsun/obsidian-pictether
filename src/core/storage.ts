import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {
  AssetReference,
  newReference,
  parseReference,
  referenceFromKey,
  validateNamespace,
} from './references';
import {
  AssetFormat,
  probeAsset,
  svgValidator,
  textAssetValidator,
  validateAssetExtension,
} from './assets';

export type ByteSource = AsyncIterable<Uint8Array>;
export interface AssetMetadata {
  path: string;
  size: number;
  format: AssetFormat;
}
export interface CheckedAsset extends AssetMetadata {
  sha256: string;
  md5: string;
}
type StagedAsset = CheckedAsset;
export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
export async function* bufferSource(data: Uint8Array): ByteSource {
  yield data;
}
export async function* blobSource(blob: Blob): ByteSource {
  const reader = blob.stream().getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      yield chunk.value;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
async function* chunks(handle: fs.FileHandle): ByteSource {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) return;
    position += bytesRead;
    yield Buffer.from(buffer.subarray(0, bytesRead));
  }
}
async function probe(handle: fs.FileHandle, size: number, hint: string): Promise<AssetFormat> {
  const head = Buffer.alloc(Math.min(size, 256 * 1024)),
    tail = Buffer.alloc(Math.min(size, 64 * 1024));
  await handle.read(head, 0, head.length, 0);
  await handle.read(tail, 0, tail.length, size - tail.length);
  const format = probeAsset(head, tail, size, hint);
  if (format.extension === 'svg') {
    const xml = svgValidator(),
      decoder = new TextDecoder('utf-8', { fatal: true });
    for await (const data of chunks(handle)) xml.write(decoder.decode(data, { stream: true }));
    xml.write(decoder.decode());
    xml.close();
  }
  if (format.kind === 'file') {
    const validator = textAssetValidator();
    for await (const data of chunks(handle)) validator.write(data);
    validator.close();
  }
  return format;
}
export class AssetStorage {
  private importing = new Set<string>();
  constructor(
    readonly root: string,
    private createReference = newReference,
  ) {
    if (!path.isAbsolute(root)) throw new Error('Assets Root must be an absolute path.');
  }
  async initialize(): Promise<string> {
    await fs.mkdir(this.root, { recursive: true });
    return fs.realpath(this.root);
  }
  private async safeDirectory(parts: string[]): Promise<string> {
    const root = await this.initialize();
    let current = root;
    for (const part of parts) {
      const next = path.join(current, part);
      await fs.mkdir(next).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      const stat = await fs.lstat(next);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error('Symlink or non-directory in managed storage.');
      current = await fs.realpath(next);
      if (!within(root, current)) throw new Error('Path escapes Assets Root.');
    }
    return current;
  }
  private async open(key: string): Promise<{ handle: fs.FileHandle; path: string; size: number }> {
    const ref = parseReference(referenceFromKey(key));
    const root = await fs.realpath(this.root);
    let current = root;
    for (const part of [ref.namespace, ref.date, ref.filename]) {
      current = path.join(current, part);
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error('Symlink assets are not allowed.');
    }
    const real = await fs.realpath(current);
    if (!within(root, real)) throw new Error('Path escapes Assets Root.');
    const handle = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Asset is not a regular file.');
      return { handle, path: real, size: stat.size };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  async describe(key: string): Promise<AssetMetadata> {
    const file = await this.open(key);
    try {
      const format = await probe(file.handle, file.size, key);
      validateAssetExtension(format, key);
      return { path: file.path, size: file.size, format };
    } finally {
      await file.handle.close();
    }
  }
  async inspect(key: string): Promise<CheckedAsset> {
    const file = await this.open(key);
    try {
      const format = await probe(file.handle, file.size, key);
      validateAssetExtension(format, key);
      const sha = createHash('sha256'),
        md5 = createHash('md5');
      let size = 0;
      for await (const data of chunks(file.handle)) {
        sha.update(data);
        md5.update(data);
        size += data.length;
      }
      if (size !== file.size) throw new Error('Attachment changed while hashing.');
      return {
        path: file.path,
        size,
        format,
        sha256: sha.digest('hex'),
        md5: md5.digest('base64'),
      };
    } finally {
      await file.handle.close();
    }
  }
  async *stream(key: string): ByteSource {
    const file = await this.open(key);
    try {
      validateAssetExtension(await probe(file.handle, file.size, key), key);
      yield* chunks(file.handle);
    } finally {
      await file.handle.close();
    }
  }
  async read(key: string): Promise<Buffer> {
    const data: Buffer[] = [];
    for await (const chunk of this.stream(key)) data.push(Buffer.from(chunk));
    return Buffer.concat(data);
  }
  private async stage(source: ByteSource, hint: string): Promise<StagedAsset> {
    const temporary = path.join(await this.safeDirectory(['.pictether', 'staging']), randomUUID());
    const handle = await fs.open(temporary, 'wx+', 0o600);
    const sha = createHash('sha256'),
      md5 = createHash('md5');
    let size = 0,
      completed = false;
    try {
      for await (const chunk of source) {
        await handle.writeFile(chunk);
        sha.update(chunk);
        md5.update(chunk);
        size += chunk.length;
      }
      await handle.sync();
      const format = await probe(handle, size, hint);
      completed = true;
      return {
        path: temporary,
        size,
        format,
        sha256: sha.digest('hex'),
        md5: md5.digest('base64'),
      };
    } finally {
      await handle.close();
      if (!completed) await fs.unlink(temporary);
    }
  }
  private async publish(key: string, staged: StagedAsset): Promise<CheckedAsset> {
    const ref = parseReference(referenceFromKey(key));
    validateAssetExtension(staged.format, ref.filename);
    const directory = await this.safeDirectory([ref.namespace, ref.date]);
    const target = path.join(directory, ref.filename);
    await fs.link(staged.path, target);
    return { ...staged, path: target };
  }
  async writeSource(
    key: string,
    source: ByteSource,
    expectedHash?: string,
    expectedSize?: number,
  ): Promise<CheckedAsset> {
    parseReference(referenceFromKey(key));
    const staged = await this.stage(source, key);
    try {
      if (expectedHash && staged.sha256 !== expectedHash)
        throw new Error('Attachment checksum mismatch.');
      if (expectedSize !== undefined && staged.size !== expectedSize)
        throw new Error('Attachment length mismatch.');
      return await this.publish(key, staged);
    } finally {
      await fs.unlink(staged.path);
    }
  }
  async write(key: string, data: Uint8Array): Promise<void> {
    await this.writeSource(key, bufferSource(data));
  }
  async importSource(
    namespace: string,
    source: ByteSource,
    hint: string,
    beforeWrite?: (ref: AssetReference, asset: CheckedAsset) => Promise<boolean | void>,
  ): Promise<AssetReference> {
    validateNamespace(namespace);
    if (/\.(?:md|json)$/i.test(hint))
      throw new Error('Text attachment import is handled by Obsidian.');
    const importedAt = new Date(),
      staged = await this.stage(source, hint);
    try {
      for (let attempt = 0; attempt < 64; attempt++) {
        const ref = this.createReference(namespace, staged.format.extension, importedAt);
        parseReference(referenceFromKey(ref.key));
        if (this.importing.has(ref.key)) continue;
        this.importing.add(ref.key);
        try {
          const directory = await this.safeDirectory([ref.namespace, ref.date]);
          try {
            await fs.lstat(path.join(directory, ref.filename));
            continue;
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
          if ((await beforeWrite?.(ref, staged)) === false) continue;
          try {
            await this.publish(ref.key, staged);
            return ref;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
        } finally {
          this.importing.delete(ref.key);
        }
      }
      throw new Error(
        'Could not allocate a unique attachment filename after 64 attempts. No existing attachment was overwritten.',
      );
    } finally {
      await fs.unlink(staged.path);
    }
  }
  async import(
    namespace: string,
    data: Uint8Array,
    beforeWrite?: (ref: AssetReference) => Promise<boolean | void>,
  ): Promise<AssetReference> {
    return this.importSource(namespace, bufferSource(data), '', beforeWrite);
  }
  async copyTo(key: string, target: string): Promise<void> {
    const handle = await fs.open(target, 'wx', 0o600);
    try {
      for await (const chunk of this.stream(key)) await handle.writeFile(chunk);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async *keys(namespace: string): AsyncGenerator<string> {
    validateNamespace(namespace);
    const base = path.join(await fs.realpath(this.root), namespace);
    let dates;
    try {
      dates = await fs.readdir(base, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if ((await fs.lstat(base)).isSymbolicLink())
      throw new Error('Symlink namespace is not allowed.');
    for (const date of dates) {
      if (!date.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(date.name)) continue;
      for (const file of await fs.readdir(path.join(base, date.name), { withFileTypes: true })) {
        if (!file.isFile()) continue;
        const key = `${namespace}/${date.name}/${file.name}`;
        try {
          referenceFromKey(key);
        } catch {
          continue;
        }
        yield key;
      }
    }
  }
}
