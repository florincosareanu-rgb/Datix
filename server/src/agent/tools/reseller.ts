import { z } from 'zod';
import { defineTool, OPS, READ_EVERYWHERE } from './types';
import { needReseller, safeDaPath } from './helpers';
import { findErrorLogs } from './directadmin';
import { tailLines } from '../../util/text';

// Unelte pentru contul de reseller (pregătite; devin disponibile când integrarea e activată).

const user = z.string().regex(/^[a-z0-9_-]{1,32}$/i, 'nume de utilizator DirectAdmin invalid');

export const resellerTools = [
  defineTool({
    name: 'reseller_list_accounts',
    label: 'Listez conturile clienților',
    description: 'Conturile de hosting ale clienților din contul de reseller, cu consumul și starea fiecăruia.',
    schema: z.object({ with_usage: z.boolean().default(false) }),
    risk: 'read',
    contexts: READ_EVERYWHERE,
    requires: ['reseller'],
    async execute(a, ctx) {
      const r = needReseller(ctx);
      const users = await r.listUsers();
      if (!a.with_usage) return users;
      const out = [];
      for (const u of users.slice(0, 50)) {
        try {
          const { raw: _raw, ...usage } = await r.usage(u);
          out.push({ user: u, ...usage });
        } catch (err) {
          out.push({ user: u, error: (err as Error).message });
        }
      }
      return out;
    },
  }),
  defineTool({
    name: 'reseller_account_details',
    label: 'Verific contul clientului',
    description: 'Detaliile contului de hosting al unui client: domenii, consum disc/trafic/inode, pachet, IP, suspendat sau nu.',
    schema: z.object({ user }),
    risk: 'read',
    contexts: READ_EVERYWHERE,
    requires: ['reseller'],
    async execute(a, ctx) {
      const r = needReseller(ctx);
      const [domains, usage] = await Promise.all([r.userDomains(a.user), r.usage(a.user)]);
      const { raw: _raw, ...rest } = usage;
      return { user: a.user, ...rest, domainCount: rest.domains, domains };
    },
  }),
  defineTool({
    name: 'reseller_find_error_logs',
    label: 'Citesc erorile site-ului clientului',
    description: 'Jurnalele de erori din contul de hosting al unui client (acces ca reseller, doar citire).',
    schema: z.object({ user, domain: z.string().min(3), lines: z.number().int().min(10).max(300).default(80) }),
    risk: 'read',
    contexts: READ_EVERYWHERE,
    requires: ['reseller'],
    untrusted: true,
    async execute(a, ctx) {
      return findErrorLogs(needReseller(ctx).asUser(a.user), a.domain.toLowerCase(), a.lines);
    },
  }),
  defineTool({
    name: 'reseller_read_file',
    label: 'Citesc un fișier al clientului',
    description: 'Citește un fișier text din contul de hosting al unui client (ex. .htaccess). Parolele sunt mascate automat.',
    schema: z.object({ user, path: z.string().min(2), tail_lines: z.number().int().min(10).max(1000).optional() }),
    risk: 'read',
    contexts: READ_EVERYWHERE,
    requires: ['reseller'],
    untrusted: true,
    async execute(a, ctx) {
      const f = await needReseller(ctx).asUser(a.user).readText(safeDaPath(a.path), 256 * 1024);
      if (f.binary) return { path: f.path, binary: true, sizeBytes: f.sizeBytes };
      return { ...f, content: a.tail_lines ? tailLines(f.content, a.tail_lines) : f.content };
    },
  }),
  defineTool({
    name: 'reseller_set_suspended',
    label: 'Suspend/reactivez contul clientului',
    description: 'Suspendă sau reactivează contul de hosting al unui client (ex. abuz, neplată). Necesită aprobare.',
    schema: z.object({ user, suspended: z.boolean(), reason: z.string().max(300) }),
    risk: 'irreversible',
    contexts: OPS,
    requires: ['reseller'],
    summarize: (a) => `${a.suspended ? 'SUSPENDĂ' : 'Reactivează'} contul de hosting ${a.user} — ${a.reason}`,
    async execute(a, ctx) {
      await needReseller(ctx).setSuspended(a.user, a.suspended);
      return { user: a.user, suspended: a.suspended };
    },
  }),
];
