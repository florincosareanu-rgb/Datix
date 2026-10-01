import { z } from 'zod';
import { defineTool, OPS, READ_EVERYWHERE, ToolFailure } from './types';
import { needDa, safeDaPath } from './helpers';
import { tailLines } from '../../util/text';
import { IntegrationError } from '../../integrations/http';
import type { DirectAdminApi } from '../../integrations/types';
import type { ToolContext } from './types';

const isPhpPath = (p: string) => /\.(php\d?|phtml|phar|inc)$/i.test(p);
const MASK_MARKERS = /\[ascuns\]|\[parolă ascunsă\]|\[cheie API ascunsă\]|\[cheie privată ascunsă\]|\[token ascuns\]/;

async function writeWithBackup(ctx: ToolContext, path: string, content: string, reason: string) {
  if (MASK_MARKERS.test(content)) {
    throw new ToolFailure('Conținutul conține valori mascate (ex. [ascuns]) — dacă l-aș scrie, aș înlocui datele reale. Modificarea trebuie făcută de proprietar.');
  }
  const da = needDa(ctx);
  let backupId: string | null = null;
  try {
    const prev = await da.downloadFile(path);
    backupId = ctx.services.fileBackups.save('directadmin', path, prev, reason);
  } catch (err) {
    if (!(err instanceof IntegrationError && err.status === 404)) throw err;
  }
  const r = await da.uploadFile(path, content, true);
  ctx.services.audit.log({ actor: 'agent', context: ctx.context, action: 'directadmin.write_file', target: path, details: reason, result: r.verified ? 'verificat' : 'neverificat' });
  return { written: true, verified: r.verified, sizeBytes: r.sizeBytes, previousVersionId: backupId };
}

/** Caută și citește jurnalele de erori pentru un domeniu (error_log PHP, debug.log WordPress, loguri arhivate). */
export async function findErrorLogs(da: DirectAdminApi, domain: string, lines: number) {
  const base = `/domains/${domain}`;
  const candidates = [`${base}/public_html/error_log`, `${base}/public_html/wp-content/debug.log`, `${base}/public_html/wp-admin/error_log`, `${base}/public_html/admin/error_log`];
  const found: Array<{ path: string; sizeBytes: number; tail: string }> = [];
  for (const p of candidates) {
    try {
      const f = await da.readText(p, 128 * 1024);
      if (!f.binary && f.content.trim()) found.push({ path: p, sizeBytes: f.sizeBytes, tail: tailLines(f.content, lines) });
    } catch (err) {
      if (!(err instanceof IntegrationError && err.status === 404)) found.push({ path: p, sizeBytes: 0, tail: `(nu am putut citi: ${(err as Error).message})` });
    }
  }
  let archived: Array<{ name: string; sizeBytes: number; modified: string | null }> = [];
  try {
    const l = await da.listFiles(`${base}/logs`, { limit: 100 });
    archived = l.files.filter((f) => f.type !== 'dir').map((f) => ({ name: f.name, sizeBytes: f.sizeBytes, modified: f.modified }));
  } catch {
    archived = [];
  }
  return { domain, logs: found, archivedLogs: archived.slice(0, 20), note: found.length ? undefined : 'Nu am găsit jurnale de erori cu conținut. Poți porni captura erorilor cu wp_rescue_capture_errors.' };
}

export const directadminTools = [
  defineTool({
    name: 'da_account_usage',
    label: 'Verific consumul contului de hosting',
    description: 'Spațiul pe disc, traficul și inode-urile folosite față de limitele pachetului, IP-ul serverului, dacă e suspendat contul.',
    schema: z.object({}),
    risk: 'read',
    contexts: READ_EVERYWHERE,
    requires: ['directadmin'],
    async execute(_a, ctx) {
      const u = await needDa(ctx).usage();
      const { raw: _raw, ...rest } = u;
      return rest;
    },
  }),
  defineTool({
    name: 'da_list_domains',
    label: 'Listez domeniile din hosting',
    description: 'Domeniile din contul DirectAdmin.',
    schema: z.object({}),
    risk: 'read',
    contexts: READ_EVERYWHERE,
    requires: ['directadmin'],
    async execute(_a, ctx) {
      return needDa(ctx).listDomains();
    },
  }),
  defineTool({
    name: 'da_find_error_logs',
    label: 'Caut jurnalele de erori',
    description: 'Găsește și citește jurnalele de erori ale unui domeniu din hosting (error_log PHP, debug.log WordPress) și listează logurile arhivate.',
    schema: z.object({ domain: z.string().min(3), lines: z.number().int().min(10).max(300).default(80) }),
    risk: 'read',
    contexts: OPS,
    requires: ['directadmin'],
    untrusted: true,
    async execute(a, ctx) {
      return findErrorLogs(needDa(ctx), a.domain.toLowerCase(), a.lines);
    },
  }),
  defineTool({
    name: 'da_list_files',
    label: 'Listez fișierele',
    description: 'Listează un director din contul de hosting. Site-urile sunt în /domains/<domeniu>/public_html.',
    schema: z.object({ path: z.string().min(1), filter: z.string().max(60).optional().describe('ex. *.php') }),
    risk: 'read',
    contexts: OPS,
    requires: ['directadmin'],
    async execute(a, ctx) {
      const r = await needDa(ctx).listFiles(safeDaPath(a.path), { query: a.filter, limit: 500 });
      return { ...r, files: r.files.slice(0, 300) };
    },
  }),
  defineTool({
    name: 'da_read_file',
    label: 'Citesc un fișier',
    description: 'Citește un fișier text din hosting (configurări, .htaccess, loguri). Parolele și cheile sunt mascate automat.',
    schema: z.object({ path: z.string().min(2), tail_lines: z.number().int().min(10).max(2000).optional().describe('Doar ultimele N linii (pentru loguri)') }),
    risk: 'read',
    contexts: OPS,
    requires: ['directadmin'],
    untrusted: true,
    async execute(a, ctx) {
      const f = await needDa(ctx).readText(safeDaPath(a.path), 256 * 1024);
      if (f.binary) return { path: f.path, binary: true, sizeBytes: f.sizeBytes };
      return { ...f, content: a.tail_lines ? tailLines(f.content, a.tail_lines) : f.content };
    },
  }),
  defineTool({
    name: 'da_search_files',
    label: 'Caut fișiere după nume',
    description: 'Caută fișiere după nume într-un director din hosting.',
    schema: z.object({ path: z.string().min(1), query: z.string().min(1).max(100) }),
    risk: 'read',
    contexts: OPS,
    requires: ['directadmin'],
    async execute(a, ctx) {
      return needDa(ctx).searchFiles(safeDaPath(a.path), a.query, 100);
    },
  }),
  defineTool({
    name: 'da_search_text',
    label: 'Caut text în fișiere',
    description: 'Caută un text în conținutul fișierelor dintr-un director (ex. cod malițios precum „eval(base64_decode”).',
    schema: z.object({ path: z.string().min(1), query: z.string().min(2).max(200) }),
    risk: 'read',
    contexts: OPS,
    requires: ['directadmin'],
    untrusted: true,
    async execute(a, ctx) {
      return needDa(ctx).searchText(safeDaPath(a.path), a.query, 50);
    },
  }),
  defineTool({
    name: 'da_list_databases',
    label: 'Listez bazele de date',
    description: 'Bazele de date MySQL din contul de hosting.',
    schema: z.object({}),
    risk: 'read',
    contexts: OPS,
    requires: ['directadmin'],
    async execute(_a, ctx) {
      return needDa(ctx).listDatabases();
    },
  }),
  defineTool({
    name: 'da_list_email_accounts',
    label: 'Listez conturile de e-mail',
    description: 'Căsuțele de e-mail ale unui domeniu din hosting.',
    schema: z.object({ domain: z.string().min(3) }),
    risk: 'read',
    contexts: READ_EVERYWHERE,
    requires: ['directadmin'],
    async execute(a, ctx) {
      return needDa(ctx).listEmailAccounts(a.domain.toLowerCase());
    },
  }),
  defineTool({
    name: 'da_list_backups',
    label: 'Listez backup-urile',
    description: 'Backup-urile contului din DirectAdmin (directorul /backups).',
    schema: z.object({}),
    risk: 'read',
    contexts: OPS,
    requires: ['directadmin'],
    async execute(_a, ctx) {
      return needDa(ctx).listBackups();
    },
  }),
  defineTool({
    name: 'da_list_file_versions',
    label: 'Listez versiunile salvate ale fișierelor',
    description: 'Copiile fișierelor salvate automat de agent înainte de modificări (pentru anulare cu da_restore_file_version).',
    schema: z.object({ path: z.string().optional() }),
    risk: 'read',
    contexts: OPS,
    async execute(a, ctx) {
      return ctx.services.fileBackups.list('directadmin', a.path ? safeDaPath(a.path) : undefined, 30);
    },
  }),
  defineTool({
    name: 'da_write_file',
    label: 'Modific un fișier',
    description:
      'Scrie (creează sau înlocuiește) un fișier text care NU e PHP în hosting (ex. .htaccess, robots.txt, .user.ini). Versiunea anterioară se salvează automat și poate fi restaurată. Scrie conținutul complet al fișierului, nu doar diferențele.',
    schema: z.object({ path: z.string().min(2), content: z.string().max(500_000), reason: z.string().max(200).describe('De ce se modifică fișierul') }),
    risk: 'write',
    contexts: OPS,
    requires: ['directadmin'],
    summarize: (a) => `Modifică fișierul ${a.path} — ${a.reason}`,
    async execute(a, ctx) {
      const path = safeDaPath(a.path);
      if (isPhpPath(path)) throw new ToolFailure('Pentru fișiere PHP folosește da_write_php_file (necesită aprobarea proprietarului).');
      return writeWithBackup(ctx, path, a.content, a.reason);
    },
  }),
  defineTool({
    name: 'da_write_php_file',
    label: 'Modific un fișier PHP',
    description:
      'Scrie un fișier PHP în hosting (ex. corectarea wp-config.php). Versiunea anterioară se salvează automat. Necesită aprobare, pentru că un fișier PHP greșit poate opri site-ul sau poate introduce cod periculos.',
    schema: z.object({ path: z.string().min(2), content: z.string().max(500_000), reason: z.string().max(300) }),
    risk: 'irreversible',
    contexts: OPS,
    requires: ['directadmin'],
    summarize: (a) => `Modifică fișierul PHP ${a.path} — ${a.reason}`,
    async execute(a, ctx) {
      const path = safeDaPath(a.path);
      if (!isPhpPath(path)) throw new ToolFailure('Fișierul nu e PHP — folosește da_write_file.');
      if (/\[ascuns\]|\[parolă ascunsă\]|\[cheie API ascunsă\]/.test(a.content)) {
        throw new ToolFailure('Conținutul conține valori mascate ([ascuns]). Nu pot scrie fișierul așa, pentru că aș înlocui parolele reale. Modifică doar fișiere fără secrete sau cere proprietarului să facă modificarea.');
      }
      return writeWithBackup(ctx, path, a.content, a.reason);
    },
  }),
  defineTool({
    name: 'da_restore_file_version',
    label: 'Restaurez o versiune a fișierului',
    description: 'Restaurează un fișier la o versiune salvată anterior de agent (vezi da_list_file_versions).',
    schema: z.object({ versionId: z.string().min(5) }),
    risk: 'write',
    contexts: OPS,
    requires: ['directadmin'],
    summarize: (a) => `Restaurează versiunea salvată ${a.versionId}`,
    async execute(a, ctx) {
      const b = ctx.services.fileBackups.get(a.versionId);
      if (!b || b.target !== 'directadmin') throw new ToolFailure('Versiunea nu există.');
      const da = needDa(ctx);
      try {
        const current = await da.downloadFile(b.path);
        ctx.services.fileBackups.save('directadmin', b.path, current, `înainte de restaurarea versiunii ${b.id}`);
      } catch {
        /* fișierul poate să nu mai existe */
      }
      const r = await da.uploadFile(b.path, b.content, true);
      return { restored: true, path: b.path, verified: r.verified };
    },
  }),
  defineTool({
    name: 'da_renew_ssl',
    label: 'Reînnoiesc certificatul SSL',
    description: "Cere/reînnoiește certificatul Let's Encrypt pentru un domeniu din hosting (și www).",
    schema: z.object({ domain: z.string().min(3), include_www: z.boolean().default(true) }),
    risk: 'write',
    contexts: OPS,
    requires: ['directadmin'],
    summarize: (a) => `Reînnoiește certificatul SSL Let's Encrypt pentru ${a.domain}`,
    async execute(a, ctx) {
      return needDa(ctx).requestLetsEncrypt(a.domain.toLowerCase(), { includeWww: a.include_www });
    },
  }),
  defineTool({
    name: 'da_create_backup',
    label: 'Creez un backup al contului',
    description: 'Pornește un backup complet al contului de hosting în DirectAdmin (fișiere, baze de date, e-mail). Se creează în fundal în câteva minute.',
    schema: z.object({ reason: z.string().max(200).optional() }),
    risk: 'write',
    contexts: OPS,
    requires: ['directadmin'],
    summarize: () => 'Creează un backup complet al contului de hosting',
    async execute(_a, ctx) {
      await needDa(ctx).createBackup();
      return { started: true, note: 'DirectAdmin creează backup-ul în fundal; apare în /backups în câteva minute (vezi da_list_backups).' };
    },
  }),
  defineTool({
    name: 'da_move_to_trash',
    label: 'Mut fișiere în coș',
    description: 'Mută fișiere/directoare în coșul contului DirectAdmin (recuperabile din panou). Folosește pentru fișiere malițioase sau expuse.',
    schema: z.object({ paths: z.array(z.string().min(2)).min(1).max(20), reason: z.string().max(200) }),
    risk: 'irreversible',
    contexts: OPS,
    requires: ['directadmin'],
    summarize: (a) => `Mută în coș: ${a.paths.join(', ')} — ${a.reason}`,
    async execute(a, ctx) {
      const paths = a.paths.map(safeDaPath);
      for (const p of paths) {
        if (/^\/domains\/[^/]+\/public_html$|^\/domains\/[^/]+$|^\/domains$|^\/$/.test(p)) throw new ToolFailure(`Refuz să mut în coș un director principal: ${p}`);
      }
      await needDa(ctx).trash(paths);
      return { trashed: paths };
    },
  }),
  defineTool({
    name: 'da_restore_backup',
    label: 'Restaurez un backup',
    description: 'Restaurează contul de hosting dintr-un backup DirectAdmin. ATENȚIE: suprascrie fișierele, bazele de date și e-mailurile cu cele din backup (se pierd modificările ulterioare, inclusiv comenzi/tichete WHMCS).',
    schema: z.object({ file: z.string().min(5).describe('Numele arhivei din /backups'), reason: z.string().max(300) }),
    risk: 'irreversible',
    contexts: OPS,
    requires: ['directadmin'],
    summarize: (a) => `RESTAUREAZĂ backup-ul ${a.file} (suprascrie datele curente) — ${a.reason}`,
    async execute(a, ctx) {
      return needDa(ctx).restoreBackup(a.file);
    },
  }),
  defineTool({
    name: 'da_api_call',
    label: 'Comandă DirectAdmin avansată',
    description: 'Apelează direct o comandă DirectAdmin (CMD_API_*) — doar când nu există o unealtă dedicată. Necesită aprobare.',
    schema: z.object({
      command: z.string().regex(/^CMD_API_[A-Z_]+$/),
      method: z.enum(['GET', 'POST']).default('GET'),
      params: z.record(z.string(), z.string()).default({}),
      reason: z.string().max(300),
    }),
    risk: 'irreversible',
    contexts: OPS,
    requires: ['directadmin'],
    summarize: (a) => `DirectAdmin ${a.command} ${JSON.stringify(a.params)} — ${a.reason}`,
    async execute(a, ctx) {
      return needDa(ctx).legacy(a.command, a.params, a.method);
    },
  }),
];
