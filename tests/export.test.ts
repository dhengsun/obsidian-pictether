import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssetStorage } from '../src/core/storage';
import { exportNote } from '../src/core/export';
import { findMarkdownAssets } from '../src/core/markdown';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=', 'base64');
const filename = '3cf6dc21-d697-4ad5-bf16-cf29de29cb65.png';
const key = `vault/2026-10-26/${filename}`, uri = `mdasset://${key}`;
it('parses images and definitions but skips code and plain text', () => {
  const source = `![alt](<${uri}> "title")\n\n![ref][id]\n\n[id]: ${uri}\n\n\`${uri}\`\n\n\`\`\`md\n![example](${uri})\n\`\`\`\n${uri}`;
  const found = findMarkdownAssets(source);
  expect(found).toHaveLength(2);
  expect(found.map(x => source.slice(x.from, x.to))).toEqual([uri, uri]);
});
describe('portable note export', () => {
  it('preserves original text, formulas, titles and examples; deduplicates and resolves filename collisions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pictether-export-assets-'));
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'pictether-export-'));
    const storage = new AssetStorage(root);
    await storage.write(key, PNG);
    const other = `other/2026-10-26/${filename}`;
    await storage.write(other, PNG);
    const source = `# Note\n$$x^2$$\n![alt](${uri} "title")\n![again](${uri})\n![other](mdasset://${other})\n\n\`![example](${uri})\`\n`;
    const output = await exportNote(source, 'Note.md', parent, storage);
    const markdown = await fs.readFile(path.join(output, 'Note.md'), 'utf8');
    expect(markdown).toContain(`![alt](assets/${filename} "title")`);
    expect(markdown).toContain(`\`![example](${uri})\``);
    expect(markdown).toContain('$$x^2$$');
    expect(await fs.readdir(path.join(output, 'assets'))).toHaveLength(2);
    expect(source).toContain(`![again](${uri})`);
    expect(await fs.readdir(output)).toEqual(['Note.md', 'assets']);
  });
  it('reports the specific missing image before creating output', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'pictether-export-missing-'));
    const storage = new AssetStorage(path.join(parent, 'missing'));
    await expect(exportNote(`![alt](${uri})`, 'Note.md', parent, storage)).rejects.toThrow(key);
    expect(await fs.readdir(parent)).toEqual([]);
  });
  it('rejects unsafe export filenames', async () => {
    await expect(exportNote('', '../bad.md', '/private/tmp', new AssetStorage('/private/tmp'))).rejects.toThrow('Unsafe');
  });
});
it('preserves images used as examples inside math and frontmatter', () => {
  const source = `---\nexample: "![alt](${uri})"\n---\n\n$![inline](${uri})$\n\n$$\n![block](${uri})\n\n![block2](${uri})\n$$\n\n![real](${uri})`;
  expect(findMarkdownAssets(source)).toHaveLength(1);
});
