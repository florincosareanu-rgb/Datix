import type { ReportDTO } from '@datix/shared';
import { SEVERITY_LABEL, MONITOR_STATUS_LABEL } from '@datix/shared';
import type { Services } from '../services';
import { newId } from '../util/ids';
import { DAY, formatDateTimeRo, formatDurationRo, zonedDate } from '../util/time';
import { errorMessage, truncate } from '../util/text';

interface ReportRow {
  id: string;
  kind: ReportDTO['kind'];
  title: string;
  period_start: number;
  period_end: number;
  created_at: number;
  content: string;
}

const toDTO = (r: ReportRow): ReportDTO => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  createdAt: r.created_at,
  content: r.content,
});

/** Raportul zilnic (dimineața): disponibilitate, incidente, securitate, tichete, business, costuri AI. */
export class ReportService {
  constructor(private readonly s: Services) {}

  list(limit = 30): ReportDTO[] {
    return (this.s.db.prepare('SELECT * FROM reports ORDER BY created_at DESC LIMIT ?').all(limit) as ReportRow[]).map(toDTO);
  }

  get(id: string): ReportDTO | null {
    const r = this.s.db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as ReportRow | undefined;
    return r ? toDTO(r) : null;
  }

  /** Datele raportului, calculate determinist (fără AI). */
  collect(periodStart: number, periodEnd: number) {
    const s = this.s;
    const hours = Math.round((periodEnd - periodStart) / 3_600_000);
    const sites = s.monitoring.uptimeReport(hours);
    const incidents = (
      s.db.prepare('SELECT id, title, severity, status, opened_at, resolved_at, root_cause FROM incidents WHERE opened_at >= ? AND opened_at < ? ORDER BY opened_at').all(periodStart, periodEnd) as Array<{
        id: string;
        title: string;
        severity: string;
        status: string;
        opened_at: number;
        resolved_at: number | null;
        root_cause: string | null;
      }>
    ).map((i) => ({ ...i, duration: i.resolved_at ? formatDurationRo(i.resolved_at - i.opened_at) : 'în curs' }));
    const newFindings = s.db
      .prepare("SELECT severity, title FROM findings WHERE first_seen_at >= ? AND first_seen_at < ? ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END")
      .all(periodStart, periodEnd) as Array<{ severity: string; title: string }>;
    const openCounts = s.findings.countsBySeverity();
    const tickets = s.db.prepare('SELECT status, COUNT(*) n FROM ticket_jobs WHERE created_at >= ? AND created_at < ? GROUP BY status').all(periodStart, periodEnd) as Array<{ status: string; n: number }>;
    const business = s.business.latest();
    const usage = s.llm.usageSummary();
    const dayCost = (s.db.prepare('SELECT COALESCE(SUM(cost_usd),0) c FROM llm_usage WHERE at >= ? AND at < ?').get(periodStart, periodEnd) as { c: number }).c;
    const monitors = s.monitoring.listMonitors().filter((m) => m.status === 'down' || m.status === 'degraded').map((m) => ({ name: m.name, status: m.status, message: m.lastMessage }));
    const pendingApprovals = s.approvals.pendingCount();
    return { sites, incidents, newFindings, openCounts, tickets, business, usage, dayCost, monitors, pendingApprovals };
  }

  render(data: ReturnType<ReportService['collect']>, tz: string): string {
    const lines: string[] = [];
    lines.push('## 🌐 Disponibilitate (24 h)');
    if (!data.sites.length) lines.push('_Niciun site monitorizat._');
    for (const site of data.sites) {
      lines.push(`- **${site.monitor}**: ${site.uptimePct != null ? `${site.uptimePct}%` : '—'} disponibil, timp mediu de răspuns ${site.avgResponseMs != null ? `${(site.avgResponseMs / 1000).toFixed(2)} s` : '—'}${site.failedChecks ? `, ${site.failedChecks} verificări eșuate` : ''}`);
    }
    lines.push('', '## 🚨 Incidente');
    if (!data.incidents.length) lines.push('Niciun incident. ✅');
    for (const i of data.incidents) lines.push(`- ${formatDateTimeRo(i.opened_at, tz)} — **${i.title}** (${SEVERITY_LABEL[i.severity] ?? i.severity}, ${i.duration})${i.root_cause ? `: ${truncate(i.root_cause, 160)}` : ''}`);
    if (data.monitors.length) {
      lines.push('', '**Probleme active acum:**');
      for (const m of data.monitors) lines.push(`- ${m.name}: ${MONITOR_STATUS_LABEL[m.status]} — ${m.message ?? ''}`);
    }
    lines.push('', '## 🔒 Securitate');
    const oc = data.openCounts;
    lines.push(`Probleme deschise: ${oc.critical} critice, ${oc.high} ridicate, ${oc.medium} medii, ${oc.low} scăzute.`);
    if (data.newFindings.length) {
      lines.push('**Noi în ultimele 24 h:**');
      for (const f of data.newFindings.slice(0, 8)) lines.push(`- [${SEVERITY_LABEL[f.severity] ?? f.severity}] ${f.title}`);
    }
    lines.push('', '## 🎫 Tichete');
    if (!data.tickets.length) lines.push('Niciun tichet nou procesat.');
    else {
      const map: Record<string, string> = { sent: 'răspunse automat/aprobate', draft_ready: 'ciorne în așteptare', escalated: 'trimise la tine', skipped: 'doar notificate', error: 'cu erori', discarded: 'ignorate', queued: 'în coadă', analyzing: 'în analiză' };
      lines.push(data.tickets.map((t) => `${t.n} ${map[t.status] ?? t.status}`).join(' · '));
    }
    if (data.business) {
      const b = data.business;
      const fmt = (n: number | null) => (n == null ? '—' : `${b.currencyPrefix}${n.toLocaleString('ro-RO', { maximumFractionDigits: 2 })}${b.currencySuffix}`);
      lines.push('', '## 💼 Business');
      lines.push(`- Încasări azi: ${fmt(b.incomeToday)} · luna aceasta: ${fmt(b.incomeThisMonth)} · anul acesta: ${fmt(b.incomeThisYear)}`);
      lines.push(`- Comenzi în așteptare: ${b.ordersPending ?? '—'} · facturi neplătite: ${b.unpaidInvoices ?? '—'} (${fmt(b.unpaidTotal)}) · restante: ${b.overdueInvoices ?? '—'}`);
      if (b.domainsExpiringSoon) lines.push(`- Domenii de clienți care expiră în 30 de zile: ${b.domainsExpiringSoon}`);
      if (b.cancellationsPending) lines.push(`- Cereri de anulare în așteptare: ${b.cancellationsPending}`);
    }
    lines.push('', '## 🤖 Agent');
    lines.push(`Cost AI ieri: ${data.dayCost.toFixed(4)} $ · luna aceasta: ${data.usage.monthCostUsd.toFixed(4)} $ din bugetul de ${data.usage.monthBudgetUsd.toFixed(2)} $.`);
    if (data.pendingApprovals) lines.push(`⏳ ${data.pendingApprovals} acțiuni așteaptă aprobarea ta.`);
    return lines.join('\n');
  }

  async generateDaily(now = Date.now()): Promise<ReportDTO> {
    const tz = this.s.settings.get().general.timezone;
    const periodEnd = now;
    const periodStart = now - DAY;
    const data = this.collect(periodStart, periodEnd);
    let body = this.render(data, tz);
    if (this.s.llm.isAvailable() && !this.s.llm.budgetExceeded()) {
      try {
        const summary = await this.s.llm.complete(
          {
            model: this.s.settings.get().llm.model,
            thinking: false,
            maxTokens: 600,
            messages: [
              {
                role: 'system',
                content:
                  'Ești asistentul de operațiuni al unei firme de hosting. Scrie în română 2–4 puncte scurte (Markdown, liste) cu ce contează azi pentru proprietar și ce ar trebui să facă, pe baza raportului. Fără introducere. Dacă totul e în regulă, spune asta într-o propoziție.',
              },
              { role: 'user', content: body },
            ],
          },
          'report',
        );
        if (summary) body = `## ✨ Pe scurt\n${summary}\n\n${body}`;
      } catch (err) {
        this.s.log.warn({ err: errorMessage(err) }, 'Rezumatul AI al raportului a eșuat');
      }
    }
    const id = newId('rep_');
    const title = `Raport zilnic — ${zonedDate(now, tz)}`;
    this.s.db.prepare('INSERT INTO reports (id, kind, title, period_start, period_end, created_at, content, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      'daily',
      title,
      periodStart,
      periodEnd,
      Date.now(),
      body,
      JSON.stringify(data),
    );
    const problems = data.incidents.length + data.newFindings.filter((f) => f.severity === 'critical' || f.severity === 'high').length;
    void this.s.notifier.notify({
      kind: 'report',
      title: '☀️ Raportul de azi e gata',
      body: problems ? `${data.incidents.length} incidente, ${data.newFindings.length} constatări noi de securitate. Deschide pentru detalii.` : 'Totul a mers bine în ultimele 24 de ore. ✅',
      priority: 'low',
      url: `/rapoarte/${id}`,
    });
    this.s.db.prepare('DELETE FROM reports WHERE created_at < ?').run(Date.now() - 365 * DAY);
    return this.get(id)!;
  }
}
