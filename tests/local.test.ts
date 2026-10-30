import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssetStorage } from '../src/core/storage';
import { defaultNamespace, localDate, parseReference, referenceFromKey } from '../src/core/references';
import { identifyImage } from '../src/core/images';
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=', 'base64');
const file = '3cf6dc21-d697-4ad5-bf16-cf29de29cb65.png';
describe('references', () => {
  it('roundtrips encoded namespace without note paths', () => {
    const key = `我的笔记/2026-10-26/${file}`;
    expect(parseReference(referenceFromKey(key)).key).toBe(key);
    expect(defaultNamespace('My Vault')).toBe('My-Vault');
    expect(localDate(new Date(2026, 0, 2, 23))).toBe('2026-01-02');
  });
  it.each(['../secret', '%2e%2e', 'vault%2f..', 'vault%5c..', 'a.b'])('rejects namespace %s', ns => expect(() => parseReference(`mdasset://${ns}/2026-10-26/${file}`)).toThrow());
  it('rejects bad dates, queries and non-v4 IDs', () => {
    for (const uri of [`mdasset://vault/2026-02-30/${file}`, `mdasset://vault/2026-10-26/${file}?x`, `mdasset://vault/2026-10-26/${file.replace('4ad5','1ad5')}`]) expect(() => parseReference(uri)).toThrow();
  });
});
describe('external storage', () => {
  it('imports outside vault with exclusive publication and stable bytes', async () => {
    const storage = new AssetStorage(await fs.mkdtemp(path.join(os.tmpdir(), 'pictether-')));
    const ref = await storage.import('vault', PNG);
    expect(await storage.read(ref.key)).toEqual(PNG);
    await expect(storage.write(ref.key, PNG)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await storage.read(ref.key)).toEqual(PNG);
    expect(identifyImage(PNG).extension).toBe('png');
    expect(() => identifyImage(Buffer.from('fake.png'))).toThrow();
  });
  it('blocks symlinks on reads and writes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pictether-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pictether-outside-'));
    await fs.symlink(outside, path.join(root, 'vault'));
    const storage = new AssetStorage(root);
    await expect(storage.write(`vault/2026-10-26/${file}`, PNG)).rejects.toThrow('Symlink');
    await expect(storage.read(`vault/2026-10-26/${file}`)).rejects.toThrow('Symlink');
  });
  it('shares an existing namespace without ownership checks or changing old claims', async () => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'pictether-shared-'));
    const claim=path.join(root,'.pictether/namespaces/vault.json');
    await fs.mkdir(path.dirname(claim),{recursive:true});await fs.writeFile(claim,'old ownership data');
    const first=new AssetStorage(root),second=new AssetStorage(root);
    const a=await first.import('vault',PNG),b=await second.import('vault',PNG);
    expect(a.key).not.toBe(b.key);expect(await second.read(a.key)).toEqual(PNG);expect(await first.read(b.key)).toEqual(PNG);
    expect(await fs.readFile(claim,'utf8')).toBe('old ownership data');
  });
  it('imports alongside existing namespace files without claiming or removing them', async () => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'pictether-unclaimed-')),storage=new AssetStorage(root);
    await fs.mkdir(path.join(root,'vault'));await fs.writeFile(path.join(root,'vault','keep.txt'),'keep');
    await storage.import('vault',PNG);
    expect(await fs.readFile(path.join(root,'vault','keep.txt'),'utf8')).toBe('keep');
    await expect(fs.stat(path.join(root,'.pictether/namespaces'))).rejects.toMatchObject({code:'ENOENT'});
  });
});
