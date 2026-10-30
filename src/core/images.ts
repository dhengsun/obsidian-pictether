import { createHash } from 'node:crypto';
export type ImageFormat = { extension: 'png' | 'jpg' | 'gif' | 'webp' | 'bmp' | 'avif'; mime: string };
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif'];
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'];

function isJpeg(b: Buffer): boolean {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return false;
  let position = 2, frame = false, scan = false;
  while (position < b.length) {
    if (b[position] !== 0xff) return false;
    while (b[position] === 0xff) position++;
    const marker = b[position++];
    if (marker === 0xd9) return frame && scan;
    if (marker === undefined || marker === 0 || marker === 0xd8) return false;
    if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (position + 2 > b.length) return false;
    const length = b.readUInt16BE(position);
    if (length < 2 || position + length > b.length) return false;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8 || !b.readUInt16BE(position + 3) || !b.readUInt16BE(position + 5)) return false;
      frame = true;
    }
    position += length;
    if (marker !== 0xda) continue;
    if (!frame || length < 6) return false;
    scan = true;
    // Skip entropy bytes and escaped/restart markers. Progressive JPEG can have
    // more than one scan. EOI may be followed by camera/application metadata.
    while (position < b.length) {
      if (b[position] !== 0xff) { position++; continue; }
      const next = b[position + 1];
      if (next === 0 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) { position += 2; continue; }
      break;
    }
  }
  return false;
}
function isBmp(b: Buffer): boolean {
  if (b.length < 26 || b.toString('ascii', 0, 2) !== 'BM') return false;
  const size = b.readUInt32LE(2), offset = b.readUInt32LE(10), dib = b.readUInt32LE(14);
  if (size > b.length || offset >= size || offset < 14 + dib) return false;
  if (dib === 12) return b.readUInt16LE(18) > 0 && b.readUInt16LE(20) > 0;
  return dib >= 40 && 14 + dib <= b.length && b.readInt32LE(18) > 0 && b.readInt32LE(22) !== 0;
}
function isAvif(b: Buffer): boolean {
  if (b.length < 16 || b.toString('ascii', 4, 8) !== 'ftyp') return false;
  const size = b.readUInt32BE(0);
  if (size < 16 || size > b.length || size % 4 !== 0) return false;
  if (['avif', 'avis'].includes(b.toString('ascii', 8, 12))) return true;
  for (let position = 16; position < size; position += 4) if (['avif', 'avis'].includes(b.toString('ascii', position, position + 4))) return true;
  return false;
}
export function identifyImage(data: Uint8Array): ImageFormat {
  const b = Buffer.from(data);
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && b.toString('ascii', 12, 16) === 'IHDR' && b.readUInt32BE(16) > 0 && b.readUInt32BE(20) > 0) return { extension: 'png', mime: 'image/png' };
  if (isJpeg(b)) return { extension: 'jpg', mime: 'image/jpeg' };
  if (b.length >= 14 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6)) && b.readUInt16LE(6) > 0 && b.readUInt16LE(8) > 0 && b[b.length - 1] === 59) return { extension: 'gif', mime: 'image/gif' };
  if (b.length >= 20 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' && /^VP8[ LX]$/.test(b.toString('ascii', 12, 16)) && b.readUInt32LE(4) + 8 === b.length) return { extension: 'webp', mime: 'image/webp' };
  if (isBmp(b)) return { extension: 'bmp', mime: 'image/bmp' };
  if (isAvif(b)) return { extension: 'avif', mime: 'image/avif' };
  throw new Error('Unsupported or damaged image. Expected PNG, JPG/JPEG, WebP, GIF, BMP or AVIF content.');
}
export function digest(data: Uint8Array): string { return createHash('sha256').update(data).digest('hex'); }
export function validateImageExtension(data: Uint8Array, filename: string): ImageFormat {
  const format = identifyImage(data);
  const ext = filename.split('.').at(-1);
  if (ext !== format.extension && !(ext === 'jpeg' && format.extension === 'jpg')) throw new Error('Image content does not match its extension.');
  return format;
}
