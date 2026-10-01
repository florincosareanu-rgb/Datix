import { z } from 'zod';
import { SEVERITY_ORDER, type Severity } from '@datix/shared';
import { defineTool, OPS, READ_EVERYWHERE, ALL_CONTEXTS, ToolFailure } from './types';

const severity = z.enum(['critical', 'high', 'medium', 'low', 'info']);

export const statusTools = [
  defineTool({
    name: 'status_overview',
    label: 'Verific starea generală',
    description:
      'Starea curentă a tuturor monitoarelor (site-uri, SSL, domenii, DNS, securitate, WHMCS, hosting), incidentele deschise, problemele de securitate și tichetele care așteaptă răspuns. Folosește-o prima dată când ești întrebat „cum stau lucrurile”.',
    schema: z.object({}),
    risk: 'read',
    contexts: ALL_CONTEXTS,
    async execute(_a, ctx) {
      const s = ctx.services;
      const monitors = s.monitoring.listMonitors().map((m) => ({
        id: m.id,
        name: m.name,
        kind: m.kind,
        status: m.status,
        lastCheckAt: m.lastCheckAt ? new Date(m.lastCheckAt).toISOString() : null,
        message: m.lastMessage,
        latencyMs: m.lastLatencyMs,
        uptime24h: m.uptime24h,
      }));
      const openFindings = s.findings.list({ status: 'open' }).slice(0, 8).map((f) => ({ severity: f.severity, title: f.title }));
      return {
        monitors,
        openIncidents: s.incidents.list({ status: 'active', limit: 10 }).map((i) => ({ id: i.id, title: i.title, severity: i.severity, status: i.status, openedAt: new Date(i.openedAt).toISOString() })),
        securityFindings: { counts: s.findings.countsBySeverity(), top: openFindings },
        tickets: s.tickets.attentionSummary(),
        business: s.business.latest(),
        aiUsage: s.llm.usageSummary(),
      };
    },
  }),
  defineTool({
    name: 'get_incidents',
    label: 'Citesc incidentele',
    description: 'Lista incidentelor (căderi, degradări). status: „active” (nerezolvate) sau „all”.',
    schema: z.object({ status: z.enum(['active', 'all']).default('active'), limit: z.number().int().min(1).max(50).default(10) }),
    risk: 'read',
    contexts: ALL_CONTEXTS,
    async execute(a, ctx) {
      return ctx.services.incidents.list({ status: a.status, limit: a.limit });
    },
  }),
  defineTool({
    name: 'get_incident_details',
    label: 'Citesc detaliile incidentului',
    description: 'Detaliile și cronologia unui incident (ce s-a detectat, ce s-a făcut).',
    schema: z.object({ id: z.string().min(3) }),
    risk: 'read',
    contexts: ALL_CONTEXTS,
    async execute(a, ctx) {
      const inc = ctx.services.incidents.get(a.id);
      if (!inc) throw new ToolFailure(`Incidentul ${a.id} nu există.`);
      return { incident: inc, timeline: ctx.services.incidents.events(a.id).slice(-40) };
    },
  }),
  defineTool({
    name: 'get_security_findings',
    label: 'Citesc problemele de securitate',
    description: 'Problemele de securitate detectate de scanări (fișiere expuse, pluginuri vulnerabile, antete lipsă, conturi admin noi etc.).',
    schema: z.object({ status: z.enum(['open', 'resolved', 'ignored', 'all']).default('open'), minSeverity: severity.default('low') }),
    risk: 'read',
    contexts: ALL_CONTEXTS,
    async execute(a, ctx) {
      const max = SEVERITY_ORDER[a.minSeverity as Severity];
      return ctx.services.findings
        .list({ status: a.status === 'all' ? undefined : a.status })
        .filter((f) => SEVERITY_ORDER[f.severity] <= max)
        .slice(0, 40)
        .map((f) => ({ id: f.id, severity: f.severity, title: f.title, details: f.details, recommendation: f.recommendation, status: f.status, firstSeen: new Date(f.firstSeenAt).toISOString() }));
    },
  }),
  defineTool({
    name: 'get_uptime_stats',
    label: 'Calculez disponibilitatea',
    description: 'Disponibilitatea (uptime %) și timpul mediu de răspuns pentru monitoare, pe ultimele N ore.',
    schema: z.object({ hours: z.number().int().min(1).max(24 * 90).default(24 * 7) }),
    risk: 'read',
    contexts: ALL_CONTEXTS,
    async execute(a, ctx) {
      return ctx.services.monitoring.uptimeReport(a.hours);
    },
  }),
  defineTool({
    name: 'run_check_now',
    label: 'Rulez o verificare acum',
    description: 'Rulează imediat un monitor (după id-ul din status_overview) și întoarce rezultatul. Util după o reparație, ca să confirmi.',
    schema: z.object({ monitorId: z.string().min(1) }),
    risk: 'read',
    contexts: OPS,
    async execute(a, ctx) {
      return ctx.services.monitoring.runNow(a.monitorId);
    },
  }),
  defineTool({
    name: 'kb_search',
    label: 'Caut în baza de cunoștințe',
    description: 'Caută în documentele firmei Datix (servicii, prețuri, proceduri, termeni, întrebări frecvente). Folosește-o înainte să dai informații despre servicii sau politici.',
    schema: z.object({ query: z.string().min(2).max(200) }),
    risk: 'read',
    contexts: READ_EVERYWHERE,
    async execute(a, ctx) {
      const results = ctx.services.kb.search(a.query, 5);
      return results.length ? results : { message: 'Nu am găsit nimic relevant în baza de cunoștințe.' };
    },
  }),
  defineTool({
    name: 'memory_list',
    label: 'Citesc notițele salvate',
    description: 'Notițele persistente salvate anterior (preferințe ale proprietarului, informații despre clienți și site-uri).',
    schema: z.object({}),
    risk: 'read',
    contexts: OPS,
    async execute(_a, ctx) {
      return ctx.services.memory.list(50);
    },
  }),
  defineTool({
    name: 'memory_save',
    label: 'Salvez o notiță',
    description: 'Salvează o informație utilă pe termen lung (ex. o preferință a proprietarului sau un detaliu tehnic despre un site). Nu salva date sensibile (parole, chei).',
    schema: z.object({ note: z.string().min(3).max(800) }),
    risk: 'write',
    contexts: OPS,
    summarize: (a) => `Salvează notița: „${a.note}”`,
    async execute(a, ctx) {
      return { saved: true, id: ctx.services.memory.add(a.note, ctx.context) };
    },
  }),
  defineTool({
    name: 'notify_owner',
    label: 'Trimit o notificare',
    description: 'Trimite o notificare push pe telefonul proprietarului. Folosește-o doar pentru lucruri importante (ex. o problemă pe care nu o poți rezolva singur).',
    schema: z.object({
      title: z.string().min(3).max(80),
      message: z.string().min(3).max(300),
      priority: z.enum(['normal', 'high', 'critical']).default('high'),
    }),
    risk: 'write',
    contexts: OPS,
    summarize: (a) => `Notificare: ${a.title}`,
    async execute(a, ctx) {
      await ctx.services.notifier.notify({ kind: 'system', title: a.title, body: a.message, priority: a.priority, url: `/chat/${ctx.conversationId}` });
      return { sent: true };
    },
  }),
];
