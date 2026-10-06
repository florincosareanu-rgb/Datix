import type { DB } from '../db';
import { safeJsonParse } from '../util/text';
import { DAY } from '../util/time';

// Analizele calculate periodic (încasări, clienți în risc, SEO): păstrăm istoricul scurt, folosim ultima.

export function saveInsight(db: DB, kind: string, data: unknown, keepDays = 120): number {
  const at = Date.now();
  db.prepare('INSERT OR REPLACE INTO insights (kind, generated_at, data) VALUES (?, ?, ?)').run(kind, at, JSON.stringify(data));
  db.prepare('DELETE FROM insights WHERE kind = ? AND generated_at < ?').run(kind, at - keepDays * DAY);
  return at;
}

export function latestInsight<T>(db: DB, kind: string): { at: number; data: T } | null {
  const row = db.prepare('SELECT generated_at, data FROM insights WHERE kind = ? ORDER BY generated_at DESC LIMIT 1').get(kind) as { generated_at: number; data: string } | undefined;
  if (!row) return null;
  const data = safeJsonParse<T | null>(row.data, null);
  return data ? { at: row.generated_at, data } : null;
}
