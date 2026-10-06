import type { CollectionsDTO, ReminderDTO, ReminderKind, ReminderStatus } from '@datix/shared';
import type { Services } from '../services';
import type { WhmcsApi } from '../integrations/types';
import { newId } from '../util/ids';
import { errorMessage, truncate } from '../util/text';
import { DAY, HOUR, zonedDate, zonedLocalToUtc } from '../util/time';
import { latestInsight, saveInsight } from './insights';
import { formatDateRo, formatMoney } from './money';

// Încasări: facturi restante, comenzi neterminate și domenii care expiră. DAX pregătește reamintiri
// personale; nimic nu pleacă la client fără apăsarea ta (banii sunt mereu decizia proprietarului).

interface ReminderRow {
  id: string;
  kind: ReminderKind;
  ref_id: number;
  ref_label: string;
  client_id: number;
  client_name: string;
  client_email: string | null;
  amount: number | null;
  currency: string;
  due_date: string | null;
  days_overdue: number | null;
  subject: string;
  message: string;
  status: ReminderStatus;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
  error: string | null;
}

interface Target {
  kind: ReminderKind;
  refId: number;
  refLabel: string;
  clientId: number;
  clientName: string;
  amount: number | null;
  prefix: string;
  suffix: string;
  dueDate: string | null;
  daysOverdue: number | null;
  /** câmpuri pentru șablon */
  extra: Record<string, string>;
}

interface CollectionsInsight {
  currencyPrefix: string;
  currencySuffix: string;
  totals: CollectionsDTO['totals'];
}

const toDTO = (r: ReminderRow): ReminderDTO => ({
  id: r.id,
  kind: r.kind,
  refId: r.ref_id,
  refLabel: r.ref_label,
  clientId: r.client_id,
  clientName: r.client_name,
  clientEmail: r.client_email,
  amount: r.amount,
  amountText: r.amount == null ? null : formatMoney(r.amount, ...((r.currency || '|').split('|') as [string, string])),
  dueDate: r.due_date,
  daysOverdue: r.days_overdue,
  subject: r.subject,
  message: r.message,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  sentAt: r.sent_at,
  error: r.error,
});

export class CollectionsError extends Error {}

/** Diferența în zile calendaristice între două date „YYYY-MM-DD”. */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`)) / DAY);
}

export class CollectionsService {
  private running: Promise<CollectionsDTO> | null = null;

  constructor(private readonly s: Services) {}

  // ------------------------------------------------------------ șabloane

  private whmcsUrl(): string {
    return (this.s.settings.get().integrations.whmcs.url || this.s.settings.get().sites.whmcsUrl).replace(/\/+$/, '');
  }

  /** Textul reamintirii (în română, la persoana a II-a plural de politețe). */
  compose(t: Target, firstName: string): { subject: string; message: string } {
    const signature = this.s.settings.get().tickets.signature.trim() || 'Cu stimă,\nEchipa Datix';
    const hello = firstName ? `Bună ziua, ${firstName},` : 'Bună ziua,';
    const amount = formatMoney(t.amount, t.prefix, t.suffix);
    const url = this.whmcsUrl();
    if (t.kind === 'invoice') {
      return {
        subject: `Reamintire: factura ${t.refLabel} (${amount})`,
        message: [
          hello,
          `Vă scriem în legătură cu factura ${t.refLabel}, în valoare de ${amount}, cu scadența pe ${formatDateRo(t.dueDate)}. Din evidențele noastre, plata nu a fost încă înregistrată${t.daysOverdue ? ` (au trecut ${t.daysOverdue} zile de la scadență)` : ''}.`,
          `Puteți plăti online, în câteva minute, din zona de clienți:\n${url}/viewinvoice.php?id=${t.refId}`,
          'Dacă ați plătit deja, vă rugăm să ignorați acest mesaj sau să ne trimiteți dovada plății, iar noi o vom aloca imediat. Dacă întâmpinați dificultăți, răspundeți la acest e-mail și găsim împreună o soluție.',
          signature,
        ].join('\n\n'),
      };
    }
    if (t.kind === 'order') {
      return {
        subject: `Comanda dumneavoastră #${t.refLabel} așteaptă finalizarea`,
        message: [
          hello,
          `Am observat că ați început o comandă la ${this.s.settings.get().general.companyName} (#${t.refLabel}, ${amount}), dar plata nu a fost finalizată încă.`,
          'Dacă ați întâmpinat o problemă la plată sau aveți întrebări despre pachet, vă ajutăm cu plăcere — răspundeți la acest e-mail.',
          `Puteți finaliza plata din zona de clienți:\n${url}/clientarea.php?action=invoices`,
          signature,
        ].join('\n\n'),
      };
    }
    return {
      subject: `Domeniul ${t.refLabel} expiră pe ${formatDateRo(t.dueDate)}`,
      message: [
        hello,
        `Domeniul ${t.refLabel} expiră pe ${formatDateRo(t.dueDate)}${t.extra.daysLeft ? ` (în ${t.extra.daysLeft} zile)` : ''}. Pentru ca site-ul și adresele de e-mail să funcționeze fără întrerupere, vă recomandăm reînnoirea din timp.`,
        `Reînnoirea se face din zona de clienți:\n${url}/clientarea.php?action=domains`,
        'Dacă nu mai doriți să păstrați domeniul, ne puteți anunța printr-un răspuns la acest e-mail.',
        signature,
      ].join('\n\n'),
    };
  }

  // ------------------------------------------------------------ colectare

  private async targets(w: WhmcsApi): Promise<{ targets: Target[]; insight: CollectionsInsight }> {
    const st = this.s.settings.get().collections;
    const tz = this.s.settings.get().general.timezone;
    const today = zonedDate(Date.now(), tz);
    const targets: Target[] = [];
    let prefix = '';
    let suffix = '';

    const [invoices, orders, domains] = await Promise.all([
      w.getInvoices({ status: 'Overdue', limitnum: 250 }),
      w.getOrders({ status: 'Pending', limitnum: 100 }),
      w.getClientDomains(undefined, 1000),
    ]);

    let overdueAmount = 0;
    for (const inv of invoices.invoices) {
      if (!inv.dueDate) continue;
      const days = daysBetween(inv.dueDate, today);
      if (days < 1) continue;
      prefix ||= inv.currencyPrefix;
      suffix ||= inv.currencySuffix;
      const balance = inv.balance ?? inv.total;
      overdueAmount += balance;
      if (days < st.overdueDays) continue;
      targets.push({
        kind: 'invoice',
        refId: inv.id,
        refLabel: inv.number,
        clientId: inv.clientId,
        clientName: inv.clientName,
        amount: balance,
        prefix: inv.currencyPrefix,
        suffix: inv.currencySuffix,
        dueDate: inv.dueDate,
        daysOverdue: days,
        extra: {},
      });
    }

    let pendingAmount = 0;
    let pendingCount = 0;
    for (const o of orders.orders) {
      if (o.paymentStatus && !/unpaid/i.test(o.paymentStatus)) continue;
      pendingCount++;
      pendingAmount += o.amount;
      const placed = zonedLocalToUtc(o.date.slice(0, 16), tz) ?? Date.parse(o.date);
      if (!placed || Date.now() - placed < st.pendingOrderHours * HOUR) continue;
      targets.push({
        kind: 'order',
        refId: o.id,
        refLabel: o.number || String(o.id),
        clientId: o.clientId,
        clientName: o.clientName,
        amount: o.amount,
        prefix,
        suffix,
        dueDate: o.date.slice(0, 10),
        daysOverdue: Math.floor((Date.now() - placed) / DAY),
        extra: {},
      });
    }

    let expiring = 0;
    for (const d of domains.domains) {
      if (!/active/i.test(d.status) || d.doNotRenew || !d.expiryDate || d.expiryDate.startsWith('0000')) continue;
      const left = daysBetween(today, d.expiryDate);
      if (left < 0 || left > st.domainDays) continue;
      // reînnoire deja plătită: următoarea scadență a trecut mult peste expirare
      if (d.nextDueDate && daysBetween(d.expiryDate, d.nextDueDate) > 30) continue;
      expiring++;
      targets.push({
        kind: 'domain',
        refId: d.id,
        refLabel: d.domain,
        clientId: d.clientId,
        clientName: '',
        amount: Number(d.recurringAmount) || null,
        prefix,
        suffix,
        dueDate: d.expiryDate,
        daysOverdue: null,
        extra: { daysLeft: String(left) },
      });
    }

    return {
      targets,
      insight: {
        currencyPrefix: prefix,
        currencySuffix: suffix || (prefix ? '' : ' RON'),
        totals: { overdueInvoices: invoices.invoices.length, overdueAmount: Math.round(overdueAmount * 100) / 100, pendingOrders: pendingCount, pendingAmount: Math.round(pendingAmount * 100) / 100, expiringDomains: expiring },
      },
    };
  }

  private row(id: string): ReminderRow | null {
    return (this.s.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as ReminderRow | undefined) ?? null;
  }

  /** Scanează WHMCS și pregătește reamintirile noi (nu trimite nimic). */
  scan(trigger: 'schedule' | 'manual' | 'agent' = 'manual'): Promise<CollectionsDTO> {
    this.running ??= this.doScan(trigger).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doScan(trigger: string): Promise<CollectionsDTO> {
    const w = this.s.integrations.whmcs();
    if (!w) return this.overview();
    const st = this.s.settings.get().collections;
    const { targets, insight } = await this.targets(w);
    const now = Date.now();

    // detaliile clienților (prenume, e-mail), o singură dată pe client
    const clients = new Map<number, { firstName: string; name: string; email: string | null }>();
    for (const id of [...new Set(targets.map((t) => t.clientId))].slice(0, 80)) {
      try {
        const c = await w.getClient(id);
        clients.set(id, { firstName: c.name.split(/\s+/)[0] ?? '', name: c.company ? `${c.name} (${c.company})` : c.name, email: c.email || null });
      } catch {
        /* clientul poate fi șters între timp */
      }
    }

    const created: ReminderDTO[] = [];
    const seen = new Set<string>();
    const tx = this.s.db.transaction(() => {
      for (const t of targets) {
        seen.add(`${t.kind}:${t.refId}`);
        const draft = this.s.db.prepare("SELECT * FROM reminders WHERE kind = ? AND ref_id = ? AND status = 'draft'").get(t.kind, t.refId) as ReminderRow | undefined;
        if (draft) {
          this.s.db.prepare('UPDATE reminders SET days_overdue = ?, amount = ? WHERE id = ?').run(t.daysOverdue, t.amount, draft.id);
          continue;
        }
        const recent = this.s.db
          .prepare("SELECT 1 FROM reminders WHERE kind = ? AND ref_id = ? AND (status IN ('sent', 'dismissed') AND updated_at > ?)")
          .get(t.kind, t.refId, now - st.repeatAfterDays * DAY);
        if (recent) continue;
        const client = clients.get(t.clientId);
        const name = client?.name || t.clientName || `Clientul #${t.clientId}`;
        const { subject, message } = this.compose(t, client?.firstName ?? '');
        const id = newId('rem_');
        this.s.db
          .prepare(
            `INSERT INTO reminders (id, kind, ref_id, ref_label, client_id, client_name, client_email, amount, currency, due_date, days_overdue, subject, message, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
          )
          .run(id, t.kind, t.refId, t.refLabel, t.clientId, name, client?.email ?? null, t.amount, `${t.prefix}|${t.suffix}`, t.dueDate, t.daysOverdue, subject, message, now, now);
        created.push(toDTO(this.row(id)!));
      }
      // ciornele pentru lucruri rezolvate între timp (factură plătită, domeniu reînnoit) dispar
      const drafts = this.s.db.prepare("SELECT id, kind, ref_id FROM reminders WHERE status = 'draft'").all() as Array<{ id: string; kind: string; ref_id: number }>;
      for (const d of drafts) if (!seen.has(`${d.kind}:${d.ref_id}`)) this.s.db.prepare("UPDATE reminders SET status = 'resolved', updated_at = ? WHERE id = ?").run(now, d.id);
    });
    tx();

    saveInsight(this.s.db, 'collections', insight);
    this.s.bus.emit({ type: 'collections_changed' });

    if (created.length && trigger === 'schedule') {
      const t = insight.totals;
      const parts = [
        t.overdueInvoices ? `${t.overdueInvoices} facturi restante (${formatMoney(t.overdueAmount, insight.currencyPrefix, insight.currencySuffix)})` : null,
        t.pendingOrders ? `${t.pendingOrders} comenzi neterminate` : null,
        t.expiringDomains ? `${t.expiringDomains} domenii care expiră` : null,
      ].filter(Boolean);
      void this.s.notifier.notify({
        kind: 'business',
        title: `💰 ${created.length === 1 ? 'O reamintire pregătită' : `${created.length} reamintiri pregătite`}`,
        body: `${parts.join(' · ')}. Verifică textele și trimite-le din aplicație.`,
        priority: 'normal',
        url: '/business?tab=incasari',
        dedupeKey: `collections:${zonedDate(now)}`,
      });
    }
    return this.overview();
  }

  // ------------------------------------------------------------ citire și acțiuni

  overview(): CollectionsDTO {
    const available = this.s.integrations.isConfigured('whmcs');
    const insight = latestInsight<CollectionsInsight>(this.s.db, 'collections');
    const rows = this.s.db
      .prepare("SELECT * FROM reminders WHERE status = 'draft' OR (status IN ('sent', 'failed') AND updated_at > ?) ORDER BY CASE status WHEN 'draft' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END, COALESCE(days_overdue, 0) DESC, created_at DESC LIMIT 200")
      .all(Date.now() - 30 * DAY) as ReminderRow[];
    return {
      available,
      message: available ? null : 'Conectează WHMCS (Setări → Integrări) ca DAX să urmărească încasările.',
      generatedAt: insight?.at ?? null,
      currencyPrefix: insight?.data.currencyPrefix ?? '',
      currencySuffix: insight?.data.currencySuffix ?? ' RON',
      totals: insight?.data.totals ?? { overdueInvoices: 0, overdueAmount: 0, pendingOrders: 0, pendingAmount: 0, expiringDomains: 0 },
      reminders: rows.map(toDTO),
    };
  }

  get(id: string): ReminderDTO | null {
    const r = this.row(id);
    return r ? toDTO(r) : null;
  }

  update(id: string, patch: { subject?: string; message?: string }): ReminderDTO {
    const r = this.row(id);
    if (!r) throw new CollectionsError('Reamintirea nu există.');
    if (r.status !== 'draft' && r.status !== 'failed') throw new CollectionsError('Reamintirea a fost deja trimisă sau închisă.');
    const subject = (patch.subject ?? r.subject).trim().slice(0, 200);
    const message = (patch.message ?? r.message).trim().slice(0, 8000);
    if (subject.length < 3 || message.length < 10) throw new CollectionsError('Subiectul sau mesajul e prea scurt.');
    this.s.db.prepare('UPDATE reminders SET subject = ?, message = ?, updated_at = ? WHERE id = ?').run(subject, message, Date.now(), id);
    this.s.bus.emit({ type: 'collections_changed' });
    return this.get(id)!;
  }

  dismiss(id: string): ReminderDTO {
    const r = this.row(id);
    if (!r) throw new CollectionsError('Reamintirea nu există.');
    this.s.db.prepare("UPDATE reminders SET status = 'dismissed', updated_at = ? WHERE id = ?").run(Date.now(), id);
    this.s.audit.log({ actor: 'owner', action: 'reminder.dismissed', target: `${r.kind}:${r.ref_label}`, details: r.client_name });
    this.s.bus.emit({ type: 'collections_changed' });
    return this.get(id)!;
  }

  /** Trimite reamintirea clientului prin WHMCS (doar la cererea proprietarului). */
  async send(id: string, ip: string | null = null): Promise<ReminderDTO> {
    const r = this.row(id);
    if (!r) throw new CollectionsError('Reamintirea nu există.');
    if (r.status !== 'draft' && r.status !== 'failed') throw new CollectionsError('Reamintirea a fost deja trimisă sau închisă.');
    const w = this.s.integrations.whmcs();
    if (!w) throw new CollectionsError('WHMCS nu e conectat.');
    try {
      await w.sendEmail({ clientId: r.client_id, subject: r.subject, message: r.message });
      this.s.db.prepare("UPDATE reminders SET status = 'sent', sent_at = ?, updated_at = ?, error = NULL WHERE id = ?").run(Date.now(), Date.now(), id);
      this.s.audit.log({ actor: 'owner', action: 'reminder.sent', target: `${r.kind}:${r.ref_label}`, details: `${r.client_name}: ${r.subject}`, ip });
    } catch (err) {
      const msg = errorMessage(err);
      this.s.db.prepare("UPDATE reminders SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(truncate(msg, 500), Date.now(), id);
      this.s.audit.log({ actor: 'owner', action: 'reminder.sent', target: `${r.kind}:${r.ref_label}`, details: r.client_name, result: `eșuat: ${msg}`, ip });
    }
    this.s.bus.emit({ type: 'collections_changed' });
    return this.get(id)!;
  }
}
