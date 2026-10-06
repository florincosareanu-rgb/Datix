import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { S3Client, type S3Object } from '../integrations/s3';

// Unde păstrează DAX copiile backup-urilor: un bucket S3/R2 sau un director pe serverul DAX (VPS).

export interface BackupStorage {
  readonly label: string;
  upload(name: string, source: AsyncIterable<Buffer>): Promise<{ key: string; sizeBytes: number }>;
  list(): Promise<S3Object[]>;
  delete(key: string): Promise<void>;
  test(): Promise<string>;
}

const BACKUP_NAME = /\.(tar(\.gz|\.zst)?)(\.enc)?$/;

export class S3Storage implements BackupStorage {
  readonly label: string;

  constructor(
    private readonly client: S3Client,
    private readonly prefix: string,
    bucket: string,
  ) {
    this.label = `bucket „${bucket}”`;
  }

  async upload(name: string, source: AsyncIterable<Buffer>) {
    const key = `${this.prefix}${name}`;
    const r = await this.client.upload(key, source);
    return { key, sizeBytes: r.sizeBytes };
  }

  async list() {
    return (await this.client.list(this.prefix)).filter((o) => BACKUP_NAME.test(o.key));
  }

  delete(key: string) {
    if (!key.startsWith(this.prefix)) throw new Error('Cheie în afara prefixului backup-urilor.');
    return this.client.deleteObject(key);
  }

  test() {
    return this.client.test(this.prefix);
  }
}

export class LocalStorage implements BackupStorage {
  readonly label: string;

  constructor(private readonly dir: string) {
    this.label = 'serverul DAX (VPS)';
  }

  async upload(name: string, source: AsyncIterable<Buffer>) {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `.${name}.partial`);
    const out = createWriteStream(tmp, { mode: 0o600 });
    let size = 0;
    try {
      for await (const chunk of source) {
        size += chunk.length;
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      await rename(tmp, join(this.dir, name));
    } catch (err) {
      out.destroy();
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    return { key: name, sizeBytes: size };
  }

  async list() {
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: S3Object[] = [];
    for (const name of names.filter((n) => BACKUP_NAME.test(n) && !n.startsWith('.'))) {
      const st = await stat(join(this.dir, name));
      out.push({ key: name, sizeBytes: st.size, lastModified: st.mtimeMs });
    }
    return out;
  }

  async delete(key: string) {
    if (key.includes('/') || key.includes('..')) throw new Error('Nume de fișier invalid.');
    await unlink(join(this.dir, key)).catch(() => undefined);
  }

  async test() {
    await mkdir(this.dir, { recursive: true });
    const probe = join(this.dir, `.dax-test-${Date.now()}`);
    await writeFile(probe, 'DAX test');
    await unlink(probe);
    const existing = await this.list();
    return `Directorul ${this.dir} pe serverul DAX poate fi scris. Copii existente: ${existing.length}.`;
  }
}
