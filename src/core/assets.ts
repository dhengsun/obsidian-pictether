import { SaxesParser } from 'saxes';
import { identifyImage, IMAGE_EXTENSIONS, IMAGE_MIME_TYPES } from './images';

export type AssetKind = 'image' | 'video' | 'pdf' | 'file';
export interface AssetFormat { extension: string; mime: string; kind: AssetKind }
export const ASSET_EXTENSIONS = [...IMAGE_EXTENSIONS, 'svg', 'mkv', 'mov', 'mp4', 'ogv', 'webm', 'pdf'];
export const ASSET_MIMES = [...IMAGE_MIME_TYPES, 'image/svg+xml', 'video/x-matroska', 'video/quicktime', 'video/mp4', 'video/ogg', 'video/webm', 'application/pdf'];
const VIDEO: Record<string, string> = { mkv: 'video/x-matroska', mov: 'video/quicktime', mp4: 'video/mp4', ogv: 'video/ogg', webm: 'video/webm' };
export function kindFromFilename(filename: string): AssetKind {
  const ext = filename.split('.').at(-1)!;
  return ext === 'md' ? 'file' : ext === 'pdf' ? 'pdf' : ext in VIDEO ? 'video' : 'image';
}
export function svgValidator(): { write(text: string): void; close(): void } {
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0, root = false;
  parser.on('doctype', () => { throw new Error('SVG document types and entity declarations are not supported.'); });
  parser.on('opentag', tag => {
    if (depth++ === 0) {
      if (tag.local !== 'svg' || tag.uri !== 'http://www.w3.org/2000/svg') throw new Error('Expected an SVG root element and namespace.');
      root = true;
    }
  });
  parser.on('closetag', () => { depth--; });
  parser.on('error', error => { throw error; });
  return { write: text => { parser.write(text); }, close: () => { parser.close(); if (!root) throw new Error('Empty SVG document.'); } };
}
/** Identify bounded file metadata. This validates containers, not every codec bitstream. */
export function probeAsset(head: Uint8Array, tail: Uint8Array, size: number, hint = ''): AssetFormat {
  const b = Buffer.from(head), end = Buffer.from(tail);
  const result = (extension: string, mime: string, kind: AssetKind): AssetFormat => ({ extension, mime, kind });
  const extension = hint.split('.').at(-1)?.toLowerCase();
  // MD remains readable only for records created before native Markdown handling.
  if (extension === 'md') return result(extension,'text/markdown','file');
  if (size === b.length) {
    try { return { ...identifyImage(b), kind: 'image' }; } catch { /* Try other supported containers below. */ }
  } else {
    if (b.length >= 24 && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && b.toString('ascii',12,16) === 'IHDR' && b.readUInt32BE(16) && b.readUInt32BE(20)) return result('png','image/png','image');
    if (b[0] === 255 && b[1] === 216 && b[2] === 255 && end.includes(Buffer.from([255,217]))) return result('jpg','image/jpeg','image');
    if (/^GIF8[79]a$/.test(b.toString('ascii',0,6)) && end.at(-1) === 59) return result('gif','image/gif','image');
    if (b.length >= 20 && b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP' && b.readUInt32LE(4)+8 === size) return result('webp','image/webp','image');
    if (b.length >= 26 && b.toString('ascii',0,2) === 'BM' && b.readUInt32LE(2) <= size && b.readUInt32LE(10) < size && b.readUInt32LE(14) >= 12) return result('bmp','image/bmp','image');
  }
  const text = b.toString('utf8').replace(/^\uFEFF/, '');
  if (/^(?:\s|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->)*<svg(?:\s|>)/.test(text)) return result('svg','image/svg+xml','image');
  if (/%PDF-\d\.\d/.test(b.toString('latin1',0,1024)) && end.includes(Buffer.from('%%EOF'))) return result('pdf','application/pdf','pdf');
  if (b.length >= 16 && b.toString('ascii',4,8) === 'ftyp') {
    const length = b.readUInt32BE(0);
    if (length < 16 || length > size || length > b.length || length % 4) throw new Error('Invalid media ftyp box.');
    const brands = [b.toString('ascii',8,12)];
    for (let offset = 16; offset < length; offset += 4) brands.push(b.toString('ascii',offset,offset+4));
    if (brands.some(brand => ['avif','avis'].includes(brand))) return result('avif','image/avif','image');
    if (brands.includes('qt  ')) return result('mov',VIDEO.mov!,'video');
    if (brands.some(brand => /^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash)$/.test(brand))) return result('mp4',VIDEO.mp4!,'video');
  }
  if (b.length >= 8 && b.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) {
    const offset = b.indexOf(Buffer.from([0x42,0x82]));
    if (offset >= 0 && offset < 4096) {
      const marker = b[offset+2];
      if (marker !== undefined && marker >= 0x80) {
        const doc = b.toString('ascii', offset+3, offset+3+(marker&0x7f));
        if (doc === 'webm') return result('webm',VIDEO.webm!,'video');
        if (doc === 'matroska') return result('mkv',VIDEO.mkv!,'video');
      }
    }
  }
  if (b.toString('ascii',0,4) === 'OggS' && b.includes(Buffer.from('theora'))) return result('ogv',VIDEO.ogv!,'video');
  if (/\.mov$/i.test(hint) && b.length >= 8 && ['moov','mdat','wide','free'].includes(b.toString('ascii',4,8)) && b.readUInt32BE(0) <= size) return result('mov',VIDEO.mov!,'video');
  throw new Error('Unsupported or damaged attachment. Expected an image, supported video, PDF or existing Markdown file.');
}
/** Validate text incrementally for legacy Markdown files without rendering their content. */
export function textAssetValidator(): { write(data: Uint8Array): void; close(): void } {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const check = (text: string) => { if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error('Attachment must contain UTF-8 text, not binary data.'); };
  return { write: data => check(decoder.decode(data,{stream:true})), close: () => check(decoder.decode()) };
}
export function identifyAsset(data: Uint8Array, hint = ''): AssetFormat {
  const format = probeAsset(data, data, data.length, hint);
  if (format.extension === 'svg') { const validator = svgValidator(); validator.write(Buffer.from(data).toString('utf8')); validator.close(); }
  if (format.kind === 'file') { const validator = textAssetValidator(); validator.write(data); validator.close(); }
  return format;
}
export function validateAssetExtension(format: AssetFormat, filename: string): void {
  const extension = filename.split('.').at(-1);
  if (extension !== format.extension && !(extension === 'jpeg' && format.extension === 'jpg')) throw new Error('Attachment content does not match its extension.');
}
