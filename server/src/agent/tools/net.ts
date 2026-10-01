import { z } from 'zod';
import { defineTool, OPS, READ_EVERYWHERE, ALL_CONTEXTS, ToolFailure } from './types';
import { hostOf, originIp } from './helpers';
import { summarizeHttpCheck } from '../../integrations/net/httpCheck';

export const netTools = [
  defineTool({
    name: 'check_website',
    label: 'Verific site-ul',
    description:
      'Accesează o adresă web și raportează: cod HTTP, timpi (DNS, conectare, SSL, primul octet), probleme recunoscute (eroare bază de date WordPress, eroare critică, cont suspendat, limită resurse, erori Cloudflare 52x, provocare anti-bot, semne de spargere). Cu via_origin=true se conectează direct la serverul de hosting, ocolind Cloudflare — util ca să afli dacă problema e la hosting sau la Cloudflare.',
    schema: z.object({
      url: z.string().url(),
      via_origin: z.boolean().default(false).describe('Conectare directă la IP-ul serverului de hosting (ocolește Cloudflare)'),
      keyword: z.string().max(100).optional().describe('Text care trebuie să apară în pagină'),
    }),
    risk: 'read',
    contexts: ALL_CONTEXTS,
    untrusted: true,
    async execute(a, ctx) {
      const s = ctx.services.settings.get();
      let resolveTo: string | undefined;
      if (a.via_origin) {
        const ip = await originIp(ctx);
        if (!ip) throw new ToolFailure('Nu cunosc IP-ul serverului de hosting. Setează-l în Setări → Site-uri (IP origine) sau configurează DirectAdmin.');
        resolveTo = ip;
      }
      const r = await ctx.services.integrations.net.http({
        url: a.url,
        resolveTo,
        insecure: !!resolveTo,
        keyword: a.keyword,
        slowThresholdMs: s.monitoring.slowThresholdMs,
      });
      return { ...summarizeHttpCheck(r), viaOrigin: resolveTo ?? null };
    },
  }),
  defineTool({
    name: 'check_ssl',
    label: 'Verific certificatul SSL',
    description: 'Verifică certificatul SSL al unui domeniu (valabilitate, emitent, zile rămase). Cu origin=true verifică certificatul de pe serverul de hosting (din spatele Cloudflare).',
    schema: z.object({ domain: z.string().min(3), origin: z.boolean().default(false) }),
    risk: 'read',
    contexts: ALL_CONTEXTS,
    async execute(a, ctx) {
      const ip = a.origin ? await originIp(ctx) : undefined;
      if (a.origin && !ip) throw new ToolFailure('Nu cunosc IP-ul serverului de hosting (Setări → Site-uri → IP origine).');
      return ctx.services.integrations.net.tls(hostOf(a.domain), { ip: ip ?? undefined });
    },
  }),
  defineTool({
    name: 'check_dns',
    label: 'Verific DNS-ul',
    description: 'Interoghează înregistrările DNS publice ale unui domeniu (A, AAAA, MX, NS, TXT, CAA, CNAME).',
    schema: z.object({
      domain: z.string().min(3),
      types: z.array(z.enum(['A', 'AAAA', 'MX', 'NS', 'TXT', 'CAA', 'CNAME'])).default(['A', 'AAAA', 'MX', 'NS', 'TXT']),
    }),
    risk: 'read',
    contexts: ALL_CONTEXTS,
    async execute(a, ctx) {
      return ctx.services.integrations.net.dns(hostOf(a.domain), a.types, ctx.services.settings.get().monitoring.dnsResolvers);
    },
  }),
  defineTool({
    name: 'check_email_security',
    label: 'Verific SPF și DMARC',
    description: 'Verifică înregistrările SPF și DMARC ale unui domeniu (importante pentru livrarea e-mailurilor și protecția împotriva falsificării).',
    schema: z.object({ domain: z.string().min(3) }),
    risk: 'read',
    contexts: ALL_CONTEXTS,
    async execute(a, ctx) {
      return ctx.services.integrations.net.emailAuth(hostOf(a.domain), ctx.services.settings.get().monitoring.dnsResolvers);
    },
  }),
  defineTool({
    name: 'check_domain_expiry',
    label: 'Verific expirarea domeniului',
    description: 'Data de expirare a unui domeniu (RDAP/WHOIS, inclusiv .ro) și registrarul.',
    schema: z.object({ domain: z.string().min(3) }),
    risk: 'read',
    contexts: ALL_CONTEXTS,
    async execute(a, ctx) {
      return ctx.services.integrations.net.domainExpiry(hostOf(a.domain));
    },
  }),
  defineTool({
    name: 'check_blacklists',
    label: 'Verific listele negre',
    description: 'Verifică dacă un IP sau un domeniu apare în listele negre anti-spam (Spamhaus, SpamCop, Barracuda etc.). Util când clienții spun că e-mailurile ajung în spam sau sunt respinse.',
    schema: z.object({ target: z.string().min(3).describe('IP (ex. 1.2.3.4) sau domeniu') }),
    risk: 'read',
    contexts: ALL_CONTEXTS,
    async execute(a, ctx) {
      return ctx.services.integrations.net.blacklist(a.target.trim());
    },
  }),
  defineTool({
    name: 'run_pagespeed',
    label: 'Măsor viteza (PageSpeed)',
    description: 'Rulează Google PageSpeed Insights (scoruri performanță/SEO/accesibilitate, Core Web Vitals, oportunități de optimizare). Durează 20–60 de secunde.',
    schema: z.object({ url: z.string().url(), strategy: z.enum(['mobile', 'desktop']).default('mobile') }),
    risk: 'read',
    contexts: OPS,
    async execute(a, ctx) {
      return ctx.services.integrations.net.pagespeed(a.url, a.strategy, ctx.services.integrations.pagespeedKey());
    },
  }),
  defineTool({
    name: 'security_scan_site',
    label: 'Scanez securitatea site-ului',
    description: 'Scanare externă de securitate: antete HTTP de securitate, redirecționare HTTPS, fișiere sensibile expuse (.env, backup-uri, copii wp-config, director /install WHMCS etc.).',
    schema: z.object({ url: z.string().url(), kind: z.enum(['wordpress', 'whmcs', 'generic']).default('generic') }),
    risk: 'read',
    contexts: OPS,
    async execute(a, ctx) {
      return ctx.services.integrations.net.securityScan(a.url, a.kind);
    },
  }),
  defineTool({
    name: 'fetch_url',
    label: 'Citesc o pagină web',
    description: 'Descarcă o pagină web publică și întoarce textul ei (ex. site-ul unui client care a raportat o problemă). Doar adrese publice.',
    schema: z.object({ url: z.string().url() }),
    risk: 'read',
    contexts: READ_EVERYWHERE,
    untrusted: true,
    async execute(a, ctx) {
      return ctx.services.integrations.net.fetchPage(a.url, 10_000);
    },
  }),
];
