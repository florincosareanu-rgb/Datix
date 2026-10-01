import { z } from 'zod';
import { defineTool, OPS, READ_EVERYWHERE, ToolFailure } from './types';
import { needCf } from './helpers';

export const cloudflareTools = [
  defineTool({
    name: 'cf_overview',
    label: 'Verific Cloudflare',
    description: 'Starea zonei Cloudflare: activă/pauză, plan, nivel de securitate, mod SSL, Development Mode, Always Use HTTPS.',
    schema: z.object({}),
    risk: 'read',
    contexts: READ_EVERYWHERE,
    requires: ['cloudflare'],
    async execute(_a, ctx) {
      return needCf(ctx).zoneOverview();
    },
  }),
  defineTool({
    name: 'cf_security_events',
    label: 'Citesc atacurile blocate de Cloudflare',
    description: 'Evenimentele de securitate Cloudflare (WAF, rate limiting, boți) din ultimele ore: total, pe acțiuni, țări și IP-uri, plus cele mai recente.',
    schema: z.object({ hours: z.number().int().min(1).max(72).default(24) }),
    risk: 'read',
    contexts: OPS,
    requires: ['cloudflare'],
    untrusted: true,
    async execute(a, ctx) {
      return needCf(ctx).securityEvents(a.hours);
    },
  }),
  defineTool({
    name: 'cf_dns_records',
    label: 'Citesc DNS-ul din Cloudflare',
    description: 'Înregistrările DNS ale zonei din Cloudflare (inclusiv dacă sunt proxy-uite).',
    schema: z.object({}),
    risk: 'read',
    contexts: OPS,
    requires: ['cloudflare'],
    async execute(_a, ctx) {
      return (await needCf(ctx).dnsRecords()).map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content, proxied: r.proxied, ttl: r.ttl, priority: r.priority }));
    },
  }),
  defineTool({
    name: 'cf_purge_cache',
    label: 'Golesc cache-ul Cloudflare',
    description: 'Golește cache-ul Cloudflare (tot, sau doar anumite adrese).',
    schema: z.object({ urls: z.array(z.string().url()).max(30).default([]) }),
    risk: 'write',
    contexts: OPS,
    requires: ['cloudflare'],
    summarize: (a) => (a.urls.length ? `Golește cache-ul Cloudflare pentru ${a.urls.length} adrese` : 'Golește tot cache-ul Cloudflare'),
    async execute(a, ctx) {
      await needCf(ctx).purgeCache(a.urls);
      return { purged: a.urls.length ? a.urls : 'tot' };
    },
  }),
  defineTool({
    name: 'cf_set_security_level',
    label: 'Schimb nivelul de securitate Cloudflare',
    description: 'Setează nivelul de securitate Cloudflare. „under_attack” afișează o verificare tuturor vizitatorilor — folosește-l doar în timpul unui atac (DDoS, boți) și revino apoi la „medium”.',
    schema: z.object({ level: z.enum(['essentially_off', 'low', 'medium', 'high', 'under_attack']) }),
    risk: 'write',
    contexts: OPS,
    requires: ['cloudflare'],
    summarize: (a) => `Nivel de securitate Cloudflare: ${a.level === 'under_attack' ? 'Under Attack (sub atac)' : a.level}`,
    async execute(a, ctx) {
      return { securityLevel: await needCf(ctx).setSecurityLevel(a.level) };
    },
  }),
  defineTool({
    name: 'cf_set_development_mode',
    label: 'Development Mode Cloudflare',
    description: 'Pornește/oprește Development Mode (ocolește cache-ul Cloudflare 3 ore) — util când modificările nu apar pe site.',
    schema: z.object({ on: z.boolean() }),
    risk: 'write',
    contexts: OPS,
    requires: ['cloudflare'],
    summarize: (a) => `${a.on ? 'Pornește' : 'Oprește'} Development Mode în Cloudflare`,
    async execute(a, ctx) {
      return { developmentMode: await needCf(ctx).setDevelopmentMode(a.on) };
    },
  }),
  defineTool({
    name: 'cf_dns_change',
    label: 'Modific DNS-ul',
    description: 'Creează, modifică sau șterge o înregistrare DNS în Cloudflare. Schimbările DNS greșite pot opri site-ul sau e-mailul — necesită aprobare.',
    schema: z.object({
      action: z.enum(['create', 'update', 'delete']),
      record_id: z.string().optional().describe('Obligatoriu pentru update/delete (din cf_dns_records)'),
      type: z.enum(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA', 'SRV', 'NS']).optional(),
      name: z.string().optional(),
      content: z.string().optional(),
      proxied: z.boolean().optional(),
      priority: z.number().int().optional(),
      reason: z.string().max(200),
    }),
    risk: 'irreversible',
    contexts: OPS,
    requires: ['cloudflare'],
    summarize: (a) => `DNS ${a.action}: ${a.type ?? ''} ${a.name ?? a.record_id ?? ''} → ${a.content ?? '(șters)'} — ${a.reason}`,
    async execute(a, ctx) {
      const cf = needCf(ctx);
      if (a.action === 'delete') {
        if (!a.record_id) throw new ToolFailure('record_id e obligatoriu pentru ștergere.');
        await cf.deleteDnsRecord(a.record_id);
        return { deleted: a.record_id };
      }
      if (!a.type || !a.name || !a.content) throw new ToolFailure('type, name și content sunt obligatorii.');
      const rec = { type: a.type, name: a.name, content: a.content, proxied: a.proxied, priority: a.priority };
      if (a.action === 'create') return cf.createDnsRecord(rec);
      if (!a.record_id) throw new ToolFailure('record_id e obligatoriu pentru modificare.');
      return cf.updateDnsRecord(a.record_id, rec);
    },
  }),
];
