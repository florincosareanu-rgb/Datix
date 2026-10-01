import type { DB } from '../db';
import { sha256Hex } from '../crypto/hmac';
import { newId } from '../util/ids';

/** Copii ale fișierelor făcute automat înainte ca agentul să le modifice (pentru anulare). */
export class FileBackupStore {
  constructor(private readonly db: DB) {}

  save(target: string, path: string, content: Buffer, reason: string | null): string {
    const id = newId('fb_');
    this.db
      .prepare('INSERT INTO file_backups (id, target, path, content, sha256, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, target, path, content, sha256Hex(content), reason, Date.now());
    // păstrăm ultimele 20 de versiuni per fișier
    this.db
      .prepare(
        `DELETE FROM file_backups WHERE target = ? AND path = ? AND id NOT IN (
           SELECT id FROM file_backups WHERE target = ? AND path = ? ORDER BY created_at DESC LIMIT 20)`,
      )
      .run(target, path, target, path);
    return id;
  }

  get(id: string): { id: string; target: string; path: string; content: Buffer; createdAt: number; reason: string | null } | null {
    const r = this.db.prepare('SELECT * FROM file_backups WHERE id = ?').get(id) as
      | { id: string; target: string; path: string; content: Buffer; created_at: number; reason: string | null }
      | undefined;
    return r ? { id: r.id, target: r.target, path: r.path, content: r.content, createdAt: r.created_at, reason: r.reason } : null;
  }

  list(target?: string, path?: string, limit = 50) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (target) {
      where.push('target = ?');
      params.push(target);
    }
    if (path) {
      where.push('path = ?');
      params.push(path);
    }
    const rows = this.db
      .prepare(`SELECT id, target, path, length(content) size, reason, created_at FROM file_backups ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as Array<{ id: string; target: string; path: string; size: number; reason: string | null; created_at: number }>;
    return rows.map((r) => ({ id: r.id, target: r.target, path: r.path, sizeBytes: r.size, reason: r.reason, createdAt: r.created_at }));
  }
}
