import { inflateRawSync } from 'node:zlib';

// Cititor ZIP minimal (din memorie): directorul central + fișiere „stored” sau „deflate”.
// Suficient pentru arhivele mici primite de la ANAF (e-Factura) și rapoartele DMARC.

export interface UnzippedFile {
  name: string;
  data: Buffer;
}

export class ZipError extends Error {}

export function unzip(buf: Buffer, opts: { maxFiles?: number; maxBytes?: number } = {}): UnzippedFile[] {
  const maxFiles = opts.maxFiles ?? 50;
  const maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
  // sfârșitul directorului central: semnătura 0x06054b50, în ultimii 64 KB
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('nu e o arhivă ZIP validă');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (count > maxFiles) throw new ZipError(`arhiva are prea multe fișiere (${count})`);
  const files: UnzippedFile[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new ZipError('director central corupt');
    const method = buf.readUInt16LE(offset + 10);
    const compressed = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const local = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    total += size;
    if (total > maxBytes) throw new ZipError('arhiva e prea mare după dezarhivare');
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new ZipError(`antet local corupt pentru ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compressed);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
    else throw new ZipError(`metodă de compresie necunoscută (${method}) pentru ${name}`);
    files.push({ name, data });
  }
  return files;
}
