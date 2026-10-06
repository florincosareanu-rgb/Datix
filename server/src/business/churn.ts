import type { ChurnClientDTO, ChurnReportDTO, ChurnSignalDTO } from '@datix/shared';
import type { Services } from '../services';
import { errorMessage, safeJsonParse } from '../util/text';
import { DAY, zonedDate } from '../util/time';
import { latestInsight, saveInsight } from './insights';
import { annualize, formatMoney } from './money';
import { daysBetween } from './collections';

// Clienți care s-ar putea să plece: semnale din WHMCS (anulări, servicii suspendate, facturi restante,
// domenii nereînnoite) și din tichete (nemulțumire, multe probleme). Scor 0–100, cu acțiune propusă.

type Draft = { clientId: number; name: string; email: string | null; company: string | null; signals: ChurnSignalDTO[]; annual: number };

const SUGGESTION: Record<string, string> = {
  cancellation_request: 'Sună clientul înainte de procesarea anulării: află motivul și propune o soluție (alt pachet, migrare asistată, o lună gratuită).',
  service_suspended: 'Serviciul e suspendat pentru neplată: un mesaj personal cu linkul de plată și, la nevoie, eșalonare.',
  negative_ticket: 'A fost nemulțumit recent: un telefon scurt de la tine, ca să închizi frumos problema.',
  many_tickets: 'A avut multe probleme luna aceasta: verifică dacă pachetul i se potrivește și dacă problemele au fost rezolvate la rădăcină.',
  domain_not_renewing: 'Domeniul nu se reînnoiește: întreabă-l dacă îl mai folosește — fără domeniu cad și site-ul, și e-mailul.',
  overdue_invoice: 'Are o factură restantă: verifică dacă a primit reamintirile și dacă are probleme la plată.',
};

function level(score: number): ChurnClientDTO['level'] {
  return score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low';
}

export class ChurnService {
  private running: Promise<ChurnReportDTO> | null = null;

  constructor(private readonly s: Services) {}

  latest(): ChurnReportDTO {
    const available = this.s.integrations.isConfigured('whmcs');
    const insight = latestInsight<Omit<ChurnReportDTO, 'available' | 'message' | 'generatedAt'>>(this.s.db, 'churn');
    if (!insight) {
      return {
        available,
        message: available ? 'Analiza nu a rulat încă. Apasă „Analizează acum”.' : 'Conectează WHMCS (Setări → Integrări) pentru analiza clienților.',
        generatedAt: null,
        currencyPrefix: '',
        currencySuffix: ' RON',
        totals: { high: 0, medium: 0, valueAtRisk: 0, analyzed: 0 },
        clients: [],
      };
    }
    return { ...insight.data, available, message: null, generatedAt: insight.at };
  }

  analyze(trigger: 'schedule' | 'manual' | 'agent' = 'manual'): Promise<ChurnReportDTO> {
    this.running ??= this.doAnalyze(trigger).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doAnalyze(trigger: string): Promise<ChurnReportDTO> {
    const w = this.s.integrations.whmcs();
    if (!w) return this.latest();
    const tz = this.s.settings.get().general.timezone;
    const today = zonedDate(Date.now(), tz);
    const [products, domains, overdue] = await Promise.all([w.getClientProducts(undefined, 1000), w.getClientDomains(undefined, 1000), w.getInvoices({ status: 'Overdue', limitnum: 500 })]);
    let prefix = '';
    let suffix = '';
    const clients = new Map<number, Draft>();
    const get = (id: number, name = ''): Draft => {
      let c = clients.get(id);
      if (!c) {
        c = { clientId: id, name, email: null, company: null, signals: [], annual: 0 };
        clients.set(id, c);
      }
      if (!c.name && name) c.name = name;
      return c;
    };
    const add = (id: number, code: string, label: string, weight: number) => {
      const c = get(id);
      const existing = c.signals.find((x) => x.code === code);
      if (existing) {
        existing.weight = Math.max(existing.weight, weight);
        if (!existing.label.includes(label)) existing.label = `${existing.label}; ${label}`;
      } else c.signals.push({ code, label, weight });
    };

    // valoarea anuală (servicii active + domenii)
    for (const p of products.products) {
      if (/active/i.test(p.status)) get(p.clientId).annual += annualize(Number(p.recurringAmount) || 0, p.billingCycle);
      if (/suspended/i.test(p.status)) add(p.clientId, 'service_suspended', `serviciul „${p.name}” e suspendat${p.suspensionReason ? ` (${p.suspensionReason})` : ''}`, 35);
    }
    for (const d of domains.domains) {
      if (!/active/i.test(d.status)) continue;
      get(d.clientId).annual += Number(d.recurringAmount) || 0;
      if (d.doNotRenew) add(d.clientId, 'domain_not_renewing', `domeniul ${d.domain} e setat să nu se reînnoiască`, 25);
      else if (d.expiryDate && daysBetween(today, d.expiryDate) <= 21 && daysBetween(today, d.expiryDate) >= 0 && (!d.nextDueDate || daysBetween(d.expiryDate, d.nextDueDate) <= 30)) {
        add(d.clientId, 'domain_not_renewing', `domeniul ${d.domain} expiră în ${daysBetween(today, d.expiryDate)} zile, fără reînnoire plătită`, 15);
      }
    }
    for (const inv of overdue.invoices) {
      prefix ||= inv.currencyPrefix;
      suffix ||= inv.currencySuffix;
      const days = inv.dueDate ? daysBetween(inv.dueDate, today) : 0;
      if (days < 1) continue;
      get(inv.clientId, inv.clientName);
      add(inv.clientId, 'overdue_invoice', `factura ${inv.number} restantă de ${days} zile`, days > 30 ? 30 : 20);
    }

    // cereri de anulare (hook-ul WHMCS) din ultimele 90 de zile
    const cancellations = this.s.db.prepare("SELECT data FROM events_inbox WHERE source = 'whmcs' AND event = 'cancellation.request' AND at > ?").all(Date.now() - 90 * DAY) as Array<{ data: string }>;
    for (const c of cancellations) {
      const d = safeJsonParse<{ userid?: number; reason?: string | null }>(c.data, {});
      if (d.userid) add(Number(d.userid), 'cancellation_request', `a cerut anularea unui serviciu${d.reason ? `: „${d.reason.slice(0, 80)}”` : ''}`, 60);
    }

    // tichetele din ultimele 60 de zile
    const tickets = this.s.db
      .prepare(
        `SELECT t.client_id, t.client_name, t.email, j.sentiment, j.escalation_reasons, j.created_at
         FROM ticket_jobs j JOIN tickets t ON t.id = j.ticket_id WHERE j.created_at > ? AND t.client_id IS NOT NULL`,
      )
      .all(Date.now() - 60 * DAY) as Array<{ client_id: number; client_name: string | null; email: string | null; sentiment: string | null; escalation_reasons: string | null; created_at: number }>;
    const recentCount = new Map<number, number>();
    for (const t of tickets) {
      const c = get(t.client_id, t.client_name ?? '');
      c.email ??= t.email;
      if (t.created_at > Date.now() - 30 * DAY) recentCount.set(t.client_id, (recentCount.get(t.client_id) ?? 0) + 1);
      const reasons = safeJsonParse<string[]>(t.escalation_reasons, []);
      if (/negativ|nemul|furi|angry|negative|frustr/i.test(t.sentiment ?? '') || reasons.includes('complaint_legal')) add(t.client_id, 'negative_ticket', 'nemulțumire într-un tichet recent', 25);
      if (reasons.includes('cancellation')) add(t.client_id, 'cancellation_request', 'a pomenit de anulare într-un tichet', 45);
    }
    for (const [id, n] of recentCount) if (n >= 3) add(id, 'many_tickets', `${n} tichete în ultimele 30 de zile`, 15);

    // scor și ordonare
    const scored = [...clients.values()]
      .filter((c) => c.signals.length)
      .map((c) => ({ ...c, score: Math.min(100, c.signals.reduce((a, x) => a + x.weight, 0)) }))
      .sort((a, b) => b.score - a.score || b.annual - a.annual);

    // nume și e-mail pentru primii clienți
    for (const c of scored.slice(0, 25)) {
      if (c.name && c.email) continue;
      try {
        const d = await w.getClient(c.clientId);
        c.name = d.name || c.name;
        c.email = d.email || c.email;
        c.company = d.company;
      } catch {
        /* client șters */
      }
    }

    const out: ChurnClientDTO[] = scored.slice(0, 50).map((c) => {
      const top = [...c.signals].sort((a, b) => b.weight - a.weight)[0]!;
      return {
        clientId: c.clientId,
        name: c.name || `Clientul #${c.clientId}`,
        company: c.company,
        email: c.email,
        score: c.score,
        level: level(c.score),
        signals: c.signals.sort((a, b) => b.weight - a.weight),
        suggestion: SUGGESTION[top.code] ?? null,
        annualValue: c.annual ? Math.round(c.annual * 100) / 100 : null,
      };
    });

    await this.personalize(out.filter((c) => c.level !== 'low').slice(0, 8));

    const high = out.filter((c) => c.level === 'high');
    const medium = out.filter((c) => c.level === 'medium');
    const valueAtRisk = Math.round([...high, ...medium].reduce((a, c) => a + (c.annualValue ?? 0), 0) * 100) / 100;
    const report = {
      currencyPrefix: prefix,
      currencySuffix: suffix || ' RON',
      totals: { high: high.length, medium: medium.length, valueAtRisk, analyzed: clients.size },
      clients: out,
    };
    saveInsight(this.s.db, 'churn', report, 400);
    if (trigger === 'schedule' && (high.length || medium.length)) {
      void this.s.notifier.notify({
        kind: 'business',
        title: `📉 Clienți în risc: ${high.length} ridicat, ${medium.length} mediu`,
        body: `Venit anual în joc: ${formatMoney(valueAtRisk, prefix, suffix || ' RON')}. ${out[0] ? `Primul: ${out[0].name} — ${out[0].signals[0]?.label}.` : ''}`,
        priority: high.length ? 'high' : 'normal',
        url: '/business?tab=clienti',
      });
    }
    return this.latest();
  }

  /** Sugestii scrise de AI pentru primii clienți (dacă AI-ul e disponibil și bugetul permite). */
  private async personalize(list: ChurnClientDTO[]): Promise<void> {
    if (!list.length || !this.s.llm.isAvailable() || this.s.llm.budgetExceeded()) return;
    try {
      const payload = list.map((c) => ({ id: c.clientId, nume: c.name, firma: c.company, scor: c.score, valoare_anuala: c.annualValue, semnale: c.signals.map((x) => x.label) }));
      const text = await this.s.llm.complete(
        {
          model: this.s.settings.get().llm.model,
          thinking: false,
          maxTokens: 900,
          messages: [
            {
              role: 'system',
              content:
                'Ești consultantul de retenție al unei firme românești de hosting. Pentru fiecare client primit, scrie o singură acțiune concretă (max. 25 de cuvinte, în română, la imperativ, adresată proprietarului) care să-l păstreze. Fără promisiuni de reduceri mari. Răspunde STRICT cu JSON: [{"id": <număr>, "actiune": "<text>"}].',
            },
            { role: 'user', content: JSON.stringify(payload) },
          ],
        },
        'report',
      );
      const json = /\[[\s\S]*\]/.exec(text)?.[0];
      const parsed = safeJsonParse<Array<{ id: number; actiune: string }>>(json, []);
      for (const p of parsed) {
        const c = list.find((x) => x.clientId === Number(p.id));
        if (c && typeof p.actiune === 'string' && p.actiune.trim()) c.suggestion = p.actiune.trim().slice(0, 300);
      }
    } catch (err) {
      this.s.log.warn({ err: errorMessage(err) }, 'Sugestiile AI pentru clienții în risc au eșuat');
    }
  }
}
