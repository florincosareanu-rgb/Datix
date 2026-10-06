import type { MonitorKind, MonitorStatus, Severity } from '@datix/shared';
import type { Services } from '../services';
import type { FindingInput } from './findings';
import { summarizeHttpCheck } from '../integrations/net/httpCheck';
import { diffDns, type DnsSnapshot } from '../integrations/net/dns';
import { safeJsonParse, errorMessage } from '../util/text';
import { DAY, HOUR, MINUTE, formatDurationRo } from '../util/time';
import { runIntegrity } from '../maintenance/integrity';
import { formatBytes } from '../backups/service';

export interface MonitorRow {
  id: string;
  kind: MonitorKind;
  name: string;
  target: string;
  config: string;
  interval_sec: number;
  enabled: number;
  status: MonitorStatus;
  last_check_at: number | null;
  last_change_at: number | null;
  last_message: string | null;
  last_latency_ms: number | null;
  consecutive_failures: number;
  consecutive_successes: number;
  builtin: number;
  created_at: number;
}

export interface CheckOutcome {
  status: MonitorStatus;
  latencyMs: number | null;
  message: string;
  details?: unknown;
  /** Dacă o cădere confirmată a acestui monitor trebuie să deschidă un incident. */
  incidentWorthy?: boolean;
  incidentSeverity?: Severity;
}

type CheckFn = (s: Services, m: MonitorRow) => Promise<CheckOutcome>;

const cfg = <T>(m: MonitorRow) => safeJsonParse<T>(m.config, {} as T);

function lastSnapshot<T>(s: Services, kind: string, key: string): T | null {
  const r = s.db.prepare('SELECT data FROM snapshots WHERE kind = ? AND key = ? ORDER BY at DESC LIMIT 1').get(kind, key) as { data: string } | undefined;
  return r ? safeJsonParse<T | null>(r.data, null) : null;
}

function saveSnapshot(s: Services, kind: string, key: string, data: unknown, keepDays = 30): void {
  s.db.prepare('INSERT INTO snapshots (kind, key, at, data) VALUES (?, ?, ?, ?)').run(kind, key, Date.now(), JSON.stringify(data));
  s.db.prepare('DELETE FROM snapshots WHERE kind = ? AND key = ? AND at < ?').run(kind, key, Date.now() - keepDays * DAY);
}

const sevFromPct = (pct: number | null): Severity | null => (pct == null ? null : pct >= 98 ? 'critical' : pct >= 90 ? 'high' : pct >= 80 ? 'medium' : null);

// ------------------------------------------------------------------------------- verificări

const httpCheck: CheckFn = async (s, m) => {
  const c = cfg<{ url: string; keyword?: string }>(m);
  const st = s.settings.get();
  const r = await s.integrations.net.http({ url: c.url, keyword: c.keyword, slowThresholdMs: st.monitoring.slowThresholdMs, timeoutMs: 30_000 });
  const worst = r.problems.find((p) => p.severity === 'down') ?? r.problems.find((p) => p.severity === 'degraded');
  // la cădere, verificăm și originea (ocolind Cloudflare) — ajută enorm la diagnostic
  let origin: unknown = undefined;
  if (r.verdict === 'down' && st.sites.originIp) {
    const o = await s.integrations.net.http({ url: c.url, resolveTo: st.sites.originIp, insecure: true, timeoutMs: 20_000 }).catch(() => null);
    if (o) origin = { verdict: o.verdict, status: o.status, problems: o.problems.map((p) => p.message) };
  }
  const status: MonitorStatus = r.verdict === 'up' ? 'up' : r.verdict === 'degraded' ? 'degraded' : 'down';
  const ok = `HTTP ${r.status} în ${(r.timings.totalMs / 1000).toFixed(2)} s`;
  return {
    status,
    latencyMs: r.timings.totalMs,
    message: worst ? worst.message : ok,
    details: { ...summarizeHttpCheck(r), origin },
    incidentWorthy: !worst || worst.code !== 'cf_challenge',
    incidentSeverity: status === 'down' ? 'critical' : 'medium',
  };
};

const tlsCheck: CheckFn = async (s, m) => {
  const c = cfg<{ host: string; origin?: boolean }>(m);
  const ip = c.origin ? s.settings.get().sites.originIp : undefined;
  if (c.origin && !ip) return { status: 'unknown', latencyMs: null, message: 'IP-ul originii nu e setat.' };
  const r = await s.integrations.net.tls(c.host, { ip: ip || undefined, warnDays: 14 });
  const label = c.origin ? `Certificatul de pe serverul de hosting (${c.host})` : `Certificatul SSL ${c.host}`;
  const findings: FindingInput[] = [];
  if (r.verdict !== 'up') {
    findings.push({
      key: `${c.origin ? 'origin' : 'edge'}:${c.host}`,
      severity: r.verdict === 'down' ? 'critical' : r.info?.daysLeft != null && r.info.daysLeft <= 7 ? 'high' : 'medium',
      title: `${label}: ${r.message}`,
      details: r.info ? `Emitent: ${r.info.issuer}; expiră: ${r.info.validTo}` : r.error,
      recommendation: c.origin
        ? "Reînnoiește certificatul Let's Encrypt din DirectAdmin (agentul poate face asta cu da_renew_ssl)."
        : 'Verifică certificatul în Cloudflare (SSL/TLS → Edge Certificates) sau în DirectAdmin.',
    });
  }
  s.findings.report('tls', findings, { scopePrefix: `${c.origin ? 'origin' : 'edge'}:${c.host}` });
  return { status: r.verdict, latencyMs: null, message: r.message, details: r, incidentWorthy: r.verdict === 'down', incidentSeverity: 'high' };
};

const domainCheck: CheckFn = async (s, m) => {
  const c = cfg<{ domain: string }>(m);
  const r = await s.integrations.net.domainExpiry(c.domain);
  if (r.daysLeft == null) return { status: 'unknown', latencyMs: null, message: r.error ?? 'Nu am putut afla data expirării.', details: r };
  const status: MonitorStatus = r.daysLeft <= 7 ? 'down' : r.daysLeft <= 30 ? 'degraded' : 'up';
  const findings: FindingInput[] =
    status === 'up'
      ? []
      : [
          {
            key: c.domain,
            severity: r.daysLeft <= 7 ? 'critical' : 'high',
            title: `Domeniul ${c.domain} expiră în ${r.daysLeft} zile`,
            details: `Data expirării: ${r.expiresAt}${r.registrar ? `; registrar: ${r.registrar}` : ''}.`,
            recommendation: 'Reînnoiește domeniul cât mai curând — la expirare cad site-ul și e-mailul.',
          },
        ];
  s.findings.report('domain', findings, { scopePrefix: c.domain });
  return { status, latencyMs: null, message: `Expiră pe ${r.expiresAt?.slice(0, 10)} (în ${r.daysLeft} zile).`, details: r };
};

const dnsCheck: CheckFn = async (s, m) => {
  const c = cfg<{ domain: string }>(m);
  const resolvers = s.settings.get().monitoring.dnsResolvers;
  const snap = await s.integrations.net.dns(c.domain, ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CAA'], resolvers);
  const prev = lastSnapshot<DnsSnapshot>(s, 'dns', c.domain);
  const email = await s.integrations.net.emailAuth(c.domain, resolvers).catch(() => null);
  const findings: FindingInput[] = [];
  if (email) {
    if (!email.spf)
      findings.push({ key: `${c.domain}:spf`, severity: 'medium', title: `Domeniul ${c.domain} nu are SPF`, recommendation: 'Adaugă o înregistrare TXT SPF (ex. „v=spf1 a mx include:… ~all”) ca e-mailurile să nu ajungă în spam.' });
    if (email.spfCount > 1) findings.push({ key: `${c.domain}:spf_multi`, severity: 'medium', title: `Domeniul ${c.domain} are mai multe înregistrări SPF`, recommendation: 'Păstrează o singură înregistrare SPF (mai multe = SPF invalid).' });
    if (!email.dmarc)
      findings.push({ key: `${c.domain}:dmarc`, severity: 'low', title: `Domeniul ${c.domain} nu are DMARC`, recommendation: 'Adaugă _dmarc TXT „v=DMARC1; p=none; rua=mailto:…” și apoi crește politica la quarantine.' });
  }
  if (!prev) {
    saveSnapshot(s, 'dns', c.domain, snap, 90);
    s.findings.report('dns', findings, { scopePrefix: `${c.domain}:` });
    return { status: 'up', latencyMs: null, message: 'Prima înregistrare a configurației DNS (referință pentru modificări).', details: snap };
  }
  const changes = diffDns(prev, snap);
  if (changes.length) {
    saveSnapshot(s, 'dns', c.domain, snap, 90);
    const critical = changes.some((ch) => ch.type === 'NS' || ch.type === 'A' || ch.type === 'MX');
    const text = changes.map((ch) => `${ch.type}: ${ch.added.length ? `+ ${ch.added.join(', ')}` : ''}${ch.removed.length ? ` − ${ch.removed.join(', ')}` : ''}`).join('\n');
    s.findings.report(
      'dns',
      [
        ...findings,
        {
          key: `${c.domain}:event:change:${Date.now()}`,
          severity: critical ? 'high' : 'medium',
          title: `Modificare DNS detectată la ${c.domain}`,
          details: text,
          recommendation: 'Dacă nu ai făcut tu această modificare, verifică imediat contul de la registrar/Cloudflare (posibil acces neautorizat).',
        },
      ],
      { scopePrefix: `${c.domain}:` },
    );
    return { status: 'degraded', latencyMs: null, message: `Modificări DNS: ${changes.map((ch) => ch.type).join(', ')}`, details: { changes } };
  }
  // modificările DNS anterioare rămân deschise (evenimente) până le marchezi rezolvate
  s.findings.report('dns', findings, { scopePrefix: `${c.domain}:` });
  return { status: 'up', latencyMs: null, message: 'Configurația DNS e neschimbată.', details: { records: snap.records } };
};

const blacklistCheck: CheckFn = async (s, m) => {
  const c = cfg<{ targets: string[] }>(m);
  const targets = [...new Set(c.targets.filter(Boolean))];
  const originIp = s.settings.get().sites.originIp;
  if (originIp && !targets.includes(originIp)) targets.push(originIp);
  const results = await Promise.all(targets.map((t) => s.integrations.net.blacklist(t)));
  const findings: FindingInput[] = [];
  for (const r of results) {
    for (const list of r.listedOn) {
      findings.push({
        key: `${r.target}:${list}`,
        severity: 'high',
        title: `${r.kind === 'ip' ? 'IP-ul' : 'Domeniul'} ${r.target} e pe lista neagră ${list}`,
        details: 'E-mailurile trimise pot fi respinse sau marcate ca spam.',
        recommendation:
          r.kind === 'ip'
            ? 'Pe hosting partajat, IP-ul e comun cu alți clienți: anunță furnizorul de hosting și cere delistarea / alt IP de trimitere.'
            : 'Verifică dacă site-ul a fost compromis (spam), apoi cere delistarea din formularul listei.',
      });
    }
  }
  s.findings.report('blacklist', findings);
  const listed = results.flatMap((r) => r.listedOn.map((l) => `${r.target}@${l}`));
  return {
    status: listed.length ? 'degraded' : 'up',
    latencyMs: null,
    message: listed.length ? `Listat pe: ${listed.join(', ')}` : `Curat pe toate listele (${targets.length} ținte verificate).`,
    details: results,
  };
};

const pagespeedCheck: CheckFn = async (s, m) => {
  const c = cfg<{ url: string }>(m);
  const [mobile, desktop] = await Promise.all([
    s.integrations.net.pagespeed(c.url, 'mobile', s.integrations.pagespeedKey()),
    s.integrations.net.pagespeed(c.url, 'desktop', s.integrations.pagespeedKey()),
  ]);
  const prev = lastSnapshot<{ mobile: { scores: { performance: number | null } } }>(s, 'pagespeed', c.url);
  saveSnapshot(s, 'pagespeed', c.url, { mobile, desktop }, 180);
  const perf = mobile.scores.performance ?? 0;
  const prevPerf = prev?.mobile.scores.performance ?? null;
  const findings: FindingInput[] = [];
  if (perf < 50)
    findings.push({
      key: `${c.url}:slow`,
      severity: 'medium',
      title: `Scor de viteză slab pe mobil: ${perf}/100 (${new URL(c.url).hostname})`,
      details: mobile.opportunities.map((o) => `${o.title}${o.savingsMs ? ` (~${(o.savingsMs / 1000).toFixed(1)} s)` : ''}`).join('\n') || null,
      recommendation: 'Optimizează imaginile, activează cache-ul (LiteSpeed Cache / WP Rocket) și reduce scripturile încărcate.',
    });
  if (prevPerf != null && prevPerf - perf >= 15)
    findings.push({
      key: `${c.url}:drop`,
      severity: 'medium',
      title: `Viteza pe mobil a scăzut de la ${prevPerf} la ${perf}`,
      details: 'Scădere bruscă față de măsurătoarea anterioară — posibil un plugin nou, imagini mari sau o problemă de server.',
      recommendation: 'Verifică ce s-a schimbat recent pe site.',
    });
  s.findings.report('pagespeed', findings, { scopePrefix: c.url });
  return {
    status: perf >= 50 ? 'up' : 'degraded',
    latencyMs: mobile.lab.lcpMs,
    message: `Mobil ${mobile.scores.performance ?? '?'}/100, desktop ${desktop.scores.performance ?? '?'}/100, SEO ${mobile.scores.seo ?? '?'}/100.`,
    details: { mobile, desktop },
  };
};

const securityScanCheck: CheckFn = async (s, m) => {
  const c = cfg<{ url: string; kind: 'wordpress' | 'whmcs' | 'generic' }>(m);
  const r = await s.integrations.net.securityScan(c.url, c.kind);
  const host = new URL(c.url).hostname;
  s.findings.report(
    'scan',
    r.findings.map((f) => ({ key: f.key, severity: f.severity, title: f.title, details: f.details, recommendation: f.recommendation })),
    { scopePrefix: `${host}:` },
  );
  const serious = r.findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
  return {
    status: serious.length ? 'degraded' : 'up',
    latencyMs: null,
    message: `Antete: nota ${r.headersGrade}. ${r.findings.length} constatări (${serious.length} grave).`,
    details: r,
  };
};

const wpHealthCheck: CheckFn = async (s) => {
  const wp = s.integrations.wordpress();
  if (!wp) return { status: 'unknown', latencyMs: null, message: 'Pluginul WordPress nu e conectat.' };
  const started = Date.now();
  const [health, admins] = await Promise.all([wp.health(), wp.admins().catch(() => null)]);
  const findings: FindingInput[] = [];
  if (health.updates.core) findings.push({ key: 'core_update', severity: 'high', title: `Actualizare WordPress disponibilă (${health.wp_version} → ${health.updates.core})`, recommendation: 'Fă un backup și actualizează (agentul poate face asta la cererea ta).' });
  if (health.updates.plugins > 0) findings.push({ key: 'plugin_updates', severity: health.updates.plugins >= 5 ? 'high' : 'medium', title: `${health.updates.plugins} pluginuri au actualizări disponibile`, recommendation: 'Pluginurile neactualizate sunt principala cauză a spargerilor WordPress.' });
  if (health.updates.themes > 0) findings.push({ key: 'theme_updates', severity: 'low', title: `${health.updates.themes} teme au actualizări disponibile` });
  if (health.flags.debug_display === true) findings.push({ key: 'debug_display', severity: 'medium', title: 'WP_DEBUG_DISPLAY e activ — erorile sunt afișate vizitatorilor', recommendation: 'Setează WP_DEBUG_DISPLAY la false în wp-config.php.' });
  if (health.flags.file_edit === true) findings.push({ key: 'file_edit', severity: 'low', title: 'Editorul de fișiere din wp-admin e activ', recommendation: 'Adaugă define("DISALLOW_FILE_EDIT", true) sau folosește wp_hardening.' });
  if (health.cron.overdue > 5 && !health.cron.disabled) findings.push({ key: 'cron_overdue', severity: 'low', title: `${health.cron.overdue} sarcini WP-Cron întârziate`, recommendation: 'Verifică dacă site-ul are trafic sau configurează un cron real.' });
  if (health.maintenance) findings.push({ key: 'maintenance', severity: 'medium', title: 'Modul mentenanță e activ pe WordPress' });
  if (health.flags.blog_public === false)
    findings.push({
      key: 'noindex',
      severity: 'high',
      title: 'WordPress cere motoarelor de căutare să nu indexeze site-ul',
      details: 'Setări → Citire → „Nu permite motoarelor de căutare să indexeze acest site” este bifat.',
      recommendation: 'Debifează opțiunea dacă site-ul e live — altfel site-ul dispare treptat din Google.',
    });
  if (health.flags.users_can_register === true && health.flags.default_role === 'administrator')
    findings.push({
      key: 'register_as_admin',
      severity: 'critical',
      title: 'Oricine se poate înregistra pe WordPress direct ca administrator',
      recommendation: 'Setări → Generale: debifează „Oricine se poate înregistra” sau schimbă rolul implicit în „Abonat”. Verifică apoi lista de administratori.',
    });
  // administratori noi = semnal de alarmă major
  if (admins) {
    const prev = lastSnapshot<Array<{ login: string }>>(s, 'wp_admins', 'wordpress');
    if (prev) {
      const before = new Set(prev.map((a) => a.login));
      for (const a of admins.filter((x) => !before.has(x.login))) {
        findings.push({
          key: `event:new_admin:${a.login}:${Date.now()}`,
          severity: 'critical',
          title: `Administrator WordPress nou: ${a.login} (${a.email})`,
          details: `Înregistrat: ${a.registered}`,
          recommendation: 'Dacă nu l-ai creat tu, site-ul poate fi compromis: șterge contul, schimbă parolele și cere agentului un audit de securitate.',
        });
      }
    }
    saveSnapshot(s, 'wp_admins', 'wordpress', admins, 90);
  }
  saveSnapshot(s, 'wp_health', 'wordpress', health, 30);
  s.findings.report('wp', findings);
  return {
    status: 'up',
    latencyMs: Date.now() - started,
    message: `WordPress ${health.wp_version}, PHP ${health.php_version}; actualizări: ${health.updates.plugins} pluginuri${health.updates.core ? ', nucleu' : ''}.`,
    details: health,
  };
};

const wpVulnCheck: CheckFn = async (s) => {
  const wp = s.integrations.wordpress();
  if (!wp) return { status: 'unknown', latencyMs: null, message: 'Pluginul WordPress nu e conectat.' };
  const [health, plugins] = await Promise.all([wp.health(), wp.plugins()]);
  const findings: FindingInput[] = [];
  let errors = 0;
  const add = async (type: 'core' | 'plugin' | 'theme', slug: string, version: string, active: boolean) => {
    try {
      for (const v of await s.integrations.net.wpVuln(type, slug, version)) {
        findings.push({
          key: `${type}:${slug}:${v.cve ?? v.title}`.slice(0, 200),
          severity: active ? v.severity : v.severity === 'critical' ? 'high' : 'medium',
          title: `Vulnerabilitate în ${type === 'core' ? 'WordPress' : slug} ${version}${active ? '' : ' (inactiv)'}: ${v.title}`,
          details: [v.cve, v.fixedIn ? `Rezolvat în ${v.fixedIn}` : v.unfixed ? 'Fără remediere încă' : null, v.link].filter(Boolean).join(' · '),
          recommendation: v.fixedIn ? `Actualizează la ${v.fixedIn} sau mai nou.` : active ? 'Dezactivează pluginul până apare o remediere.' : 'Șterge pluginul dacă nu îl folosești.',
        });
      }
    } catch {
      errors++;
    }
  };
  await add('core', 'wordpress', health.wp_version, true);
  if (health.theme?.stylesheet) await add('theme', health.theme.stylesheet, health.theme.version, true);
  for (const p of plugins) await add('plugin', p.slug, p.version, p.active);
  s.findings.report('wpvuln', findings);
  const serious = findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length;
  return {
    status: serious ? 'degraded' : 'up',
    latencyMs: null,
    message: findings.length ? `${findings.length} vulnerabilități cunoscute (${serious} grave).` : `Nicio vulnerabilitate cunoscută (${plugins.length + 2} componente${errors ? `, ${errors} neverificate` : ''}).`,
  };
};

const whmcsHealthCheck: CheckFn = async (s) => {
  const w = s.integrations.whmcs();
  if (!w) return { status: 'unknown', latencyMs: null, message: 'WHMCS nu e conectat.' };
  const started = Date.now();
  const details = await w.details();
  const findings: FindingInput[] = [];
  // cron-ul WHMCS (semnal de la hook-ul instalat în WHMCS)
  const lastCron = s.db.prepare("SELECT MAX(at) at FROM events_inbox WHERE source = 'whmcs' AND event = 'cron.heartbeat'").get() as { at: number | null };
  let cronMsg = 'cron: hook neinstalat';
  if (lastCron.at) {
    const age = Date.now() - lastCron.at;
    cronMsg = `cron: acum ${Math.round(age / MINUTE)} min`;
    if (age > 70 * MINUTE)
      findings.push({
        key: 'cron_stale',
        severity: age > 6 * HOUR ? 'critical' : 'high',
        title: `Cron-ul WHMCS nu a mai rulat de ${Math.round(age / MINUTE)} minute`,
        details: 'Fără cron nu se generează facturi, nu se trimit e-mailuri automate și nu se suspendă/reactivează servicii.',
        recommendation: 'Verifică jobul cron din DirectAdmin (php -q …/crons/cron.php) și jurnalul WHMCS → Utilities → Logs → Module/Automation.',
      });
  } else {
    findings.push({ key: 'cron_hook_missing', severity: 'info', title: 'Hook-ul DAX nu e instalat în WHMCS', recommendation: 'Copiază fișierul dax.php în includes/hooks (vezi ghidul) pentru tichete instant și verificarea cron-ului.' });
  }
  // administratori noi
  const admins = await w.getAdminUsers().catch(() => null);
  if (admins) {
    const prev = lastSnapshot<Array<{ username: string }>>(s, 'whmcs_admins', 'whmcs');
    if (prev) {
      const before = new Set(prev.map((a) => a.username));
      for (const a of admins.filter((x) => !before.has(x.username))) {
        findings.push({
          key: `event:new_admin:${a.username}:${Date.now()}`,
          severity: 'critical',
          title: `Administrator WHMCS nou: ${a.username} (${a.email})`,
          recommendation: 'Dacă nu l-ai creat tu, dezactivează-l imediat, schimbă parolele și verifică jurnalul de activitate.',
        });
      }
    }
    saveSnapshot(s, 'whmcs_admins', 'whmcs', admins, 90);
  }
  // autentificări eșuate recente
  const log = await w.getActivityLog({ limitnum: 200 }).catch(() => []);
  const hourAgo = Date.now() - HOUR;
  const failed = log.filter((e) => /failed (admin )?login|login failed|incorrect password/i.test(e.description) && new Date(e.date.replace(' ', 'T')).getTime() > hourAgo);
  if (failed.length >= 10) {
    const ips = [...new Set(failed.map((f) => f.ip).filter(Boolean))].slice(0, 5);
    findings.push({
      key: `event:failed_logins:${new Date().toISOString().slice(0, 13)}`,
      severity: 'high',
      title: `${failed.length} autentificări eșuate în WHMCS în ultima oră`,
      details: `IP-uri: ${ips.join(', ') || 'necunoscute'}`,
      recommendation: 'Posibil atac de ghicire a parolelor: blochează IP-urile în Cloudflare și verifică 2FA pentru administratori.',
    });
  }
  s.findings.report('whmcs', findings);
  const bad = findings.some((f) => f.severity === 'critical' || f.severity === 'high');
  return { status: bad ? 'degraded' : 'up', latencyMs: Date.now() - started, message: `WHMCS ${details.version}; ${cronMsg}.` };
};

const daUsageCheck: CheckFn = async (s) => {
  const da = s.integrations.directadmin();
  if (!da) return { status: 'unknown', latencyMs: null, message: 'DirectAdmin nu e conectat.' };
  const started = Date.now();
  const u = await da.usage();
  const findings: FindingInput[] = [];
  const addPct = (key: string, label: string, pct: number | null, used: number | null, limit: number | null, unit: string) => {
    const sev = sevFromPct(pct);
    if (sev)
      findings.push({
        key,
        severity: sev,
        title: `${label} folosit ${pct}% (${used}${unit} din ${limit}${unit})`,
        recommendation: key === 'disk' ? 'Șterge backup-urile și logurile vechi sau cere un pachet mai mare.' : key === 'inode' ? 'Prea multe fișiere: curăță cache-urile/sesiunile vechi.' : 'Traficul lunar se apropie de limită.',
      });
  };
  addPct('disk', 'Spațiul pe disc', u.diskPct, u.diskMb != null ? Math.round(u.diskMb) : null, u.diskLimitMb, ' MB');
  addPct('inode', 'Numărul de fișiere (inode)', u.inodePct, u.inodes, u.inodeLimit, '');
  addPct('bandwidth', 'Traficul lunar', u.bandwidthPct, u.bandwidthMb != null ? Math.round(u.bandwidthMb) : null, u.bandwidthLimitMb, ' MB');
  if (u.suspended) findings.push({ key: 'suspended', severity: 'critical', title: 'Contul de hosting e SUSPENDAT', recommendation: 'Contactează imediat furnizorul de hosting.' });
  s.findings.report('hosting', findings);
  saveSnapshot(s, 'da_usage', 'account', { ...u, raw: undefined }, 90);
  const worst = findings.find((f) => f.severity === 'critical' || f.severity === 'high');
  return {
    status: u.suspended ? 'down' : worst ? 'degraded' : 'up',
    latencyMs: Date.now() - started,
    message: `Disc ${u.diskPct ?? '?'}% · inode ${u.inodePct ?? '?'}% · trafic ${u.bandwidthPct ?? '?'}%${u.suspended ? ' · SUSPENDAT' : ''}`,
    details: { ...u, raw: undefined },
    incidentWorthy: u.suspended,
    incidentSeverity: 'critical',
  };
};

const businessCheck: CheckFn = async (s) => {
  const snap = await s.business.refresh();
  if (!snap) return { status: 'unknown', latencyMs: null, message: 'WHMCS nu e conectat.' };
  const fmt = (n: number | null) => (n == null ? '?' : `${snap.currencyPrefix}${n.toLocaleString('ro-RO')}${snap.currencySuffix}`);
  return { status: 'up', latencyMs: null, message: `Încasări luna aceasta: ${fmt(snap.incomeThisMonth)}; facturi neplătite: ${snap.unpaidInvoices ?? '?'}; comenzi în așteptare: ${snap.ordersPending ?? '?'}.` };
};

const ticketsPollCheck: CheckFn = async (s) => {
  const r = await s.tickets.poll();
  return { status: 'up', latencyMs: null, message: r.message };
};

const cfSecurityCheck: CheckFn = async (s) => {
  const cf = s.integrations.cloudflare();
  if (!cf) return { status: 'unknown', latencyMs: null, message: 'Cloudflare nu e conectat.' };
  const ev = await cf.securityEvents(1, 20);
  const prev = lastSnapshot<{ total: number }[]>(s, 'cf_security_hourly', 'zone') ?? [];
  const history = [...prev, { total: ev.total }].slice(-48);
  saveSnapshot(s, 'cf_security_hourly', 'zone', history, 7);
  const avg = prev.length ? prev.reduce((a, b) => a + b.total, 0) / prev.length : 0;
  const spike = ev.total >= 300 && ev.total > Math.max(5 * avg, 300);
  if (spike) {
    s.findings.report('cloudflare', [
      {
        key: `event:spike:${new Date().toISOString().slice(0, 13)}`,
        severity: 'high',
        title: `Val de trafic blocat de Cloudflare: ${ev.total} evenimente în ultima oră`,
        details: `Top IP-uri: ${ev.topIps.slice(0, 3).map((i) => `${i.ip} (${i.count})`).join(', ')}; țări: ${ev.topCountries.slice(0, 3).map((c) => c.country).join(', ')}`,
        recommendation: 'Posibil atac. Dacă site-ul încetinește, agentul poate activa modul „Under Attack” în Cloudflare.',
      },
    ]);
  }
  return { status: spike ? 'degraded' : 'up', latencyMs: null, message: `${ev.total} evenimente de securitate în ultima oră (medie ${Math.round(avg)}).`, details: ev };
};

const resellerAccountsCheck: CheckFn = async (s) => {
  const r = s.integrations.reseller();
  if (!r) return { status: 'unknown', latencyMs: null, message: 'Contul de reseller nu e activat.' };
  const users = await r.listUsers();
  const findings: FindingInput[] = [];
  for (const u of users.slice(0, 100)) {
    try {
      const usage = await r.usage(u);
      const sev = sevFromPct(usage.diskPct);
      if (sev && sev !== 'medium') findings.push({ key: `${u}:disk`, severity: sev === 'critical' ? 'high' : 'medium', title: `Clientul ${u} a folosit ${usage.diskPct}% din spațiul pe disc` });
      if (usage.suspended) findings.push({ key: `${u}:suspended`, severity: 'info', title: `Contul clientului ${u} e suspendat` });
    } catch {
      /* ignorăm un cont care nu răspunde */
    }
  }
  s.findings.report('reseller', findings);
  return { status: 'up', latencyMs: null, message: `${users.length} conturi de clienți verificate; ${findings.length} atenționări.` };
};

const backupCheck: CheckFn = async (s) => {
  if (!s.settings.get().backups.enabled) return { status: 'unknown', latencyMs: null, message: 'Backup-ul zilnic verificat e oprit.' };
  const last = s.backups.runs(1)[0] ?? null;
  const ok = s.backups.lastOk();
  if (!ok) {
    return {
      status: last?.status === 'failed' ? 'down' : 'unknown',
      latencyMs: null,
      message: last ? (last.status === 'running' ? 'Prima rulare e în curs…' : `Ultima rulare a eșuat: ${last.error ?? 'eroare'}`) : 'Încă nicio copie verificată (prima rulare e programată).',
    };
  }
  const age = Date.now() - ok.startedAt;
  const status = age > 50 * HOUR ? 'down' : age > 26 * HOUR || last?.status === 'failed' || ok.status === 'warning' ? 'degraded' : 'up';
  return {
    status,
    latencyMs: null,
    message: `Ultima copie verificată acum ${formatDurationRo(age)} · ${formatBytes(ok.sizeBytes)}${ok.encrypted ? ' · criptată' : ''} · ${ok.destination ?? ''}${last && last.status === 'failed' ? ` · ultima rulare a eșuat: ${last.error ?? ''}` : ''}`,
    details: { last, ok },
  };
};

const wpIntegrityCheck: CheckFn = async (s) => {
  const r = await runIntegrity(s);
  s.findings.report('integrity', r.findings);
  return { status: r.ok ? 'up' : 'degraded', latencyMs: null, message: r.message, details: r.details };
};

const emailDeliveryCheck: CheckFn = async (s) => {
  const r = await s.email.check();
  return { status: r.status, latencyMs: null, message: r.message, details: r.details };
};

const efacturaCheck: CheckFn = async (s) => {
  const r = await s.efactura.check();
  return { status: r.status, latencyMs: null, message: r.message, details: r.details };
};

export const CHECKS: Record<MonitorKind, CheckFn> = {
  http: httpCheck,
  tls: tlsCheck,
  domain: domainCheck,
  dns: dnsCheck,
  blacklist: blacklistCheck,
  pagespeed: pagespeedCheck,
  security_scan: securityScanCheck,
  wp_health: wpHealthCheck,
  wp_vulns: wpVulnCheck,
  whmcs_health: whmcsHealthCheck,
  da_usage: daUsageCheck,
  business: businessCheck,
  tickets_poll: ticketsPollCheck,
  cloudflare_security: cfSecurityCheck,
  reseller_accounts: resellerAccountsCheck,
  backup: backupCheck,
  wp_integrity: wpIntegrityCheck,
  email_delivery: emailDeliveryCheck,
  efactura: efacturaCheck,
};

export async function runCheck(s: Services, m: MonitorRow): Promise<CheckOutcome> {
  try {
    return await CHECKS[m.kind](s, m);
  } catch (err) {
    return { status: m.kind === 'http' ? 'down' : 'unknown', latencyMs: null, message: errorMessage(err), incidentWorthy: m.kind === 'http' };
  }
}
