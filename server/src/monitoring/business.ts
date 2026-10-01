import type { BusinessDTO, BusinessSnapshotDTO } from '@datix/shared';
import type { Services } from '../services';
import { safeJsonParse } from '../util/text';
import { DAY } from '../util/time';

interface Timeline {
  date: string;
  income: number;
  newOrders: number;
  newTickets: number;
}

/** Indicatorii de business din WHMCS (încasări, comenzi, facturi, tichete, domenii care expiră). */
export class BusinessService {
  constructor(private readonly s: Services) {}

  latest(): BusinessSnapshotDTO | null {
    const r = this.s.db.prepare("SELECT data FROM snapshots WHERE kind = 'business' AND key = 'whmcs' ORDER BY at DESC LIMIT 1").get() as { data: string } | undefined;
    return r ? safeJsonParse<{ snapshot: BusinessSnapshotDTO }>(r.data, { snapshot: null as unknown as BusinessSnapshotDTO }).snapshot : null;
  }

  private latestTimeline(): Timeline[] {
    const r = this.s.db.prepare("SELECT data FROM snapshots WHERE kind = 'business' AND key = 'whmcs' ORDER BY at DESC LIMIT 1").get() as { data: string } | undefined;
    return r ? safeJsonParse<{ timeline: Timeline[] }>(r.data, { timeline: [] }).timeline : [];
  }

  dto(): BusinessDTO {
    const latest = this.latest();
    const available = !!this.s.integrations.whmcs();
    return {
      latest,
      timeline: this.latestTimeline(),
      available,
      message: available ? (latest ? null : 'Datele se încarcă la prima verificare (în câteva minute).') : 'Conectează WHMCS (Setări → Integrări) ca să vezi cifrele de business.',
    };
  }

  async refresh(): Promise<BusinessSnapshotDTO | null> {
    const w = this.s.integrations.whmcs();
    if (!w) return null;
    const [stats, unpaid, overdue, products, domains] = await Promise.all([
      w.getStats(30),
      w.getInvoices({ status: 'Unpaid', limitnum: 250 }).catch(() => null),
      w.getInvoices({ status: 'Overdue', limitnum: 250 }).catch(() => null),
      w.getClientProducts(undefined, 250).catch(() => null),
      w.getClientDomains(undefined, 250).catch(() => null),
    ]);
    const firstInvoice = unpaid?.invoices[0] ?? overdue?.invoices[0];
    const soon = Date.now() + 30 * DAY;
    const snapshot: BusinessSnapshotDTO = {
      at: Date.now(),
      currencyPrefix: firstInvoice?.currencyPrefix ?? '',
      currencySuffix: firstInvoice?.currencySuffix ?? (stats.currencyHint ? ` ${stats.currencyHint}` : ''),
      incomeToday: stats.incomeToday,
      incomeThisMonth: stats.incomeThisMonth,
      incomeThisYear: stats.incomeThisYear,
      ordersPending: stats.ordersPending,
      ordersToday: stats.ordersToday,
      ordersThisMonth: stats.ordersThisMonth,
      ticketsAwaitingReply: stats.ticketsAwaitingReply,
      ticketsOpen: stats.ticketsOpen,
      cancellationsPending: stats.cancellationsPending,
      unpaidInvoices: unpaid ? unpaid.total : null,
      unpaidTotal: unpaid ? Math.round(unpaid.invoices.reduce((s, i) => s + (i.balance ?? i.total), 0) * 100) / 100 : null,
      overdueInvoices: overdue ? overdue.total : null,
      activeServices: products ? products.products.filter((p) => p.status === 'Active').length : null,
      domainsExpiringSoon: domains
        ? domains.domains.filter((d) => d.status === 'Active' && d.expiryDate && !d.doNotRenew && new Date(d.expiryDate).getTime() < soon).length
        : null,
    };
    this.s.db
      .prepare("INSERT INTO snapshots (kind, key, at, data) VALUES ('business', 'whmcs', ?, ?)")
      .run(snapshot.at, JSON.stringify({ snapshot, timeline: stats.timeline }));
    // păstrăm un instantaneu pe oră pentru 90 de zile
    this.s.db.prepare("DELETE FROM snapshots WHERE kind = 'business' AND at < ?").run(Date.now() - 90 * DAY);
    return snapshot;
  }
}
