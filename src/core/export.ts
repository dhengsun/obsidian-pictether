import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AssetStorage } from './storage';
import { digest } from './images';
import { findMarkdownAssets, mediaEmbedMarkers } from './markdown';

export async function exportNote(
  markdown: string,
  noteName: string,
  parent: string,
  storage: AssetStorage,
): Promise<string> {
  if (!path.isAbsolute(parent))
    throw new Error('Export destination must be an absolute directory.');
  if (
    !noteName ||
    path.basename(noteName) !== noteName ||
    noteName.includes('\\') ||
    [...noteName].some((character) => character.charCodeAt(0) < 32) ||
    noteName === '.' ||
    noteName === '..'
  )
    throw new Error('Unsafe export note name.');
  const matches = findMarkdownAssets(markdown);
  const files = new Map<string, { name: string }>();
  const names = new Map<string, string>();
  // Validate all references before making any export directory.
  for (const { reference: ref } of matches) {
    if (files.has(ref.key)) continue;
    try {
      await storage.describe(ref.key);
    } catch {
      throw new Error(`Cannot export missing or unsafe attachment: ${ref.key}`);
    }
    let name = ref.filename;
    if (names.has(name) && names.get(name) !== ref.key) {
      name = `${digest(Buffer.from(ref.key)).slice(0, 16)}-${ref.filename}`;
    }
    if (names.has(name)) throw new Error(`Export filename collision: ${ref.key}`);
    names.set(name, ref.key);
    files.set(ref.key, { name });
  }
  let result = markdown;
  const edits = matches.map((match) => ({
    from: match.from,
    to: match.to,
    text: `assets/${files.get(match.reference.key)!.name}`,
  }));
  for (const from of mediaEmbedMarkers(markdown)) edits.push({ from, to: from + 1, text: '' });
  for (const edit of edits.sort((a, b) => b.from - a.from))
    result = result.slice(0, edit.from) + edit.text + result.slice(edit.to);
  await fs.access(parent);
  const output = path.join(parent, `${noteName.replace(/\.md$/i, '')}-pictether-${randomUUID()}`);
  await fs.mkdir(output);
  // Marker survives interrupted/failed exports; note.md is published last.
  const marker = path.join(output, 'EXPORT-INCOMPLETE.txt');
  await fs.writeFile(
    marker,
    'Export did not finish. Do not treat this directory as a complete export.\n',
    { flag: 'wx' },
  );
  await fs.mkdir(path.join(output, 'assets'));
  for (const [key, { name }] of files) await storage.copyTo(key, path.join(output, 'assets', name));
  await fs.writeFile(
    path.join(output, noteName.endsWith('.md') ? noteName : `${noteName}.md`),
    result,
    { flag: 'wx' },
  );
  await fs.unlink(marker);
  return output;
}
