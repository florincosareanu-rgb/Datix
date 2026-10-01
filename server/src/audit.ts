import type { AuditEntryDTO } from '@datix/shared';
import type { DB } from './db';
import { truncate } from './util/text';

export interface AuditInput {
  actor: 'owner' | 'agent' | 'system';
  action: string;
  context?: string | null;
  target?: string | null;
  details?: unknown;
  result?: string | null;
  ip?: string | null;
}

/** Jurnalul acțiunilor: tot ce face agentul sau proprietarul și modifică ceva rămâne aici. */
export class AuditService {
  constructor(private readonly db: DB) {}

  log(entry: AuditInput): void {
    const details =
      entry.details == null ? null : truncate(typeof entry.details === 'string' ? entry.details : JSON.stringify(entry.details), 4000);
    this.db
      .prepare('INSERT INTO audit_log (at, actor, context, action, target, details, result, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), entry.actor, entry.context ?? null, entry.action, entry.target ?? null, details, entry.result ?? null, entry.ip ?? null);
  }

  list(opts: { limit?: number; before?: number; actor?: string } = {}): AuditEntryDTO[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.before) {
      where.push('id < ?');
      params.push(opts.before);
    }
    if (opts.actor) {
      where.push('actor = ?');
      params.push(opts.actor);
    }
    const rows = this.db
      .prepare(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as Array<{
      id: number;
      at: number;
      actor: AuditEntryDTO['actor'];
      context: string | null;
      action: string;
      target: string | null;
      details: string | null;
      result: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      actor: r.actor,
      context: r.context,
      action: r.action,
      target: r.target,
      details: r.details,
      result: r.result,
    }));
  }
}
