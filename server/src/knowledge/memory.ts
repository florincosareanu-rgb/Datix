import type { DB } from '../db';
import { newId } from '../util/ids';

/** Notițe persistente ale agentului (ex. „clientul X are site pe Elementor”). */
export class MemoryStore {
  constructor(private readonly db: DB) {}

  add(content: string, source: string | null = null) {
    const id = newId('mem_');
    this.db.prepare('INSERT INTO memories (id, content, source, created_at) VALUES (?, ?, ?, ?)').run(id, content.trim().slice(0, 1000), source, Date.now());
    return id;
  }

  list(limit = 50): Array<{ id: string; content: string; source: string | null; createdAt: number }> {
    const rows = this.db.prepare('SELECT * FROM memories ORDER BY created_at DESC LIMIT ?').all(limit) as Array<{ id: string; content: string; source: string | null; created_at: number }>;
    return rows.map((r) => ({ id: r.id, content: r.content, source: r.source, createdAt: r.created_at }));
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
  }

  promptDigest(limit = 30): string {
    const items = this.list(limit);
    if (!items.length) return '';
    return items.map((m) => `- ${m.content}`).join('\n');
  }
}
