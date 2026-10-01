import Database from 'better-sqlite3';
import { join } from 'node:path';
import { MIGRATIONS } from './migrations';

export type DB = Database.Database;

export function openDatabase(dataDir: string, filename = 'datix.db'): DB {
  const db = new Database(filename === ':memory:' ? ':memory:' : join(dataDir, filename));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, Date.now());
    });
    tx();
  }
}

export function getMeta(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function deleteMeta(db: DB, key: string): void {
  db.prepare('DELETE FROM meta WHERE key = ?').run(key);
}

/** Copie consistentă a bazei de date (VACUUM INTO), folosită la backup-ul zilnic. */
export function backupDatabase(db: DB, targetPath: string): void {
  db.prepare('VACUUM INTO ?').run(targetPath);
}
