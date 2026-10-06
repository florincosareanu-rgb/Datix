import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Services } from '../services';
import type { FindingInput } from '../monitoring/findings';
import { connectorSupports, type WpPluginIntegrity } from '../integrations/wordpress';
import { errorMessage } from '../util/text';

// Integritatea fișierelor WordPress: nucleul și pluginurile de pe wordpress.org (comparate cu sumele de
// control oficiale), fișiere PHP în uploads, plus conectorul DAX verificat separat, prin DirectAdmin
// (un canal independent de PHP-ul site-ului — un atacator care modifică pluginul nu poate ascunde asta).

export interface IntegrityResult {
  ok: boolean;
  message: string;
  findings: FindingInput[];
  details: {
    core: { checked: number; modified: string[]; unknown: string[]; missing: string[]; error?: string } | null;
    plugins: Array<Pick<WpPluginIntegrity, 'slug' | 'name' | 'version' | 'status' | 'modified' | 'added' | 'message'>>;
    uploadsPhp: string[];
    connector: { checked: number; modified: string[]; error?: string } | null;
  };
}

const list = (items: string[], max = 8) => `${items.slice(0, max).join(', ')}${items.length > max ? ` și încă ${items.length - max}` : ''}`;

function connectorFiles(dir: string, base = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.') || name === 'config.php') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) connectorFiles(p, base, out);
    else if (name.endsWith('.php')) out.push(p.slice(base.length + 1).replace(/\\/g, '/'));
  }
  return out;
}

/** Compară fișierele PHP ale conectorului de pe site (citite prin DirectAdmin) cu versiunea livrată de DAX. */
async function checkConnector(s: Services): Promise<IntegrityResult['details']['connector']> {
  const da = s.integrations.directadmin();
  const wpPath = s.settings.get().integrations.directadmin.wordpressPath;
  const src = join(s.config.integrationsDir, 'wordpress', 'dax-connector');
  if (!da || !wpPath || !existsSync(src)) return null;
  const modified: string[] = [];
  let checked = 0;
  try {
    for (const rel of connectorFiles(src)) {
      const expected = createHash('sha256').update(readFileSync(join(src, rel))).digest('hex');
      let remote: Buffer;
      try {
        remote = await da.downloadFile(`${wpPath.replace(/\/+$/, '')}/wp-content/plugins/dax-connector/${rel}`);
      } catch {
        continue; // versiune mai veche a pluginului (fișier inexistent) — nu e o modificare
      }
      checked++;
      if (createHash('sha256').update(remote).digest('hex') !== expected) modified.push(rel);
    }
    return { checked, modified };
  } catch (err) {
    return { checked, modified, error: errorMessage(err) };
  }
}

export async function runIntegrity(s: Services): Promise<IntegrityResult> {
  const wp = s.integrations.wordpress();
  if (!wp) return { ok: true, message: 'Pluginul WordPress nu e conectat.', findings: [], details: { core: null, plugins: [], uploadsPhp: [], connector: null } };
  const health = await wp.health();
  if (!connectorSupports(health.connector_version)) {
    return {
      ok: true,
      message: `Pluginul DAX Connector ${health.connector_version} e prea vechi — descarcă versiunea nouă din Setări → Integrări → WordPress.`,
      findings: [
        {
          key: 'connector_outdated',
          severity: 'low',
          title: 'Pluginul DAX Connector trebuie actualizat',
          recommendation: 'Descarcă pluginul din Setări → Integrări → WordPress și încarcă-l peste cel existent (verificarea integrității și actualizările sigure au nevoie de versiunea 1.1).',
        },
      ],
      details: { core: null, plugins: [], uploadsPhp: [], connector: null },
    };
  }

  const findings: FindingInput[] = [];
  const core = await wp.integrityCore();
  if (core.ok === null && core.error) {
    findings.push({ key: 'core_unverified', severity: 'info', title: 'Integritatea nucleului WordPress nu a putut fi verificată', details: core.error });
  }
  if (core.modified.length) {
    findings.push({
      key: 'core_modified',
      severity: 'critical',
      title: `${core.modified.length} fișiere ale nucleului WordPress sunt modificate`,
      details: list(core.modified),
      recommendation: 'Semn tipic de virus. Cere-i lui DAX să reinstaleze nucleul (wp_reinstall_component, tipul core) și apoi să ruleze un audit de securitate.',
    });
  }
  if (core.unknown.length) {
    findings.push({
      key: 'core_unknown',
      severity: 'critical',
      title: `${core.unknown.length} fișiere PHP străine în nucleul WordPress`,
      details: list(core.unknown),
      recommendation: 'Fișierele PHP care nu fac parte din WordPress în wp-admin / wp-includes / rădăcină sunt aproape mereu cod malițios. Verifică-le cu DAX (da_read_file) și mută-le în coș.',
    });
  }

  const plugins: WpPluginIntegrity[] = [];
  let offset: number | null = 0;
  for (let i = 0; offset !== null && i < 20; i++) {
    const page = await wp.integrityPlugins(offset);
    plugins.push(...page.results);
    offset = page.next;
  }
  for (const p of plugins.filter((x) => x.status === 'modified')) {
    findings.push({
      key: `plugin:${p.slug}`,
      severity: p.added.length ? 'critical' : 'high',
      title: `Pluginul ${p.name} ${p.version} are fișiere ${p.added.length ? 'adăugate' : 'modificate'} față de versiunea oficială`,
      details: [p.modified.length ? `Modificate: ${list(p.modified)}` : null, p.added.length ? `Adăugate: ${list(p.added)}` : null].filter(Boolean).join(' · '),
      recommendation: `Dacă nu l-ai modificat tu, reinstalează-l din sursa oficială (cere-i lui DAX: „reinstalează ${p.name}”).`,
    });
  }

  const uploads = await wp.integrityUploads();
  if (uploads.php_files.length) {
    findings.push({
      key: 'uploads_php',
      severity: 'critical',
      title: `${uploads.php_files.length} fișiere PHP în directorul de încărcări (uploads)`,
      details: list(uploads.php_files.map((f) => f.path)),
      recommendation: 'În uploads nu ar trebui să existe cod PHP: e locul preferat al programelor malițioase. Verifică-le și mută-le în coș.',
    });
  }

  const connector = await checkConnector(s);
  if (connector?.modified.length) {
    findings.push({
      key: 'connector_modified',
      severity: 'critical',
      title: 'Fișierele pluginului DAX Connector de pe site diferă de versiunea DAX',
      details: list(connector.modified),
      recommendation: 'Fie pluginul e o versiune mai veche, fie a fost modificat. Descarcă-l din nou din Setări → Integrări → WordPress și reinstalează-l.',
    });
  }

  const verified = plugins.filter((p) => p.status === 'ok' || p.status === 'modified').length;
  const unverifiable = plugins.filter((p) => p.status === 'unverifiable').length;
  const bad = findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
  return {
    ok: !bad.length,
    message: bad.length
      ? `${bad.length} probleme de integritate: ${bad[0]!.title}.`
      : `Fișiere originale: nucleu (${core.checked ?? 0} fișiere), ${verified} pluginuri verificate${unverifiable ? `, ${unverifiable} neverificabile (premium)` : ''}${connector ? ', conector DAX OK' : ''}.`,
    findings,
    details: {
      core: { checked: core.checked ?? 0, modified: core.modified, unknown: core.unknown, missing: core.missing, ...(core.error ? { error: core.error } : {}) },
      plugins: plugins.map((p) => ({ slug: p.slug, name: p.name, version: p.version, status: p.status, modified: p.modified, added: p.added, message: p.message })),
      uploadsPhp: uploads.php_files.map((f) => f.path),
      connector,
    },
  };
}
