import type { IncidentDTO, IncidentEventDTO, IncidentStatus, Severity } from '@datix/shared';
import type { Services } from '../services';
import { newId } from '../util/ids';
import { formatDurationRo, MINUTE, HOUR } from '../util/time';
import { errorMessage, truncate } from '../util/text';
import type { IncidentReport } from '../agent/tools/submit';

interface IncidentRow {
  id: string;
  monitor_id: string | null;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  opened_at: number;
  resolved_at: number | null;
  summary: string | null;
  root_cause: string | null;
  postmortem: string | null;
  conversation_id: string | null;
  last_notified_at: number | null;
  notify_count: number;
}

const toDTO = (r: IncidentRow): IncidentDTO => ({
  id: r.id,
  monitorId: r.monitor_id,
  title: r.title,
  severity: r.severity,
  status: r.status,
  openedAt: r.opened_at,
  resolvedAt: r.resolved_at,
  summary: r.summary,
  rootCause: r.root_cause,
  postmortem: r.postmortem,
  conversationId: r.conversation_id,
  durationSec: r.resolved_at ? Math.round((r.resolved_at - r.opened_at) / 1000) : null,
});

/** Ciclul de viață al incidentelor: deschidere → investigare automată → rezolvare → raport. */
export class IncidentService {
  private investigating = new Set<string>();

  constructor(private readonly s: Services) {}

  private row(id: string): IncidentRow | null {
    return (this.s.db.prepare('SELECT * FROM incidents WHERE id = ?').get(id) as IncidentRow | undefined) ?? null;
  }

  get(id: string): IncidentDTO | null {
    const r = this.row(id);
    return r ? toDTO(r) : null;
  }

  list(opts: { status?: 'active' | 'all'; limit?: number } = {}): IncidentDTO[] {
    const rows =
      opts.status === 'active'
        ? (this.s.db.prepare("SELECT * FROM incidents WHERE status != 'resolved' ORDER BY opened_at DESC LIMIT ?").all(opts.limit ?? 50) as IncidentRow[])
        : (this.s.db.prepare('SELECT * FROM incidents ORDER BY opened_at DESC LIMIT ?').all(opts.limit ?? 50) as IncidentRow[]);
    return rows.map(toDTO);
  }

  activeForMonitor(monitorId: string): IncidentDTO | null {
    const r = this.s.db.prepare("SELECT * FROM incidents WHERE monitor_id = ? AND status != 'resolved' ORDER BY opened_at DESC LIMIT 1").get(monitorId) as IncidentRow | undefined;
    return r ? toDTO(r) : null;
  }

  events(id: string): IncidentEventDTO[] {
    return (this.s.db.prepare('SELECT id, at, kind, message FROM incident_events WHERE incident_id = ? ORDER BY at, id').all(id) as IncidentEventDTO[]).map((e) => e);
  }

  addEvent(id: string, kind: string, message: string, data?: unknown): void {
    this.s.db
      .prepare('INSERT INTO incident_events (incident_id, at, kind, message, data) VALUES (?, ?, ?, ?, ?)')
      .run(id, Date.now(), kind, truncate(message, 2000), data === undefined ? null : truncate(JSON.stringify(data), 8000));
  }

  private emit(id: string): void {
    const dto = this.get(id);
    if (dto) this.s.bus.emit({ type: 'incident', incident: dto });
  }

  open(input: { monitorId: string | null; title: string; severity: Severity; details: string; data?: unknown }): IncidentDTO {
    const id = newId('inc_');
    const now = Date.now();
    this.s.db
      .prepare('INSERT INTO incidents (id, monitor_id, title, severity, status, opened_at, summary, last_notified_at, notify_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)')
      .run(id, input.monitorId, input.title, input.severity, 'open', now, input.details, now);
    this.addEvent(id, 'detected', input.details, input.data);
    this.s.audit.log({ actor: 'system', action: 'incident.opened', target: input.title, details: input.details });
    this.emit(id);
    void this.s.notifier.notify({
      kind: 'incident',
      title: `${input.severity === 'critical' ? '🔴' : '🟠'} ${input.title}`,
      body: truncate(input.details, 220),
      priority: input.severity === 'critical' ? 'critical' : 'high',
      url: `/incidente/${id}`,
      dedupeKey: `incident-open:${id}`,
    });
    const st = this.s.settings.get();
    if (st.monitoring.autoInvestigate && this.s.llm.isAvailable() && (input.severity === 'critical' || input.severity === 'high')) {
      void this.investigate(id).catch((err) => this.s.log.error({ err }, 'Investigarea incidentului a eșuat'));
    }
    return this.get(id)!;
  }

  setStatus(id: string, status: IncidentStatus, note?: string): void {
    this.s.db.prepare('UPDATE incidents SET status = ? WHERE id = ?').run(status, id);
    if (note) this.addEvent(id, 'status', note);
    this.emit(id);
  }

  resolve(id: string, how: string): void {
    const r = this.row(id);
    if (!r || r.status === 'resolved') return;
    const now = Date.now();
    this.s.db.prepare("UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ?").run(now, id);
    this.addEvent(id, 'resolved', how);
    this.s.audit.log({ actor: 'system', action: 'incident.resolved', target: r.title, details: how });
    this.emit(id);
    const duration = formatDurationRo(now - r.opened_at);
    void this.s.notifier.notify({
      kind: 'incident_resolved',
      title: `🟢 Rezolvat: ${r.title}`,
      body: `Durată: ${duration}. ${truncate(r.root_cause ?? how, 160)}`,
      priority: 'normal',
      url: `/incidente/${id}`,
      dedupeKey: `incident-resolved:${id}`,
    });
    if (this.s.llm.isAvailable()) void this.writePostmortem(id).catch((err) => this.s.log.warn({ err }, 'Post-mortem eșuat'));
  }

  /** Investigația automată: agentul primește incidentul și lucrează conform procedurii. */
  async investigate(id: string): Promise<void> {
    const inc = this.row(id);
    if (!inc || this.investigating.has(id)) return;
    this.investigating.add(id);
    try {
      const convId = inc.conversation_id ?? this.s.conversations.create('incident', `Incident: ${inc.title}`, id);
      if (!inc.conversation_id) this.s.db.prepare('UPDATE incidents SET conversation_id = ? WHERE id = ?').run(convId, id);
      this.setStatus(id, 'investigating', 'Agentul a început investigația.');
      const monitor = inc.monitor_id ? this.s.monitoring.getMonitor(inc.monitor_id) : null;
      const events = this.events(id)
        .slice(-5)
        .map((e) => `- ${new Date(e.at).toISOString()}: ${e.message}`)
        .join('\n');
      this.s.conversations.append({
        conversationId: convId,
        role: 'user',
        content: `INCIDENT DETECTAT AUTOMAT (ID ${id})
Problemă: ${inc.title}
Gravitate: ${inc.severity}
Monitor: ${monitor ? `${monitor.name} (${monitor.target})` : 'necunoscut'}
Ultimele observații:
${events}

Investighează cauza, aplică remedierile sigure permise și verifică rezultatul. La final apelează incident_report.`,
      });
      const outcome = await this.s.agent.run({ conversationId: convId, context: 'incident', trigger: `incident:${id}` });
      const report = outcome.outcomes.incident_report as IncidentReport | undefined;
      if (report) {
        this.s.db.prepare('UPDATE incidents SET summary = ?, root_cause = ? WHERE id = ?').run(report.summary, report.root_cause, id);
        this.addEvent(id, 'agent_report', `${report.summary}\nAcțiuni: ${report.actions_taken.join('; ') || 'niciuna'}`, report);
        const current = this.row(id);
        if (current && current.status !== 'resolved') {
          if (report.status === 'mitigated' || report.status === 'resolved') this.setStatus(id, 'mitigated');
          else if (report.status === 'false_alarm') this.setStatus(id, 'mitigated', 'Agentul consideră că a fost o alarmă falsă.');
          else this.setStatus(id, 'open', 'Agentul are nevoie de intervenția ta.');
        }
        // confirmăm imediat dacă serviciul și-a revenit
        if (inc.monitor_id) void this.s.monitoring.runNow(inc.monitor_id).catch(() => undefined);
        const needsHuman = report.status === 'needs_human';
        void this.s.notifier.notify({
          kind: 'incident',
          title: needsHuman ? `🧑‍🔧 Am nevoie de tine: ${inc.title}` : `🤖 Investigație încheiată: ${inc.title}`,
          body: truncate(report.summary, 220),
          priority: needsHuman ? 'critical' : 'high',
          url: `/incidente/${id}`,
          dedupeKey: `incident-report:${id}:${outcome.runId}`,
        });
      } else if (outcome.status === 'waiting_approval') {
        this.addEvent(id, 'waiting_approval', 'Agentul așteaptă aprobarea ta pentru o acțiune.');
      } else if (outcome.status === 'error') {
        this.addEvent(id, 'agent_error', `Investigația s-a oprit: ${outcome.error ?? 'eroare'}`);
        this.setStatus(id, 'open');
      } else {
        this.addEvent(id, 'agent_done', truncate(outcome.finalText || 'Agentul a terminat fără raport.', 2000));
      }
      this.emit(id);
    } catch (err) {
      this.addEvent(id, 'agent_error', `Investigația nu a putut porni: ${errorMessage(err)}`);
    } finally {
      this.investigating.delete(id);
    }
  }

  private async writePostmortem(id: string): Promise<void> {
    const inc = this.row(id);
    if (!inc) return;
    const timeline = this.events(id)
      .map((e) => `${new Date(e.at).toISOString()} [${e.kind}] ${e.message}`)
      .join('\n');
    const text = await this.s.llm.complete(
      {
        model: this.s.settings.get().llm.model,
        thinking: false,
        maxTokens: 1200,
        messages: [
          {
            role: 'system',
            content:
              'Scrii raportul post-incident (post-mortem) pentru proprietarul unei firme de hosting, în română, în Markdown, scurt: **Ce s-a întâmplat**, **Cauza**, **Cum s-a rezolvat**, **Durata**, **Cum prevenim** (1-3 recomandări concrete). Nu inventa detalii care nu apar în cronologie.',
          },
          { role: 'user', content: `Incident: ${inc.title}\nGravitate: ${inc.severity}\nDeschis: ${new Date(inc.opened_at).toISOString()}\nRezolvat: ${inc.resolved_at ? new Date(inc.resolved_at).toISOString() : '-'}\nCauză (dacă e cunoscută): ${inc.root_cause ?? '-'}\n\nCronologie:\n${truncate(timeline, 12000)}` },
        ],
      },
      'report',
    );
    this.s.db.prepare('UPDATE incidents SET postmortem = ? WHERE id = ?').run(text, id);
    this.emit(id);
  }

  /** Reamintiri pentru incidentele nerezolvate (la 10 min, apoi tot mai rar, maxim la 2 h). */
  escalate(): void {
    const st = this.s.settings.get().monitoring;
    const rows = this.s.db.prepare("SELECT * FROM incidents WHERE status != 'resolved'").all() as IncidentRow[];
    const now = Date.now();
    for (const r of rows) {
      const interval = Math.min(st.escalateAfterMin * MINUTE * 2 ** Math.max(0, r.notify_count - 1), 2 * HOUR);
      if (r.last_notified_at && now - r.last_notified_at < interval) continue;
      this.s.db.prepare('UPDATE incidents SET last_notified_at = ?, notify_count = notify_count + 1 WHERE id = ?').run(now, r.id);
      void this.s.notifier.notify({
        kind: 'incident',
        title: `⏰ Încă nerezolvat: ${r.title}`,
        body: `De ${formatDurationRo(now - r.opened_at)}. ${r.status === 'investigating' ? 'Agentul lucrează la el.' : 'Deschide aplicația pentru detalii.'}`,
        priority: r.severity === 'critical' ? 'critical' : 'high',
        url: `/incidente/${r.id}`,
      });
    }
  }
}
