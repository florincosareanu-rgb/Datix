import { z } from 'zod';
import { defineTool, OPS, OWNER_ONLY, OWNER_REPORTS, READ_EVERYWHERE, ToolFailure } from './types';
import { needWhmcs } from './helpers';
import { truncate } from '../../util/text';

export const whmcsTools = [
  defineTool({
    name: 'whmcs_list_tickets',
    label: 'Citesc tichetele',
    description: 'Tichetele din my.datix.ro. status: „awaiting” (Open + Customer-Reply, așteaptă răspuns), sau un status WHMCS (Open, Answered, Customer-Reply, Closed, On Hold, In Progress).',
    schema: z.object({ status: z.string().default('awaiting'), limit: z.number().int().min(1).max(100).default(25) }),
    risk: 'read',
    contexts: OPS,
    requires: ['whmcs'],
    async execute(a, ctx) {
      const w = needWhmcs(ctx);
      const tickets = a.status === 'awaiting' ? await w.getAwaitingTickets(a.limit) : (await w.getTickets({ status: a.status, limitnum: a.limit })).tickets;
      return tickets.map((t) => ({ id: t.id, tid: t.tid, subject: t.subject, client: t.name, email: t.email, department: t.deptName, status: t.status, priority: t.priority, lastReply: t.lastReply }));
    },
  }),
  defineTool({
    name: 'whmcs_get_ticket',
    label: 'Citesc tichetul',
    description: 'Conversația completă a unui tichet (mesajele clientului și ale echipei, note interne). ticket_id = ID-ul intern WHMCS (nu numărul afișat clientului).',
    schema: z.object({ ticket_id: z.number().int().positive() }),
    risk: 'read',
    contexts: READ_EVERYWHERE,
    requires: ['whmcs'],
    untrusted: true,
    async execute(a, ctx) {
      const t = await needWhmcs(ctx).getTicket(a.ticket_id);
      return {
        ...t,
        replies: t.replies.slice(-30).map((r) => ({ ...r, message: truncate(r.message, 6000) })),
        notes: t.notes.slice(-10),
      };
    },
  }),
  defineTool({
    name: 'whmcs_client_overview',
    label: 'Citesc fișa clientului',
    description: 'Fișa unui client WHMCS: date generale (fără date sensibile), servicii (pachete hosting, domeniu, server, stare, scadență), domenii (expirare), facturi neplătite. Acceptă client_id sau email.',
    schema: z.object({ client_id: z.number().int().positive().optional(), email: z.string().email().optional() }),
    risk: 'read',
    contexts: READ_EVERYWHERE,
    requires: ['whmcs'],
    async execute(a, ctx) {
      const w = needWhmcs(ctx);
      let id = a.client_id ?? null;
      if (!id && a.email) id = await w.findClientByEmail(a.email);
      if (!id) throw new ToolFailure('Clientul nu a fost găsit.');
      const [client, products, domains, invoices] = await Promise.all([
        w.getClient(id),
        w.getClientProducts(id, 50),
        w.getClientDomains(id, 50),
        w.getInvoices({ userid: id, status: 'Unpaid', limitnum: 20 }),
      ]);
      return { client, services: products.products, domains: domains.domains, unpaidInvoices: invoices.invoices };
    },
  }),
  defineTool({
    name: 'whmcs_business_stats',
    label: 'Citesc cifrele de business',
    description: 'Indicatori din WHMCS: încasări (azi, luna, anul), comenzi, tichete, anulări în așteptare, plus evoluția zilnică pe ultimele N zile.',
    schema: z.object({ days: z.number().int().min(1).max(365).default(30) }),
    risk: 'read',
    contexts: OWNER_REPORTS,
    requires: ['whmcs'],
    async execute(a, ctx) {
      return needWhmcs(ctx).getStats(a.days);
    },
  }),
  defineTool({
    name: 'whmcs_unpaid_invoices',
    label: 'Citesc facturile neplătite',
    description: 'Facturile neplătite sau restante (Unpaid / Overdue).',
    schema: z.object({ status: z.enum(['Unpaid', 'Overdue']).default('Unpaid'), limit: z.number().int().min(1).max(100).default(30) }),
    risk: 'read',
    contexts: OWNER_REPORTS,
    requires: ['whmcs'],
    async execute(a, ctx) {
      return needWhmcs(ctx).getInvoices({ status: a.status, limitnum: a.limit });
    },
  }),
  defineTool({
    name: 'whmcs_recent_orders',
    label: 'Citesc comenzile recente',
    description: 'Comenzile recente din WHMCS (opțional filtrate după status: Pending, Active, Fraud, Cancelled).',
    schema: z.object({ status: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) }),
    risk: 'read',
    contexts: OWNER_REPORTS,
    requires: ['whmcs'],
    async execute(a, ctx) {
      return needWhmcs(ctx).getOrders({ status: a.status, limitnum: a.limit });
    },
  }),
  defineTool({
    name: 'whmcs_admin_activity',
    label: 'Verific activitatea din WHMCS',
    description: 'Jurnalul de activitate WHMCS (autentificări admin, eșecuri de login, modificări) — pentru securitate.',
    schema: z.object({ limit: z.number().int().min(10).max(500).default(100), filter: z.string().max(60).optional().describe('Text de căutat în descriere, ex. „Failed”') }),
    risk: 'read',
    contexts: OPS,
    requires: ['whmcs'],
    untrusted: true,
    async execute(a, ctx) {
      return needWhmcs(ctx).getActivityLog({ limitnum: a.limit, description: a.filter });
    },
  }),
  defineTool({
    name: 'whmcs_system_info',
    label: 'Verific sistemul WHMCS',
    description: 'Versiunea WHMCS, administratorii, departamentele de suport.',
    schema: z.object({}),
    risk: 'read',
    contexts: OPS,
    requires: ['whmcs'],
    async execute(_a, ctx) {
      const w = needWhmcs(ctx);
      const [details, admins, departments] = await Promise.all([w.details(), w.getAdminUsers().catch(() => []), w.getDepartments().catch(() => [])]);
      return { version: details.version, admins, departments };
    },
  }),
  defineTool({
    name: 'whmcs_add_ticket_note',
    label: 'Adaug o notă internă la tichet',
    description: 'Adaugă o notă internă (vizibilă doar echipei, nu clientului) la un tichet — ex. constatările investigației.',
    schema: z.object({ ticket_id: z.number().int().positive(), note: z.string().min(3).max(8000) }),
    risk: 'write',
    contexts: ['owner', 'incident', 'ticket'],
    ticketSafe: true,
    requires: ['whmcs'],
    summarize: (a) => `Notă internă la tichetul #${a.ticket_id}`,
    async execute(a, ctx) {
      await needWhmcs(ctx).addTicketNote({ ticketId: a.ticket_id, message: `🤖 ${ctx.services.settings.get().general.agentName}:\n\n${a.note}` });
      return { added: true };
    },
  }),
  defineTool({
    name: 'whmcs_update_ticket',
    label: 'Actualizez tichetul',
    description: 'Schimbă prioritatea, statusul sau departamentul unui tichet.',
    schema: z.object({
      ticket_id: z.number().int().positive(),
      priority: z.enum(['Low', 'Medium', 'High']).optional(),
      status: z.string().optional(),
      department_id: z.number().int().positive().optional(),
    }),
    risk: 'write',
    contexts: ['owner', 'ticket'],
    ticketSafe: true,
    requires: ['whmcs'],
    summarize: (a) => `Actualizează tichetul #${a.ticket_id}: ${JSON.stringify({ priority: a.priority, status: a.status, department: a.department_id })}`,
    async execute(a, ctx) {
      if (ctx.context === 'ticket' && a.status && /closed/i.test(a.status)) throw new ToolFailure('Agentul nu închide tichete singur.');
      await needWhmcs(ctx).updateTicket({ ticketId: a.ticket_id, priority: a.priority, status: a.status, deptid: a.department_id });
      return { updated: true };
    },
  }),
  defineTool({
    name: 'whmcs_reply_ticket',
    label: 'Răspund la tichet',
    description: 'Trimite un răspuns clientului într-un tichet (în numele echipei Datix). Se adaugă automat semnătura și nota AI. Proprietarul confirmă textul înainte de trimitere.',
    schema: z.object({ ticket_id: z.number().int().positive(), message: z.string().min(10).max(20000) }),
    risk: 'customer_message',
    contexts: OWNER_ONLY,
    requires: ['whmcs'],
    summarize: (a) => `Răspuns către client la tichetul #${a.ticket_id}:\n\n${a.message}`,
    async execute(a, ctx) {
      const s = ctx.services.settings.get();
      const message = ctx.services.tickets.composeReply(a.message);
      await needWhmcs(ctx).addTicketReply({ ticketId: a.ticket_id, message, adminUsername: s.integrations.whmcs.replyAsAdmin || undefined });
      return { sent: true };
    },
  }),
];
