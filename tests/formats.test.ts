import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { identifyImage, validateImageExtension } from '../src/core/images';
import { newReference, parseReference, referenceFromKey } from '../src/core/references';
import { AssetStorage } from '../src/core/storage';
import { BackupQueue } from '../src/core/backup';
import { testJobs, allJobs } from './job-fixtures';
import { exportNote } from '../src/core/export';
import { JPG, BMP, AVIF } from './image-fixtures';

const ref = (name: string) => parseReference(`mdasset://vault/2026-10-28/${name}`);
describe('short and legacy names', () => {
  it('uses local date/time and six random hex digits for new references', () => {
    const actual = newReference('我的笔记', 'jpg', new Date(2026, 9, 28, 8, 4, 6));
    expect(actual.date).toBe('2026-10-28');
    expect(actual.filename).toMatch(/^080406-[0-9a-f]{6}\.jpg$/);
    expect(parseReference(referenceFromKey(actual.key))).toEqual(actual);
  });
  it.each(['000000-000000.jpg', '235959-abcdef.jpeg', '083012-a7c29f.bmp', '083012-a7c29f.avif', '3cf6dc21-d697-4ad5-bf16-cf29de29cb65.png'])('accepts safe filename %s', name => expect(ref(name).filename).toBe(name));
  it.each(['240000-abcdef.jpg','126000-abcdef.jpg','125960-abcdef.jpg','083012-ABCDE1.jpg','083012-abcde.jpg','083012-abcdefg.jpg','083012-abcdef.exe','../083012-abcdef.jpg'])('rejects unsafe filename %s', name => expect(() => ref(name)).toThrow());
});
describe('actual encoded images', () => {
  it('accepts genuine JPEG bytes including allowed data after EOI without changing them', () => {
    const trailing = Buffer.concat([JPG, Buffer.from('\0camera trailer')]);
    expect(identifyImage(JPG)).toEqual({ extension: 'jpg', mime: 'image/jpeg' });
    expect(identifyImage(trailing).extension).toBe('jpg');
    expect(validateImageExtension(JPG, '083012-abcdef.jpeg').mime).toBe('image/jpeg');
    expect(() => identifyImage(JPG.subarray(0, JPG.length - 2))).toThrow();
    expect(() => identifyImage(Buffer.from([0xff,0xd8,0xff,0xd9]))).toThrow();
  });
  it('recognizes real BMP and rejects extension mismatches', () => {
    expect(identifyImage(BMP)).toEqual({ extension: 'bmp', mime: 'image/bmp' });
    expect(() => validateImageExtension(BMP, '083012-abcdef.jpg')).toThrow('does not match');
    expect(() => identifyImage(BMP.subarray(0,30))).toThrow();
  });
  it('recognizes a real AVIF fixture without accepting HEIC or truncated boxes', () => {
    expect(identifyImage(AVIF)).toEqual({ extension: 'avif', mime: 'image/avif' });
    expect(() => identifyImage(AVIF.subarray(0, 12))).toThrow();
    const heic = Buffer.from(AVIF);
    heic.write('heic', 8, 'ascii');
    heic.fill(0, 16, heic.readUInt32BE(0));
    expect(() => identifyImage(heic)).toThrow();
  });
  it.each([['jpg', JPG], ['bmp', BMP], ['avif', AVIF]] as const)('imports and exports %s with short filenames and unchanged bytes', async (extension, bytes) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pictether-formats-'));
    const storage = new AssetStorage(root);
    const image = await storage.import('vault', bytes);
    expect(image.filename).toMatch(new RegExp(`^\\d{6}-[a-f0-9]{6}\\.${extension}$`));
    expect(await storage.read(image.key)).toEqual(bytes);
    const output = await exportNote(`![Image](${referenceFromKey(image.key)})`, 'test.md', root, storage);
    expect(await fs.readFile(path.join(output,'assets',image.filename))).toEqual(bytes);
  });
});
describe('collision-safe imports', () => {
  it('retries an existing filename without overwriting it or journaling a duplicate', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pictether-collision-'));
    const occupied = ref('083012-000001.jpg'), fresh = ref('083012-000002.jpg');
    await new AssetStorage(root).write(occupied.key, JPG);
    let calls = 0;
    const storage = new AssetStorage(root, () => calls++ === 0 ? occupied : fresh);
    const journal: string[] = [];
    const actual = await storage.import('vault', JPG, async image => { journal.push(image.key); });
    expect(actual.key).toBe(fresh.key); expect(journal).toEqual([fresh.key]);
    expect(await storage.read(occupied.key)).toEqual(JPG);
  });
  it('skips names retained by older backup tasks without marking them as conflicts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pictether-intent-collision-'));
    const occupied = ref('083012-000001.jpg'), fresh = ref('083012-000002.jpg');
    const state = await testJobs();
    await BackupQueue.enqueue(state, root, occupied.key, Buffer.concat([JPG, Buffer.from('old')]));
    let calls = 0;
    const storage = new AssetStorage(root, () => calls++ === 0 ? occupied : fresh);
    expect((await storage.import('vault', JPG, image => BackupQueue.enqueue(state, root, image.key, JPG, true))).key).toBe(fresh.key);
    expect((await allJobs(state))).toHaveLength(2);
    expect((await allJobs(state))[0]?.status).toBe('pending');
  });
  it('bounds retries when every generated filename is occupied', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pictether-full-collision-'));
    const occupied = ref('083012-000001.jpg');
    await new AssetStorage(root).write(occupied.key, JPG);
    const storage = new AssetStorage(root, () => occupied);
    await expect(storage.import('vault', JPG)).rejects.toThrow('64 attempts');
    expect(await storage.read(occupied.key)).toEqual(JPG);
  });
});
