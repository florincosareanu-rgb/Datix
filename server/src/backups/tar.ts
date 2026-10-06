// Cititor de arhive tar în flux (ustar, GNU „L” pentru nume lungi, PAX „x”), fără a păstra conținutul:
// folosit ca să verificăm că backup-ul se poate citi cap-coadă și că are ce trebuie (baze de date, site-uri).

export interface TarEntry {
  name: string;
  size: number;
  type: 'file' | 'dir' | 'link' | 'other';
}

const BLOCK = 512;

function readString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

function readSize(buf: Buffer): number {
  const field = buf.subarray(124, 136);
  if (field[0]! & 0x80) {
    // codare binară (base-256) pentru fișiere > 8 GB
    let n = 0;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i]!;
    return n;
  }
  const text = readString(buf, 124, 12).trim();
  return text ? parseInt(text, 8) : 0;
}

function checksumOk(header: Buffer): boolean {
  const stored = parseInt(readString(header, 148, 8).trim() || '0', 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
  return sum === stored;
}

function paxPath(data: Buffer): string | null {
  // înregistrări „<lungime> cheie=valoare\n”
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const len = Number(data.subarray(offset, space).toString('ascii'));
    if (!len) break;
    const record = data.subarray(space + 1, offset + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0 && record.slice(0, eq) === 'path') return record.slice(eq + 1);
    offset += len;
  }
  return null;
}

export class TarFormatError extends Error {}

/**
 * Parcurge arhiva și apelează onEntry pentru fiecare intrare. Aruncă eroare dacă arhiva e trunchiată
 * sau un antet e corupt (sumă de control greșită).
 */
export async function scanTar(source: AsyncIterable<Buffer>, onEntry: (e: TarEntry) => void): Promise<{ entries: number; bytes: number }> {
  let buf: Buffer = Buffer.alloc(0);
  let skip = 0; // octeți de date (cu umplutura) de sărit
  let collect: { kind: 'L' | 'x'; size: number } | null = null;
  let longName: string | null = null;
  let entries = 0;
  let bytes = 0;
  let zeroBlocks = 0;
  let ended = false;

  const process = () => {
    for (;;) {
      if (skip > 0) {
        const n = Math.min(skip, buf.length);
        buf = buf.subarray(n);
        skip -= n;
        if (skip > 0) return;
      }
      if (collect) {
        const padded = Math.ceil(collect.size / BLOCK) * BLOCK;
        if (buf.length < padded) return;
        const data = buf.subarray(0, collect.size);
        longName = collect.kind === 'L' ? readString(data, 0, data.length) : paxPath(data) ?? longName;
        buf = buf.subarray(padded);
        collect = null;
        continue;
      }
      if (buf.length < BLOCK) return;
      const header = buf.subarray(0, BLOCK);
      buf = buf.subarray(BLOCK);
      if (header.every((b) => b === 0)) {
        zeroBlocks++;
        if (zeroBlocks >= 2) ended = true;
        continue;
      }
      zeroBlocks = 0;
      if (!checksumOk(header)) throw new TarFormatError(`antet tar corupt după ${entries} intrări`);
      const typeflag = String.fromCharCode(header[156] || 48);
      const size = readSize(header);
      if (typeflag === 'L' || typeflag === 'x') {
        collect = { kind: typeflag, size };
        continue;
      }
      if (typeflag === 'g') {
        skip = Math.ceil(size / BLOCK) * BLOCK;
        continue;
      }
      let name = longName ?? readString(header, 0, 100);
      if (!longName && readString(header, 257, 5) === 'ustar') {
        const prefix = readString(header, 345, 155);
        if (prefix) name = `${prefix}/${name}`;
      }
      longName = null;
      const type: TarEntry['type'] = typeflag === '0' || typeflag === '7' ? 'file' : typeflag === '5' ? 'dir' : typeflag === '1' || typeflag === '2' ? 'link' : 'other';
      entries++;
      bytes += type === 'file' ? size : 0;
      onEntry({ name: name.replace(/^\.\//, ''), size, type });
      skip = type === 'file' || type === 'other' ? Math.ceil(size / BLOCK) * BLOCK : 0;
    }
  };

  for await (const chunk of source) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    process();
  }
  process();
  if (skip > 0 || collect) throw new TarFormatError('arhiva e trunchiată (se termină în mijlocul unui fișier)');
  if (!ended && entries === 0) throw new TarFormatError('arhiva e goală sau nu e în format tar');
  return { entries, bytes };
}
