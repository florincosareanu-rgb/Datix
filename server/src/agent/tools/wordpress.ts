import { z } from 'zod';
import { defineTool, OPS, READ_EVERYWHERE, ToolFailure } from './types';
import { needRescue, needWp } from './helpers';
import { tailLines } from '../../util/text';

export const wordpressTools = [
  defineTool({
    name: 'wp_health',
    label: 'Verific WordPress',
    description: 'Starea WordPress (prin pluginul Datix AI): versiuni WordPress/PHP, temă, actualizări disponibile, setări de siguranță, cron, pluginuri de cache, mod mentenanță.',
    schema: z.object({}),
    risk: 'read',
    contexts: READ_EVERYWHERE,
    requires: ['wordpress'],
    async execute(_a, ctx) {
      return needWp(ctx).health();
    },
  }),
  defineTool({
    name: 'wp_plugins',
    label: 'Citesc pluginurile',
    description: 'Lista pluginurilor WordPress (fișier, versiune, activ, actualizare disponibilă).',
    schema: z.object({}),
    risk: 'read',
    contexts: READ_EVERYWHERE,
    requires: ['wordpress'],
    async execute(_a, ctx) {
      return needWp(ctx).plugins();
    },
  }),
  defineTool({
    name: 'wp_check_vulnerabilities',
    label: 'Caut vulnerabilități cunoscute',
    description: 'Verifică WordPress, pluginurile și tema activă în baza publică de vulnerabilități (WPVulnerability).',
    schema: z.object({}),
    risk: 'read',
    contexts: OPS,
    requires: ['wordpress'],
    async execute(_a, ctx) {
      const wp = needWp(ctx);
      const [health, plugins] = await Promise.all([wp.health(), wp.plugins()]);
      const net = ctx.services.integrations.net;
      const results: unknown[] = [];
      const errors: string[] = [];
      const check = async (type: 'core' | 'plugin' | 'theme', slug: string, version: string) => {
        try {
          results.push(...(await net.wpVuln(type, slug, version)));
        } catch (err) {
          errors.push(`${slug}: ${(err as Error).message}`);
        }
      };
      await check('core', 'wordpress', health.wp_version);
      if (health.theme?.stylesheet) await check('theme', health.theme.stylesheet, health.theme.version);
      for (const p of plugins) await check('plugin', p.slug, p.version);
      return { checked: plugins.length + 2, vulnerabilities: results, errors: errors.slice(0, 10) };
    },
  }),
  defineTool({
    name: 'wp_security_audit',
    label: 'Audit de securitate WordPress',
    description:
      'Audit intern WordPress: integritatea fișierelor nucleului (sume de control oficiale), fișiere PHP în uploads, fișiere PHP modificate recent, administratori, setări riscante, tipare de cod malițios. deep=true durează mai mult.',
    schema: z.object({ deep: z.boolean().default(false) }),
    risk: 'read',
    contexts: OPS,
    requires: ['wordpress'],
    async execute(a, ctx) {
      return needWp(ctx).securityAudit(a.deep);
    },
  }),
  defineTool({
    name: 'wp_security_events',
    label: 'Citesc evenimentele de securitate WordPress',
    description: 'Autentificări reușite/eșuate, administratori noi, schimbări de rol, pluginuri activate, teme schimbate — din jurnalul pluginului Datix AI.',
    schema: z.object({ hours: z.number().int().min(1).max(24 * 30).default(24) }),
    risk: 'read',
    contexts: OPS,
    requires: ['wordpress'],
    async execute(a, ctx) {
      const since = Math.floor((Date.now() - a.hours * 3_600_000) / 1000);
      const events = await needWp(ctx).securityEvents(since, 300);
      const failed = events.filter((e) => e.type === 'login_failed');
      const byIp = new Map<string, number>();
      for (const e of failed) byIp.set(e.ip ?? '?', (byIp.get(e.ip ?? '?') ?? 0) + 1);
      return {
        total: events.length,
        failedLogins: failed.length,
        topFailedIps: [...byIp.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([ip, n]) => ({ ip, attempts: n })),
        important: events.filter((e) => e.type !== 'login_failed').slice(0, 60),
      };
    },
  }),
  defineTool({
    name: 'wp_debug_log',
    label: 'Citesc jurnalul de erori WordPress',
    description: 'Ultimele linii din wp-content/debug.log (dacă există).',
    schema: z.object({ lines: z.number().int().min(10).max(500).default(150) }),
    risk: 'read',
    contexts: OPS,
    requires: ['wordpress'],
    untrusted: true,
    async execute(a, ctx) {
      const r = await needWp(ctx).debugLog(a.lines);
      return { ...r, content: tailLines(r.content, a.lines) };
    },
  }),
  defineTool({
    name: 'wp_purge_cache',
    label: 'Golesc cache-ul WordPress',
    description: 'Golește cache-ul pluginurilor de cache WordPress (LiteSpeed Cache, WP Rocket, W3TC, WP Super Cache etc.) și cache-ul de obiecte.',
    schema: z.object({}),
    risk: 'write',
    contexts: OPS,
    requires: ['wordpress'],
    summarize: () => 'Golește cache-ul WordPress',
    async execute(_a, ctx) {
      return needWp(ctx).purgeCache();
    },
  }),
  defineTool({
    name: 'wp_set_maintenance',
    label: 'Mod mentenanță WordPress',
    description: 'Pornește/oprește pagina de mentenanță pentru vizitatori (prin pluginul Datix AI; administratorii văd site-ul normal).',
    schema: z.object({ enabled: z.boolean(), message: z.string().max(300).optional() }),
    risk: 'write',
    contexts: OPS,
    requires: ['wordpress'],
    summarize: (a) => (a.enabled ? 'Pornește modul mentenanță pe datix.ro' : 'Oprește modul mentenanță pe datix.ro'),
    async execute(a, ctx) {
      return needWp(ctx).setMaintenance(a.enabled, a.message);
    },
  }),
  defineTool({
    name: 'wp_toggle_plugin',
    label: 'Activez/dezactivez un plugin',
    description: 'Activează sau dezactivează un plugin WordPress prin pluginul Datix AI (când site-ul funcționează). Pentru site căzut folosește wp_rescue_disable_plugins.',
    schema: z.object({ plugin: z.string().min(3).describe('Fișierul pluginului, ex. akismet/akismet.php'), active: z.boolean() }),
    risk: 'write',
    contexts: OPS,
    requires: ['wordpress'],
    summarize: (a) => `${a.active ? 'Activează' : 'Dezactivează'} pluginul ${a.plugin}`,
    async execute(a, ctx) {
      return needWp(ctx).togglePlugin(a.plugin, a.active);
    },
  }),
  defineTool({
    name: 'wp_hardening',
    label: 'Întăresc securitatea WordPress',
    description: 'Activează protecții din pluginul Datix AI: blocarea XML-RPC, blocarea listării utilizatorilor, dezactivarea editorului de fișiere din wp-admin.',
    schema: z.object({
      disable_xmlrpc: z.boolean().optional(),
      block_user_enum: z.boolean().optional(),
      disable_file_edit: z.boolean().optional(),
    }),
    risk: 'write',
    contexts: OPS,
    requires: ['wordpress'],
    summarize: (a) => `Setări de securitate WordPress: ${JSON.stringify(a)}`,
    async execute(a, ctx) {
      return needWp(ctx).hardening(a);
    },
  }),
  defineTool({
    name: 'wp_run_updates',
    label: 'Actualizez WordPress',
    description:
      'Actualizează pluginuri, teme, nucleul WordPress sau traducerile. Recomandat: creează mai întâi un backup (da_create_backup) și verifică site-ul după actualizare.',
    schema: z.object({
      type: z.enum(['plugin', 'theme', 'core', 'translations']),
      items: z.array(z.string()).max(30).default([]).describe('Pentru plugin: fișierele pluginurilor (ex. akismet/akismet.php); pentru temă: slug-urile. Gol = toate cele cu actualizări.'),
    }),
    risk: 'irreversible',
    contexts: OPS,
    requires: ['wordpress'],
    summarize: (a) => `Actualizează ${a.type === 'core' ? 'nucleul WordPress' : a.type === 'translations' ? 'traducerile' : `${a.type === 'plugin' ? 'pluginurile' : 'temele'} ${a.items.length ? a.items.join(', ') : '(toate cu actualizări)'}`}`,
    async execute(a, ctx) {
      return needWp(ctx).runUpdates(a.type, a.items);
    },
  }),
];

export const rescueTools = [
  defineTool({
    name: 'wp_rescue_status',
    label: 'Verific trusa de salvare',
    description: 'Arată ce măsuri temporare de salvare sunt active pe WordPress (pluginuri dezactivate, temă de siguranță, captură erori, mentenanță).',
    schema: z.object({}),
    risk: 'read',
    contexts: OPS,
    requires: ['directadmin'],
    async execute(_a, ctx) {
      return needRescue(ctx).status();
    },
  }),
  defineTool({
    name: 'wp_rescue_capture_errors',
    label: 'Pornesc captura erorilor PHP',
    description:
      'Pornește (sau oprește) înregistrarea erorilor PHP într-un fișier privat, prin DirectAdmin — funcționează chiar dacă site-ul e căzut. După pornire, accesează pagina cu check_website, apoi citește erorile cu wp_rescue_read_errors.',
    schema: z.object({ enabled: z.boolean().default(true) }),
    risk: 'write',
    contexts: OPS,
    requires: ['directadmin'],
    summarize: (a) => (a.enabled ? 'Pornește captura erorilor PHP pe WordPress' : 'Oprește captura erorilor PHP'),
    async execute(a, ctx) {
      return needRescue(ctx).apply({ capture_errors: a.enabled });
    },
  }),
  defineTool({
    name: 'wp_rescue_read_errors',
    label: 'Citesc erorile PHP capturate',
    description: 'Citește erorile PHP capturate de trusa de salvare (liniile [DATIX-AI-FATAL] arată fișierul și linia care a picat site-ul).',
    schema: z.object({ lines: z.number().int().min(10).max(400).default(120) }),
    risk: 'read',
    contexts: OPS,
    requires: ['directadmin'],
    untrusted: true,
    async execute(a, ctx) {
      const content = await needRescue(ctx).readErrorLog();
      if (!content) return { message: 'Nu există erori capturate (sau captura nu e pornită).' };
      return { content: tailLines(content, a.lines) };
    },
  }),
  defineTool({
    name: 'wp_rescue_disable_plugins',
    label: 'Dezactivez temporar pluginuri',
    description:
      'Dezactivează temporar pluginuri WordPress fără a le șterge, prin DirectAdmin (funcționează și când site-ul e căzut). Primește slug-ul (numele folderului din wp-content/plugins) sau fișierul pluginului. Lista înlocuiește lista anterioară; trimite [] ca să le reactivezi pe toate.',
    schema: z.object({ plugins: z.array(z.string().min(2).max(120)).max(30) }),
    risk: 'write',
    contexts: OPS,
    requires: ['directadmin'],
    summarize: (a) => (a.plugins.length ? `Dezactivează temporar pluginurile: ${a.plugins.join(', ')}` : 'Reactivează toate pluginurile dezactivate temporar'),
    async execute(a, ctx) {
      return needRescue(ctx).apply({ disabled_plugins: a.plugins });
    },
  }),
  defineTool({
    name: 'wp_rescue_switch_theme',
    label: 'Comut pe o temă de siguranță',
    description: 'Comută temporar WordPress pe altă temă instalată (ex. twentytwentyfive), când tema activă provoacă erori. theme=null revine la tema normală.',
    schema: z.object({ theme: z.string().max(80).nullable() }),
    risk: 'write',
    contexts: OPS,
    requires: ['directadmin'],
    summarize: (a) => (a.theme ? `Comută temporar pe tema ${a.theme}` : 'Revine la tema normală'),
    async execute(a, ctx) {
      return needRescue(ctx).apply({ theme: a.theme });
    },
  }),
  defineTool({
    name: 'wp_rescue_maintenance',
    label: 'Pagină de mentenanță (salvare)',
    description: 'Afișează vizitatorilor o pagină de mentenanță (HTTP 503) prin trusa de salvare — util când site-ul e spart sau afișează erori. Administratorii au acces în continuare.',
    schema: z.object({ enabled: z.boolean(), message: z.string().max(300).optional() }),
    risk: 'write',
    contexts: OPS,
    requires: ['directadmin'],
    summarize: (a) => (a.enabled ? 'Afișează pagina de mentenanță vizitatorilor' : 'Oprește pagina de mentenanță'),
    async execute(a, ctx) {
      return needRescue(ctx).apply({ maintenance: a.enabled, ...(a.message ? { maintenance_message: a.message } : {}) });
    },
  }),
  defineTool({
    name: 'wp_rescue_clear',
    label: 'Anulez toate măsurile de salvare',
    description: 'Elimină complet trusa de salvare (reactivează pluginurile, tema normală, oprește captura erorilor și mentenanța).',
    schema: z.object({}),
    risk: 'write',
    contexts: OPS,
    requires: ['directadmin'],
    summarize: () => 'Elimină toate măsurile temporare de salvare WordPress',
    async execute(_a, ctx) {
      const r = needRescue(ctx);
      const st = await r.status();
      if (!st.active) throw new ToolFailure('Nu există măsuri de salvare active.');
      await r.remove();
      return { removed: true, previous: st.config };
    },
  }),
];
