import MiniSearch from 'minisearch';
import type { DB } from '../db';
import { newId } from '../util/ids';

export interface KbDoc {
  id: string;
  title: string;
  content: string;
  tags: string[];
  updatedAt: number;
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/**
 * Baza de cunoștințe a firmei (servicii, prețuri, proceduri, termeni). Agentul o folosește
 * ca să răspundă la tichete exact cum ar răspunde echipa Datix.
 */
export class KnowledgeBase {
  private index: MiniSearch<KbDoc> | null = null;

  constructor(private readonly db: DB) {}

  list(): KbDoc[] {
    const rows = this.db.prepare('SELECT * FROM kb_docs ORDER BY title').all() as Array<{ id: string; title: string; content: string; tags: string | null; updated_at: number }>;
    return rows.map((r) => ({ id: r.id, title: r.title, content: r.content, tags: r.tags ? r.tags.split(',').map((t) => t.trim()).filter(Boolean) : [], updatedAt: r.updated_at }));
  }

  get(id: string): KbDoc | null {
    return this.list().find((d) => d.id === id) ?? null;
  }

  upsert(doc: { id?: string; title: string; content: string; tags?: string[] }): KbDoc {
    const id = doc.id ?? newId('kb_');
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO kb_docs (id, title, content, tags, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content, tags = excluded.tags, updated_at = excluded.updated_at`,
      )
      .run(id, doc.title.trim().slice(0, 200), doc.content.slice(0, 100_000), (doc.tags ?? []).join(','), now);
    this.index = null;
    return { id, title: doc.title, content: doc.content, tags: doc.tags ?? [], updatedAt: now };
  }

  remove(id: string): boolean {
    this.index = null;
    return this.db.prepare('DELETE FROM kb_docs WHERE id = ?').run(id).changes > 0;
  }

  private getIndex(): MiniSearch<KbDoc> {
    if (this.index) return this.index;
    const ms = new MiniSearch<KbDoc>({
      fields: ['title', 'content', 'tagsText'],
      storeFields: ['title'],
      extractField: (doc, field) => (field === 'tagsText' ? doc.tags.join(' ') : String((doc as unknown as Record<string, unknown>)[field] ?? '')),
      processTerm: (term) => normalize(term),
      searchOptions: { boost: { title: 3, tagsText: 2 }, fuzzy: 0.2, prefix: true },
    });
    ms.addAll(this.list());
    this.index = ms;
    return ms;
  }

  search(query: string, limit = 5): Array<{ id: string; title: string; excerpt: string; score: number }> {
    const docs = new Map(this.list().map((d) => [d.id, d]));
    return this.getIndex()
      .search(query)
      .slice(0, limit)
      .map((r) => {
        const d = docs.get(String(r.id));
        const content = d?.content ?? '';
        const terms = r.terms.map(normalize);
        const norm = normalize(content);
        const pos = terms.map((t) => norm.indexOf(t)).filter((p) => p >= 0).sort((a, b) => a - b)[0] ?? 0;
        const start = Math.max(0, pos - 300);
        return { id: String(r.id), title: d?.title ?? '', excerpt: content.slice(start, start + 1500), score: Math.round(r.score * 100) / 100 };
      });
  }

  /** Textul complet (limitat) pentru promptul agentului de tichete. */
  promptDigest(maxChars = 20_000): string {
    const docs = this.list();
    if (!docs.length) return '';
    let out = '';
    for (const d of docs) {
      const block = `### ${d.title}\n${d.content.trim()}\n\n`;
      if (out.length + block.length > maxChars) {
        out += `\n(… încă ${docs.length - out.split('### ').length + 1} documente disponibile prin unealta kb_search)`;
        break;
      }
      out += block;
    }
    return out;
  }
}
