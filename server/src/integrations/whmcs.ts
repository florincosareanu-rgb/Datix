import { fetchWithRetry, IntegrationError, readJson } from './http';
import { stripHtml, toNumber } from '../util/text';

const SERVICE = 'WHMCS';

export interface WhmcsOptions {
  url: string;
  identifier: string;
  secret: string;
  timeoutMs?: number;
}

export interface WhmcsTicketSummary {
  id: number;
  tid: string;
  deptId: number;
  deptName: string;
  userId: number;
  name: string;
  email: string;
  subject: string;
  status: string;
  priority: string;
  date: string;
  lastReply: string;
  flag: number;
}

export interface WhmcsTicketReply {
  id: string;
  author: string;
  email: string;
  isStaff: boolean;
  date: string;
  message: string;
}

export interface WhmcsTicket extends WhmcsTicketSummary {
  serviceRef: string | null;
  replies: WhmcsTicketReply[];
  notes: Array<{ admin: string; date: string; message: string }>;
}

type Raw = Record<string, unknown>;

const str = (v: unknown): string => (v == null ? '' : String(v));
const num = (v: unknown): number => Number(v ?? 0) || 0;

function cleanMessage(raw: string): string {
  // WHMCS poate stoca HTML sau markdown; păstrăm textul
  const decoded = raw.includes('<') ? stripHtml(raw) : raw;
  return decoded.replace(/\r\n/g, '\n').trim();
}

/** Câmpuri sensibile pe care nu le transmitem niciodată mai departe (nici către AI). */
const SENSITIVE_KEYS = /pass|pwreset|securityq|cardnum|cardtype|cardlast|gatewayid|issuenumber|startdate|expdate|bankacct|bankcode|banktype|cvv|authcode|eppcode|twofa|totp/i;

export function sanitizeRecord<T extends Raw>(obj: T): Raw {
  const out: Raw = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.test(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = sanitizeRecord(v as Raw);
    else if (Array.isArray(v)) out[k] = v.map((x) => (x && typeof x === 'object' ? sanitizeRecord(x as Raw) : x));
    else out[k] = v;
  }
  return out;
}

export class WhmcsClient {
  private readonly endpoint: string;

  constructor(private readonly opts: WhmcsOptions) {
    this.endpoint = `${opts.url.replace(/\/+$/, '')}/includes/api.php`;
  }

  async call<T = Raw>(action: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const body = new URLSearchParams({
      action,
      identifier: this.opts.identifier,
      secret: this.opts.secret,
      responsetype: 'json',
    });
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      body.set(k, typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));
    }
    const res = await fetchWithRetry(this.endpoint, {
      service: SERVICE,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': 'DAX/1.0' },
      body: body.toString(),
      timeoutMs: this.opts.timeoutMs ?? 30_000,
      retries: 1,
    });
    const text = await res.text();
    let data: Raw;
    try {
      data = JSON.parse(text) as Raw;
    } catch {
      const ip = /Invalid IP ([0-9a-f.:]+)/i.exec(text)?.[1];
      if (ip) throw new IntegrationError(SERVICE, `IP-ul ${ip} nu e permis pentru API. Adaugă-l în WHMCS → Setup → General Settings → Security → API IP Access Restriction.`, res.status);
      throw new IntegrationError(SERVICE, `răspuns neașteptat (HTTP ${res.status}): ${text.slice(0, 160)}`, res.status);
    }
    if (data.result === 'error') {
      const message = str(data.message) || 'eroare necunoscută';
      const ip = /Invalid IP ([0-9a-f.:]+)/i.exec(message)?.[1];
      if (ip) throw new IntegrationError(SERVICE, `IP-ul ${ip} nu e permis pentru API. Adaugă-l în WHMCS → Setup → General Settings → Security → API IP Access Restriction.`, res.status);
      if (/Authentication Failed/i.test(message)) throw new IntegrationError(SERVICE, 'autentificare eșuată — verifică Identifier și Secret (Setup → Staff Management → Manage API Credentials).', res.status);
      throw new IntegrationError(SERVICE, `${action}: ${message}`, res.status);
    }
    return data as T;
  }

  async details(): Promise<{ version: string }> {
    const d = await this.call<{ whmcs?: { version?: string }; whmcs_version?: string }>('WhmcsDetails');
    return { version: str(d.whmcs?.version ?? d.whmcs_version ?? 'necunoscută') };
  }

  private mapTicketSummary(t: Raw): WhmcsTicketSummary {
    return {
      id: num(t.id ?? t.ticketid),
      tid: str(t.tid),
      deptId: num(t.deptid),
      deptName: str(t.deptname),
      userId: num(t.userid),
      name: str(t.name || t.requestor_name),
      email: str(t.email || t.requestor_email),
      subject: str(t.subject),
      status: str(t.status),
      priority: str(t.priority),
      date: str(t.date),
      lastReply: str(t.lastreply),
      flag: num(t.flag),
    };
  }

  async getTickets(params: { status?: string; limitnum?: number; limitstart?: number; deptid?: number; clientid?: number } = {}) {
    const d = await this.call<{ totalresults?: number; tickets?: { ticket?: Raw[] } }>('GetTickets', {
      limitstart: params.limitstart ?? 0,
      limitnum: params.limitnum ?? 50,
      status: params.status,
      deptid: params.deptid,
      clientid: params.clientid,
      ignore_dept_assignments: true,
    });
    return { total: num(d.totalresults), tickets: (d.tickets?.ticket ?? []).map((t) => this.mapTicketSummary(t)) };
  }

  /** Tichetele care așteaptă răspuns de la noi (Open + Customer-Reply). */
  async getAwaitingTickets(limit = 50): Promise<WhmcsTicketSummary[]> {
    const [open, reply] = await Promise.all([
      this.getTickets({ status: 'Open', limitnum: limit }),
      this.getTickets({ status: 'Customer-Reply', limitnum: limit }),
    ]);
    const map = new Map<number, WhmcsTicketSummary>();
    for (const t of [...open.tickets, ...reply.tickets]) map.set(t.id, t);
    return [...map.values()];
  }

  async getTicket(ticketId: number): Promise<WhmcsTicket> {
    const d = await this.call<Raw>('GetTicket', { ticketid: ticketId, repliessort: 'ASC' });
    const base = this.mapTicketSummary({ ...d, id: d.ticketid ?? d.id });
    const repliesRaw = ((d.replies as { reply?: Raw[] } | undefined)?.reply ?? []) as Raw[];
    const replies: WhmcsTicketReply[] = repliesRaw.map((r, i) => ({
      id: str(r.replyid || `r${i}`),
      author: str(r.admin || r.name || r.requestor_name || 'Client'),
      email: str(r.email),
      isStaff: !!str(r.admin),
      date: str(r.date),
      message: cleanMessage(str(r.message)),
    }));
    if (!replies.length && d.message) {
      replies.push({ id: 'r0', author: base.name, email: base.email, isStaff: false, date: base.date, message: cleanMessage(str(d.message)) });
    }
    const notesRaw = ((d.notes as { note?: Raw[] } | undefined)?.note ?? []) as Raw[];
    return {
      ...base,
      serviceRef: str(d.service) || null,
      replies,
      notes: notesRaw.map((n) => ({ admin: str(n.admin), date: str(n.created ?? n.date), message: cleanMessage(str(n.message)) })),
    };
  }

  async addTicketReply(params: { ticketId: number; message: string; adminUsername?: string; status?: string; markdown?: boolean }) {
    await this.call('AddTicketReply', {
      ticketid: params.ticketId,
      message: params.message,
      adminusername: params.adminUsername || undefined,
      status: params.status,
      markdown: params.markdown ?? true,
    });
  }

  async addTicketNote(params: { ticketId: number; message: string }) {
    await this.call('AddTicketNote', { ticketid: params.ticketId, message: params.message, markdown: true });
  }

  async updateTicket(params: { ticketId: number; status?: string; priority?: string; deptid?: number; flag?: number }) {
    await this.call('UpdateTicket', {
      ticketid: params.ticketId,
      status: params.status,
      priority: params.priority,
      deptid: params.deptid,
      flag: params.flag,
    });
  }

  async getDepartments(): Promise<Array<{ id: number; name: string; awaitingReply: number; open: number }>> {
    const d = await this.call<{ departments?: { department?: Raw[] } }>('GetSupportDepartments', { ignore_dept_assignments: true });
    return (d.departments?.department ?? []).map((x) => ({ id: num(x.id), name: str(x.name), awaitingReply: num(x.awaitingreply), open: num(x.opentickets) }));
  }

  async getClient(clientId: number) {
    const d = await this.call<Raw>('GetClientsDetails', { clientid: clientId, stats: true });
    const c = (d.client as Raw | undefined) ?? d;
    const stats = (d.stats as Raw | undefined) ?? {};
    return {
      id: num(c.id ?? c.userid),
      name: `${str(c.firstname)} ${str(c.lastname)}`.trim(),
      company: str(c.companyname) || null,
      email: str(c.email),
      status: str(c.status),
      country: str(c.countrycode ?? c.country),
      language: str(c.language) || null,
      createdAt: str(c.datecreated) || null,
      lastLogin: str(c.lastlogin) || null,
      credit: str(c.credit) || null,
      currency: str(c.currency_code) || null,
      notes: str(c.notes) || null,
      stats: {
        activeServices: num(stats.productsnumactive),
        totalServices: num(stats.productsnumtotal),
        unpaidInvoices: num(stats.numunpaidinvoices),
        unpaidAmount: str(stats.unpaidinvoicesamount),
        overdueInvoices: num(stats.numoverdueinvoices),
        overdueAmount: str(stats.overdueinvoicesbalance),
        activeDomains: num(stats.numactivedomains),
        openTickets: num(stats.numactivetickets),
      },
    };
  }

  async findClientByEmail(email: string) {
    const d = await this.call<{ clients?: { client?: Raw[] } }>('GetClients', { search: email, limitnum: 5 });
    const match = (d.clients?.client ?? []).find((c) => str(c.email).toLowerCase() === email.toLowerCase());
    return match ? num(match.id) : null;
  }

  async getClientProducts(clientId?: number, limit = 100) {
    const d = await this.call<{ totalresults?: number; products?: { product?: Raw[] } }>('GetClientsProducts', {
      clientid: clientId,
      limitnum: limit,
    });
    return {
      total: num(d.totalresults),
      products: (d.products?.product ?? []).map((p) => ({
        id: num(p.id),
        clientId: num(p.clientid),
        name: str(p.translated_name || p.name),
        group: str(p.translated_groupname || p.groupname),
        domain: str(p.domain) || null,
        status: str(p.status),
        billingCycle: str(p.billingcycle),
        recurringAmount: str(p.recurringamount),
        nextDueDate: str(p.nextduedate),
        regDate: str(p.regdate),
        server: str(p.servername) || null,
        serverHostname: str(p.serverhostname) || null,
        serverIp: str(p.serverip) || null,
        module: str(p.productmodule) || null,
        username: str(p.username) || null,
        diskUsageMb: num(p.diskusage),
        diskLimitMb: num(p.disklimit),
        bwUsageMb: num(p.bwusage),
        bwLimitMb: num(p.bwlimit),
        suspensionReason: str(p.suspensionreason) || null,
      })),
    };
  }

  async getClientDomains(clientId?: number, limit = 100) {
    const d = await this.call<{ totalresults?: number; domains?: { domain?: Raw[] } }>('GetClientsDomains', { clientid: clientId, limitnum: limit });
    return {
      total: num(d.totalresults),
      domains: (d.domains?.domain ?? []).map((x) => ({
        id: num(x.id),
        clientId: num(x.userid),
        domain: str(x.domainname),
        status: str(x.status),
        registrar: str(x.registrar) || null,
        expiryDate: str(x.expirydate) || null,
        nextDueDate: str(x.nextduedate) || null,
        doNotRenew: !!x.donotrenew && str(x.donotrenew) !== '0',
        recurringAmount: str(x.recurringamount),
      })),
    };
  }

  async getInvoices(params: { status?: string; userid?: number; limitnum?: number } = {}) {
    const d = await this.call<{ totalresults?: number; invoices?: { invoice?: Raw[] } }>('GetInvoices', {
      status: params.status,
      userid: params.userid,
      limitnum: params.limitnum ?? 50,
      orderby: 'duedate',
      order: 'asc',
    });
    return {
      total: num(d.totalresults),
      invoices: (d.invoices?.invoice ?? []).map((i) => ({
        id: num(i.id),
        number: str(i.invoicenum) || str(i.id),
        clientId: num(i.userid),
        clientName: `${str(i.firstname)} ${str(i.lastname)}`.trim() || str(i.companyname),
        date: str(i.date),
        dueDate: str(i.duedate),
        total: toNumber(i.total) ?? 0,
        balance: toNumber(i.balance) ?? null,
        status: str(i.status),
        currencyPrefix: str(i.currencyprefix),
        currencySuffix: str(i.currencysuffix),
      })),
    };
  }

  async getOrders(params: { status?: string; limitnum?: number } = {}) {
    const d = await this.call<{ totalresults?: number; orders?: { order?: Raw[] } }>('GetOrders', { status: params.status, limitnum: params.limitnum ?? 25 });
    return {
      total: num(d.totalresults),
      orders: (d.orders?.order ?? []).map((o) => ({
        id: num(o.id),
        number: str(o.ordernum),
        clientId: num(o.userid),
        clientName: str(o.name),
        date: str(o.date),
        amount: toNumber(o.amount) ?? 0,
        status: str(o.status),
        paymentStatus: str(o.paymentstatus) || null,
        paymentMethod: str(o.paymentmethodname || o.paymentmethod) || null,
      })),
    };
  }

  async getStats(timelineDays = 30) {
    const d = await this.call<Raw>('GetStats', { timeline_days: timelineDays });
    const timeline = Array.isArray(d.timeline_data)
      ? (d.timeline_data as Raw[]).map((t) => ({
          date: str(t.date),
          income: toNumber(t.income) ?? 0,
          newOrders: num(t.new_orders),
          newTickets: num(t.new_tickets),
        }))
      : d.timeline_data && typeof d.timeline_data === 'object'
        ? Object.entries(d.timeline_data as Record<string, Raw>).map(([date, t]) => ({
            date: str(t.date) || date,
            income: toNumber(t.income) ?? 0,
            newOrders: num(t.new_orders),
            newTickets: num(t.new_tickets),
          }))
        : [];
    return {
      incomeToday: toNumber(d.income_today),
      incomeThisMonth: toNumber(d.income_thismonth),
      incomeThisYear: toNumber(d.income_thisyear),
      ordersPending: toNumber(d.orders_pending),
      ordersToday: toNumber(d.orders_today_total),
      ordersThisMonth: toNumber(d.orders_thismonth_total),
      ticketsAwaitingReply: toNumber(d.tickets_awaitingreply),
      ticketsOpen: toNumber(d.tickets_allactive),
      cancellationsPending: toNumber(d.cancellations_pending),
      currencyHint: typeof d.income_today === 'string' ? (d.income_today as string).replace(/[\d.,\s-]/g, '') : '',
      timeline,
    };
  }

  async getActivityLog(params: { limitnum?: number; description?: string } = {}) {
    const d = await this.call<{ activity?: { entry?: Raw[] } }>('GetActivityLog', { limitnum: params.limitnum ?? 100, description: params.description });
    return (d.activity?.entry ?? []).map((e) => ({
      id: num(e.id),
      date: str(e.date),
      description: str(e.description),
      user: str(e.username ?? e.user),
      ip: str(e.ipaddress) || null,
      clientId: num(e.clientId ?? e.userid),
    }));
  }

  async getAdminUsers() {
    const d = await this.call<{ admin_users?: Raw[] }>('GetAdminUsers', {});
    return (d.admin_users ?? []).map((a) => ({
      id: num(a.id),
      username: str(a.username),
      name: `${str(a.firstname)} ${str(a.lastname)}`.trim(),
      email: str(a.email),
      role: str(a.roleId ?? a.roleid),
      disabled: !!a.isDisabled || str(a.disabled) === '1',
    }));
  }
}
