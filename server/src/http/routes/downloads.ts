import type { FastifyInstance } from 'fastify';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Services } from '../../services';
import { HttpError, clientIp, requireStepUp } from '../context';
import { createZip, type ZipEntry } from '../../util/zip';

// Descărcări cu datele de conectare deja completate: pluginul WordPress și hook-ul WHMCS.
// Conțin cheia secretă, deci cer confirmare (Face ID / cod 2FA) și nu se păstrează în cache.

const PLUGIN_SLUG = 'datix-ai-connector';

/** Text sigur într-un șir PHP între apostrofuri. */
export function phpString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function pluginConfigPhp(secret: string, agentUrl: string, now = new Date()): string {
  return [
    '<?php',
    `// Generat automat de Datix AI (${now.toISOString().slice(0, 10)}). Conține cheia de conectare — nu publica acest fișier.`,
    '',
    "if (!defined('ABSPATH')) {",
    '    exit;',
    '}',
    '',
    "if (!defined('DATIX_AI_SECRET')) {",
    `    define('DATIX_AI_SECRET', ${phpString(secret)});`,
    '}',
    "if (!defined('DATIX_AI_AGENT_URL')) {",
    `    define('DATIX_AI_AGENT_URL', ${phpString(agentUrl)});`,
    '}',
    '',
  ].join('\n');
}

export function whmcsHookPhp(template: string, secret: string, agentUrl: string): string {
  const url = "'%%DATIX_AI_URL%%'";
  const key = "'%%DATIX_AI_SECRET%%'";
  // fiecare marcaj trebuie să apară exact o dată, altfel fișierul ar pleca fără cheie sau cu valori amestecate
  if (template.split(url).length !== 2 || template.split(key).length !== 2) throw new Error('Șablonul hook-ului WHMCS nu are formatul așteptat.');
  return template.replace(url, phpString(agentUrl)).replace(key, phpString(secret));
}

function collect(dir: string, prefix: string, out: ZipEntry[]): void {
  out.push({ name: `${prefix}/`, mtime: statSync(dir).mtime });
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.') || name === 'config.php') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) collect(p, `${prefix}/${name}`, out);
    else out.push({ name: `${prefix}/${name}`, data: readFileSync(p), mtime: st.mtime });
  }
}

export function buildPluginZip(integrationsDir: string, secret: string, agentUrl: string): Buffer {
  const src = join(integrationsDir, 'wordpress', PLUGIN_SLUG);
  if (!existsSync(src)) throw new Error(`Nu găsesc sursele pluginului în ${src}.`);
  const entries: ZipEntry[] = [];
  collect(src, PLUGIN_SLUG, entries);
  entries.push({ name: `${PLUGIN_SLUG}/config.php`, data: Buffer.from(pluginConfigPhp(secret, agentUrl), 'utf8') });
  return createZip(entries);
}

export function downloadRoutes(app: FastifyInstance, s: Services) {
  app.get('/api/downloads/wordpress-plugin.zip', async (req, reply) => {
    requireStepUp(req, s);
    const secret = s.secrets.ensureGenerated('wordpress.secret');
    let zip: Buffer;
    try {
      zip = buildPluginZip(s.config.integrationsDir, secret, s.config.appUrl);
    } catch (err) {
      throw new HttpError(500, err instanceof Error ? err.message : String(err));
    }
    // descărcarea pluginului înseamnă că vrei conectarea: activăm integrarea
    if (!s.settings.get().integrations.wordpress.enabled) {
      s.settings.update({ integrations: { wordpress: { enabled: true } } });
      s.monitoring.syncBuiltin();
      s.bus.emit({ type: 'settings_changed' });
    }
    s.audit.log({ actor: 'owner', action: 'download.wordpress_plugin', ip: clientIp(req) });
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="${PLUGIN_SLUG}.zip"`)
      .header('Cache-Control', 'no-store')
      .send(zip);
  });

  app.get('/api/downloads/whmcs-hook.php', async (req, reply) => {
    requireStepUp(req, s);
    const path = join(s.config.integrationsDir, 'whmcs', 'datix_ai.php');
    if (!existsSync(path)) throw new HttpError(500, `Nu găsesc șablonul hook-ului WHMCS în ${path}.`);
    const secret = s.secrets.ensureGenerated('whmcs.webhookSecret');
    const php = whmcsHookPhp(readFileSync(path, 'utf8'), secret, s.config.appUrl);
    s.audit.log({ actor: 'owner', action: 'download.whmcs_hook', ip: clientIp(req) });
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', 'attachment; filename="datix_ai.php"')
      .header('Cache-Control', 'no-store')
      .send(php);
  });
}
