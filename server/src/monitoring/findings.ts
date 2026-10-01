import { SEVERITY_ORDER, type FindingDTO, type FindingStatus, type Severity } from '@datix/shared';
import type { Services } from '../services';
import { newId } from '../util/ids';

interface FindingRow {
  id: string;
  source: string;
  key: string;
  severity: Severity;
  title: string;
  details: string | null;
  recommendation: string | null;
  status: FindingStatus;
  first_seen_at: number;
  last_seen_at: number;
  resolved_at: number | null;
  notified: number;
}

export interface FindingInput {
  key: string;
  severity: Severity;
  title: string;
  details?: string | null;
  recommendation?: string | null;
}

const toDTO = (r: FindingRow): FindingDTO => ({
  id: r.id,
  source: r.source,
  severity: r.severity,
  title: r.title,
  details: r.details,
  recommendation: r.recommendation,
  status: r.status,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  resolvedAt: r.resolved_at,
});

/** Problemele de securitate / configurare găsite de scanări, cu deduplicare și rezolvare automată. */
export class FindingsService {
  constructor(private readonly s: Services) {}

  list(opts: { status?: FindingStatus; source?: string } = {}): FindingDTO[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    if (opts.source) {
      where.push('source = ?');
      params.push(opts.source);
    }
    const rows = this.s.db.prepare(`SELECT * FROM findings ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY last_seen_at DESC LIMIT 500`).all(...params) as FindingRow[];
    return rows.map(toDTO).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.lastSeenAt - a.lastSeenAt);
  }

  get(id: string): FindingDTO | null {
    const r = this.s.db.prepare('SELECT * FROM findings WHERE id = ?').get(id) as FindingRow | undefined;
    return r ? toDTO(r) : null;
  }

  countsBySeverity(): Record<Severity, number> {
    const out: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    const rows = this.s.db.prepare("SELECT severity, COUNT(*) n FROM findings WHERE status = 'open' GROUP BY severity").all() as Array<{ severity: Severity; n: number }>;
    for (const r of rows) out[r.severity] = r.n;
    return out;
  }

  /**
   * Raportează constatările curente ale unei surse. Cele noi se deschid (și se notifică dacă sunt grave),
   * cele care nu mai apar se marchează rezolvate. `scopePrefix` limitează rezolvarea automată la o parte a sursei.
   */
  report(source: string, current: FindingInput[], opts: { scopePrefix?: string; notifyFrom?: Severity } = {}): { opened: FindingDTO[]; resolved: number } {
    const now = Date.now();
    const notifyFrom = opts.notifyFrom ?? 'high';
    const opened: FindingDTO[] = [];
    const seen = new Set<string>();
    const tx = this.s.db.transaction(() => {
      for (const f of current) {
        const key = `${source}:${f.key}`;
        seen.add(key);
        const existing = this.s.db.prepare('SELECT * FROM findings WHERE key = ?').get(key) as FindingRow | undefined;
        if (!existing) {
          const id = newId('f_');
          this.s.db
            .prepare(
              `INSERT INTO findings (id, source, key, severity, title, details, recommendation, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
            )
            .run(id, source, key, f.severity, f.title, f.details ?? null, f.recommendation ?? null, now, now);
          opened.push(this.get(id)!);
        } else if (existing.status === 'ignored') {
          this.s.db.prepare('UPDATE findings SET last_seen_at = ?, details = ? WHERE id = ?').run(now, f.details ?? existing.details, existing.id);
        } else {
          const reopened = existing.status === 'resolved';
          this.s.db
            .prepare(`UPDATE findings SET severity = ?, title = ?, details = ?, recommendation = ?, status = 'open', last_seen_at = ?, resolved_at = NULL, notified = ? WHERE id = ?`)
            .run(f.severity, f.title, f.details ?? null, f.recommendation ?? null, now, reopened ? 0 : existing.notified, existing.id);
          if (reopened) opened.push(this.get(existing.id)!);
        }
      }
    });
    tx();
    // rezolvăm automat ce nu mai apare; evenimentele (cheie cu „:event:”) rămân deschise până le confirmi tu
    const prefix = `${source}:${opts.scopePrefix ?? ''}`;
    const stillOpen = this.s.db.prepare("SELECT * FROM findings WHERE source = ? AND status = 'open' AND key LIKE ?").all(source, `${prefix}%`) as FindingRow[];
    let resolved = 0;
    for (const r of stillOpen) {
      if (r.key.includes(':event:')) continue;
      if (!seen.has(r.key)) {
        this.s.db.prepare("UPDATE findings SET status = 'resolved', resolved_at = ? WHERE id = ?").run(now, r.id);
        resolved++;
        const dto = this.get(r.id);
        if (dto) this.s.bus.emit({ type: 'finding', finding: dto });
      }
    }
    for (const f of opened) {
      this.s.bus.emit({ type: 'finding', finding: f });
      if (SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER[notifyFrom]) {
        this.s.db.prepare('UPDATE findings SET notified = 1 WHERE id = ?').run(f.id);
        void this.s.notifier.notify({
          kind: 'security',
          title: `${f.severity === 'critical' ? '🚨' : '⚠️'} ${f.title}`,
          body: f.recommendation ?? f.details ?? 'Detalii în aplicație.',
          priority: f.severity === 'critical' ? 'critical' : 'high',
          url: `/securitate?id=${f.id}`,
          dedupeKey: `finding:${f.id}`,
        });
      }
    }
    return { opened, resolved };
  }

  setStatus(id: string, status: FindingStatus): FindingDTO | null {
    this.s.db.prepare('UPDATE findings SET status = ?, resolved_at = ? WHERE id = ?').run(status, status === 'resolved' ? Date.now() : null, id);
    const dto = this.get(id);
    if (dto) this.s.bus.emit({ type: 'finding', finding: dto });
    return dto;
  }
}
