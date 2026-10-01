import type { CheckResultDTO, MonitorDTO, MonitorKind, MonitorStatus } from '@datix/shared';
import type { Services } from '../services';
import { runCheck, type MonitorRow } from './checks';
import { DAY, HOUR } from '../util/time';
import { truncate } from '../util/text';

interface BuiltinDef {
  id: string;
  kind: MonitorKind;
  name: string;
  target: string;
  intervalSec: number;
  config: Record<string, unknown>;
}

const rootDomain = (host: string) => host.replace(/^www\./, '').split('.').slice(-2).join('.');
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

/** Monitorizarea: monitoare definite din setări, programare, rezultate, disponibilitate, incidente. */
export class MonitoringService {
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();
  private readonly concurrency = 4;

  constructor(private readonly s: Services) {}

  // ------------------------------------------------------------ definiții

  private builtinDefs(): BuiltinDef[] {
    const st = this.s.settings.get();
    const i = this.s.integrations;
    const defs: BuiltinDef[] = [];
    const wpUrl = st.sites.wordpressUrl;
    const whmcsUrl = st.sites.whmcsUrl;
    const iv = st.monitoring.uptimeIntervalSec;
    if (wpUrl) {
      defs.push({ id: 'site-wp', kind: 'http', name: 'Site datix.ro', target: wpUrl, intervalSec: iv, config: { url: wpUrl, keyword: st.sites.wordpressKeyword } });
      defs.push({ id: 'tls-wp', kind: 'tls', name: `SSL ${hostOf(wpUrl)}`, target: hostOf(wpUrl), intervalSec: 6 * 3600, config: { host: hostOf(wpUrl) } });
      defs.push({ id: 'secscan-wp', kind: 'security_scan', name: `Scanare securitate ${hostOf(wpUrl)}`, target: wpUrl, intervalSec: 24 * 3600, config: { url: wpUrl, kind: 'wordpress' } });
      if (st.integrations.pagespeed.enabled)
        defs.push({ id: 'pagespeed-wp', kind: 'pagespeed', name: `Viteză (PageSpeed) ${hostOf(wpUrl)}`, target: wpUrl, intervalSec: 24 * 3600, config: { url: wpUrl } });
    }
    if (whmcsUrl) {
      defs.push({ id: 'site-whmcs', kind: 'http', name: 'Zona clienți my.datix.ro', target: whmcsUrl, intervalSec: iv, config: { url: whmcsUrl, keyword: st.sites.whmcsKeyword } });
      defs.push({ id: 'tls-whmcs', kind: 'tls', name: `SSL ${hostOf(whmcsUrl)}`, target: hostOf(whmcsUrl), intervalSec: 6 * 3600, config: { host: hostOf(whmcsUrl) } });
      defs.push({ id: 'secscan-whmcs', kind: 'security_scan', name: `Scanare securitate ${hostOf(whmcsUrl)}`, target: whmcsUrl, intervalSec: 24 * 3600, config: { url: whmcsUrl, kind: 'whmcs' } });
    }
    if (st.sites.originIp && wpUrl) {
      defs.push({ id: 'tls-origin', kind: 'tls', name: 'SSL pe serverul de hosting', target: `${hostOf(wpUrl)} @ ${st.sites.originIp}`, intervalSec: 12 * 3600, config: { host: hostOf(wpUrl), origin: true } });
    }
    const domain = rootDomain(hostOf(wpUrl || whmcsUrl));
    if (domain) {
      defs.push({ id: 'domain-main', kind: 'domain', name: `Expirare domeniu ${domain}`, target: domain, intervalSec: 24 * 3600, config: { domain } });
      defs.push({ id: 'dns-main', kind: 'dns', name: `DNS ${domain}`, target: domain, intervalSec: 15 * 60, config: { domain } });
      defs.push({ id: 'blacklist', kind: 'blacklist', name: 'Liste negre (spam)', target: domain, intervalSec: 6 * 3600, config: { targets: [domain] } });
    }
    st.sites.extraUrls.forEach((url, idx) => {
      defs.push({ id: `extra-${idx}`, kind: 'http', name: hostOf(url) || url, target: url, intervalSec: iv * 2, config: { url } });
    });
    if (i.isConfigured('wordpress')) {
      defs.push({ id: 'wp-health', kind: 'wp_health', name: 'WordPress (stare, actualizări, administratori)', target: st.integrations.wordpress.url, intervalSec: 15 * 60, config: {} });
      defs.push({ id: 'wp-vulns', kind: 'wp_vulns', name: 'Vulnerabilități WordPress', target: st.integrations.wordpress.url, intervalSec: 24 * 3600, config: {} });
    }
    if (i.isConfigured('whmcs')) {
      defs.push({ id: 'whmcs-health', kind: 'whmcs_health', name: 'WHMCS (API, cron, administratori)', target: st.integrations.whmcs.url, intervalSec: 15 * 60, config: {} });
      defs.push({ id: 'business', kind: 'business', name: 'Cifre de business', target: 'WHMCS', intervalSec: 3600, config: {} });
      defs.push({ id: 'tickets-poll', kind: 'tickets_poll', name: 'Tichete noi', target: 'WHMCS', intervalSec: st.tickets.pollIntervalSec, config: {} });
    }
    if (i.isConfigured('directadmin')) defs.push({ id: 'da-usage', kind: 'da_usage', name: 'Resurse hosting (disc, inode, trafic)', target: st.integrations.directadmin.username || 'DirectAdmin', intervalSec: 3600, config: {} });
    if (i.isConfigured('cloudflare')) defs.push({ id: 'cf-security', kind: 'cloudflare_security', name: 'Cloudflare (atacuri blocate)', target: st.integrations.cloudflare.zoneName, intervalSec: 3600, config: {} });
    if (i.isConfigured('reseller')) defs.push({ id: 'reseller-accounts', kind: 'reseller_accounts', name: 'Conturile clienților (reseller)', target: st.integrations.reseller.username, intervalSec: 3600, config: {} });
    return defs;
  }

  /** Sincronizează monitoarele predefinite cu setările curente. */
  syncBuiltin(): void {
    const defs = this.builtinDefs();
    const ids = new Set(defs.map((d) => d.id));
    const now = Date.now();
    const tx = this.s.db.transaction(() => {
      for (const d of defs) {
        const existing = this.s.db.prepare('SELECT id, target, config FROM monitors WHERE id = ?').get(d.id) as { id: string; target: string; config: string } | undefined;
        if (!existing) {
          this.s.db
            .prepare('INSERT INTO monitors (id, kind, name, target, config, interval_sec, enabled, builtin, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)')
            .run(d.id, d.kind, d.name, d.target, JSON.stringify(d.config), d.intervalSec, now);
        } else {
          const changedTarget = existing.target !== d.target || existing.config !== JSON.stringify(d.config);
          this.s.db
            .prepare(`UPDATE monitors SET kind = ?, name = ?, target = ?, config = ?, interval_sec = ? ${changedTarget ? ", status = 'unknown', consecutive_failures = 0, consecutive_successes = 0" : ''} WHERE id = ?`)
            .run(d.kind, d.name, d.target, JSON.stringify(d.config), d.intervalSec, d.id);
        }
      }
      const builtins = this.s.db.prepare('SELECT id FROM monitors WHERE builtin = 1').all() as Array<{ id: string }>;
      for (const b of builtins) if (!ids.has(b.id)) this.s.db.prepare('DELETE FROM monitors WHERE id = ?').run(b.id);
    });
    tx();
  }

  // ------------------------------------------------------------ programare

  start(): void {
    if (this.timer) return;
    this.syncBuiltin();
    this.timer = setInterval(() => this.tick(), 5000);
    this.timer.unref();
    setTimeout(() => this.tick(), 3000).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const now = Date.now();
    const due = (this.s.db.prepare('SELECT * FROM monitors WHERE enabled = 1').all() as MonitorRow[])
      .filter((m) => !this.running.has(m.id) && (!m.last_check_at || now - m.last_check_at >= m.interval_sec * 1000))
      .sort((a, b) => (a.kind === 'http' ? -1 : 0) - (b.kind === 'http' ? -1 : 0) || (a.last_check_at ?? 0) - (b.last_check_at ?? 0));
    for (const m of due) {
      if (this.running.size >= this.concurrency) break;
      void this.execute(m);
    }
  }

  async runNow(id: string): Promise<CheckResultDTO & { monitor: string }> {
    const m = this.s.db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as MonitorRow | undefined;
    if (!m) throw new Error(`Monitorul „${id}” nu există.`);
    const r = await this.execute(m);
    return { monitor: m.name, ...r };
  }

  private async execute(m: MonitorRow): Promise<CheckResultDTO> {
    this.running.add(m.id);
    // marcăm imediat ca să nu fie preluat de două ori
    this.s.db.prepare('UPDATE monitors SET last_check_at = ? WHERE id = ?').run(Date.now(), m.id);
    try {
      const outcome = await runCheck(this.s, m);
      const at = Date.now();
      const st = this.s.settings.get().monitoring;
      const failing = outcome.status === 'down' || outcome.status === 'degraded';
      const fails = failing ? m.consecutive_failures + 1 : 0;
      const succ = outcome.status === 'up' ? m.consecutive_successes + 1 : 0;
      const changed = outcome.status !== m.status;
      this.s.db
        .prepare(
          `UPDATE monitors SET status = ?, last_check_at = ?, last_message = ?, last_latency_ms = ?, consecutive_failures = ?, consecutive_successes = ?, last_change_at = CASE WHEN ? THEN ? ELSE last_change_at END WHERE id = ?`,
        )
        .run(outcome.status, at, truncate(outcome.message, 500), outcome.latencyMs, fails, succ, changed ? 1 : 0, at, m.id);
      this.s.db
        .prepare('INSERT INTO check_results (monitor_id, at, status, latency_ms, message, details) VALUES (?, ?, ?, ?, ?, ?)')
        .run(m.id, at, outcome.status, outcome.latencyMs, truncate(outcome.message, 500), outcome.details === undefined ? null : truncate(JSON.stringify(outcome.details), 20_000));

      // incidente
      const active = this.s.incidents.activeForMonitor(m.id);
      if (failing && outcome.incidentWorthy && !active) {
        const threshold = outcome.status === 'degraded' ? st.failuresBeforeIncident + 1 : st.failuresBeforeIncident;
        if (fails >= threshold) {
          this.s.incidents.open({
            monitorId: m.id,
            title: `${m.name}: ${outcome.status === 'down' ? 'nu funcționează' : 'funcționează cu probleme'}`,
            severity: outcome.incidentSeverity ?? (outcome.status === 'down' ? 'critical' : 'medium'),
            details: outcome.message,
            data: outcome.details,
          });
        }
      } else if (active && failing) {
        if (changed) this.s.incidents.addEvent(active.id, 'check', `${outcome.status === 'down' ? 'Încă căzut' : 'Degradat'}: ${outcome.message}`);
      } else if (active && outcome.status === 'up' && succ >= st.successesBeforeResolve) {
        this.s.incidents.resolve(active.id, `Monitorul raportează din nou funcționare normală (${outcome.message}).`);
      }

      const dto = this.toDTO(this.s.db.prepare('SELECT * FROM monitors WHERE id = ?').get(m.id) as MonitorRow);
      this.s.bus.emit({ type: 'monitor', monitor: dto });
      return { at, status: outcome.status, latencyMs: outcome.latencyMs, message: outcome.message };
    } finally {
      this.running.delete(m.id);
    }
  }

  // ------------------------------------------------------------ citire

  getMonitor(id: string): MonitorDTO | null {
    const m = this.s.db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as MonitorRow | undefined;
    return m ? this.toDTO(m) : null;
  }

  listMonitors(): MonitorDTO[] {
    const order: MonitorKind[] = ['http', 'tls', 'domain', 'dns', 'wp_health', 'whmcs_health', 'da_usage', 'security_scan', 'wp_vulns', 'blacklist', 'pagespeed', 'cloudflare_security', 'business', 'tickets_poll', 'reseller_accounts'];
    return (this.s.db.prepare('SELECT * FROM monitors').all() as MonitorRow[])
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name))
      .map((m) => this.toDTO(m));
  }

  setEnabled(id: string, enabled: boolean): MonitorDTO | null {
    this.s.db.prepare("UPDATE monitors SET enabled = ?, status = CASE WHEN ? THEN 'unknown' ELSE 'paused' END WHERE id = ?").run(enabled ? 1 : 0, enabled ? 1 : 0, id);
    return this.getMonitor(id);
  }

  uptime(monitorId: string, sinceMs: number): number | null {
    const r = this.s.db
      .prepare(
        "SELECT SUM(CASE WHEN status IN ('up','degraded') THEN 1 ELSE 0 END) ok, SUM(CASE WHEN status IN ('up','degraded','down') THEN 1 ELSE 0 END) total FROM check_results WHERE monitor_id = ? AND at >= ?",
      )
      .get(monitorId, sinceMs) as { ok: number | null; total: number | null };
    if (!r.total) return null;
    return Math.round(((r.ok ?? 0) / r.total) * 100_000) / 1000;
  }

  history(monitorId: string, sinceMs: number, limit = 500): CheckResultDTO[] {
    return (
      this.s.db
        .prepare('SELECT at, status, latency_ms, message FROM check_results WHERE monitor_id = ? AND at >= ? ORDER BY at DESC LIMIT ?')
        .all(monitorId, sinceMs, limit) as Array<{ at: number; status: MonitorStatus; latency_ms: number | null; message: string | null }>
    )
      .reverse()
      .map((r) => ({ at: r.at, status: r.status, latencyMs: r.latency_ms, message: r.message }));
  }

  lastDetails(monitorId: string): unknown {
    const r = this.s.db.prepare('SELECT details FROM check_results WHERE monitor_id = ? ORDER BY at DESC LIMIT 1').get(monitorId) as { details: string | null } | undefined;
    if (!r?.details) return null;
    try {
      return JSON.parse(r.details);
    } catch {
      return null;
    }
  }

  uptimeReport(hours: number) {
    const since = Date.now() - hours * HOUR;
    return this.listMonitors()
      .filter((m) => m.kind === 'http')
      .map((m) => {
        const avg = this.s.db
          .prepare("SELECT AVG(latency_ms) a, MAX(latency_ms) mx FROM check_results WHERE monitor_id = ? AND at >= ? AND status IN ('up','degraded')")
          .get(m.id, since) as { a: number | null; mx: number | null };
        const downChecks = (this.s.db.prepare("SELECT COUNT(*) n FROM check_results WHERE monitor_id = ? AND at >= ? AND status = 'down'").get(m.id, since) as { n: number }).n;
        return {
          monitor: m.name,
          url: m.target,
          uptimePct: this.uptime(m.id, since),
          avgResponseMs: avg.a != null ? Math.round(avg.a) : null,
          maxResponseMs: avg.mx,
          failedChecks: downChecks,
          periodHours: hours,
        };
      });
  }

  toDTO(m: MonitorRow): MonitorDTO {
    const now = Date.now();
    const series =
      m.kind === 'http'
        ? (
            this.s.db.prepare('SELECT at, latency_ms, status FROM check_results WHERE monitor_id = ? ORDER BY at DESC LIMIT 90').all(m.id) as Array<{
              at: number;
              latency_ms: number | null;
              status: MonitorStatus;
            }>
          )
            .reverse()
            .map((r) => ({ at: r.at, ms: r.latency_ms, status: r.status }))
        : [];
    return {
      id: m.id,
      kind: m.kind,
      name: m.name,
      target: m.target,
      intervalSec: m.interval_sec,
      enabled: m.enabled === 1,
      status: m.enabled === 1 ? m.status : 'paused',
      lastCheckAt: m.last_check_at,
      lastChangeAt: m.last_change_at,
      lastMessage: m.last_message,
      lastLatencyMs: m.last_latency_ms,
      uptime24h: m.kind === 'http' ? this.uptime(m.id, now - DAY) : null,
      uptime7d: m.kind === 'http' ? this.uptime(m.id, now - 7 * DAY) : null,
      uptime30d: m.kind === 'http' ? this.uptime(m.id, now - 30 * DAY) : null,
      latencySeries: series,
    };
  }

  cleanup(): void {
    this.s.db.prepare('DELETE FROM check_results WHERE at < ?').run(Date.now() - 120 * DAY);
  }
}
