import { fetchWithRetry, IntegrationError, readJson } from './http';

const SERVICE = 'Cloudflare';
const API = 'https://api.cloudflare.com/client/v4';

export type SecurityLevel = 'off' | 'essentially_off' | 'low' | 'medium' | 'high' | 'under_attack';

interface CfEnvelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
}

export interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl: number;
  priority?: number;
}

export class CloudflareClient {
  private zoneIdCache: string | null;

  constructor(
    private readonly token: string,
    private readonly zoneName: string,
    zoneId?: string,
  ) {
    this.zoneIdCache = zoneId || null;
  }

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await fetchWithRetry(`${API}${path}`, {
      service: SERVICE,
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      timeoutMs: 20_000,
      retries: 1,
    });
    const data = await readJson<CfEnvelope<T>>(res, SERVICE);
    if (!data.success) {
      const msg = (data.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`;
      if (res.status === 403 || /authentication|permission/i.test(msg)) {
        throw new IntegrationError(SERVICE, `${msg} — tokenul API nu are permisiunea necesară pentru ${path}.`, res.status);
      }
      throw new IntegrationError(SERVICE, msg, res.status);
    }
    return data.result;
  }

  async verifyToken(): Promise<string> {
    const r = await this.call<{ status: string }>('/user/tokens/verify');
    return r.status;
  }

  async zoneId(): Promise<string> {
    if (this.zoneIdCache) return this.zoneIdCache;
    const zones = await this.call<Array<{ id: string; name: string; status: string }>>(`/zones?name=${encodeURIComponent(this.zoneName)}`);
    const z = zones[0];
    if (!z) throw new IntegrationError(SERVICE, `zona ${this.zoneName} nu a fost găsită pentru acest token.`);
    this.zoneIdCache = z.id;
    return z.id;
  }

  async zoneOverview() {
    const id = await this.zoneId();
    const [zone, security, ssl, devMode, alwaysHttps] = await Promise.all([
      this.call<{ name: string; status: string; paused: boolean; plan?: { name: string }; name_servers?: string[] }>(`/zones/${id}`),
      this.getSetting<string>('security_level').catch(() => null),
      this.getSetting<string>('ssl').catch(() => null),
      this.getSetting<string>('development_mode').catch(() => null),
      this.getSetting<string>('always_use_https').catch(() => null),
    ]);
    return {
      zone: zone.name,
      status: zone.status,
      paused: zone.paused,
      plan: zone.plan?.name ?? null,
      nameServers: zone.name_servers ?? [],
      securityLevel: security,
      sslMode: ssl,
      developmentMode: devMode,
      alwaysUseHttps: alwaysHttps,
    };
  }

  async getSetting<T>(name: string): Promise<T> {
    const id = await this.zoneId();
    const r = await this.call<{ value: T }>(`/zones/${id}/settings/${name}`);
    return r.value;
  }

  async setSetting<T>(name: string, value: T): Promise<T> {
    const id = await this.zoneId();
    const r = await this.call<{ value: T }>(`/zones/${id}/settings/${name}`, { method: 'PATCH', body: { value } });
    return r.value;
  }

  setSecurityLevel(level: SecurityLevel) {
    return this.setSetting('security_level', level);
  }

  setDevelopmentMode(on: boolean) {
    return this.setSetting('development_mode', on ? 'on' : 'off');
  }

  async purgeCache(urls?: string[]): Promise<void> {
    const id = await this.zoneId();
    const body = urls && urls.length ? { files: urls.slice(0, 30) } : { purge_everything: true };
    await this.call(`/zones/${id}/purge_cache`, { method: 'POST', body });
  }

  async dnsRecords(): Promise<CfDnsRecord[]> {
    const id = await this.zoneId();
    return this.call<CfDnsRecord[]>(`/zones/${id}/dns_records?per_page=200`);
  }

  async createDnsRecord(rec: { type: string; name: string; content: string; ttl?: number; proxied?: boolean; priority?: number }): Promise<CfDnsRecord> {
    const id = await this.zoneId();
    return this.call<CfDnsRecord>(`/zones/${id}/dns_records`, { method: 'POST', body: { ttl: 1, ...rec } });
  }

  async updateDnsRecord(recordId: string, rec: { type: string; name: string; content: string; ttl?: number; proxied?: boolean; priority?: number }): Promise<CfDnsRecord> {
    const id = await this.zoneId();
    return this.call<CfDnsRecord>(`/zones/${id}/dns_records/${encodeURIComponent(recordId)}`, { method: 'PUT', body: { ttl: 1, ...rec } });
  }

  async deleteDnsRecord(recordId: string): Promise<void> {
    const id = await this.zoneId();
    await this.call(`/zones/${id}/dns_records/${encodeURIComponent(recordId)}`, { method: 'DELETE' });
  }

  /** Evenimentele de securitate (WAF, rate limiting, bot) din ultimele ore, prin GraphQL Analytics. */
  async securityEvents(hours = 24, limit = 50) {
    const id = await this.zoneId();
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const query = `query ($zoneTag: string, $since: Time, $limit: Int) {
      viewer {
        zones(filter: { zoneTag: $zoneTag }) {
          events: firewallEventsAdaptive(filter: { datetime_geq: $since }, limit: $limit, orderBy: [datetime_DESC]) {
            action clientIP clientCountryName clientRequestPath clientRequestHTTPMethodName datetime source userAgent ruleId
          }
          byAction: firewallEventsAdaptiveGroups(filter: { datetime_geq: $since }, limit: 20, orderBy: [count_DESC]) {
            count
            dimensions { action source }
          }
          byCountry: firewallEventsAdaptiveGroups(filter: { datetime_geq: $since }, limit: 10, orderBy: [count_DESC]) {
            count
            dimensions { clientCountryName }
          }
          byIp: firewallEventsAdaptiveGroups(filter: { datetime_geq: $since }, limit: 10, orderBy: [count_DESC]) {
            count
            dimensions { clientIP }
          }
        }
      }
    }`;
    const res = await fetchWithRetry(`${API}/graphql`, {
      service: SERVICE,
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { zoneTag: id, since, limit } }),
      timeoutMs: 25_000,
    });
    const data = await readJson<{
      data?: { viewer?: { zones?: Array<Record<string, unknown>> } };
      errors?: Array<{ message: string }> | null;
    }>(res, SERVICE);
    if (data.errors?.length) throw new IntegrationError(SERVICE, `GraphQL: ${data.errors.map((e) => e.message).join('; ')}`);
    const z = (data.data?.viewer?.zones?.[0] ?? {}) as {
      events?: Array<Record<string, string>>;
      byAction?: Array<{ count: number; dimensions: { action: string; source: string } }>;
      byCountry?: Array<{ count: number; dimensions: { clientCountryName: string } }>;
      byIp?: Array<{ count: number; dimensions: { clientIP: string } }>;
    };
    const total = (z.byAction ?? []).reduce((s, g) => s + g.count, 0);
    return {
      hours,
      total,
      byAction: (z.byAction ?? []).map((g) => ({ action: g.dimensions.action, source: g.dimensions.source, count: g.count })),
      topCountries: (z.byCountry ?? []).map((g) => ({ country: g.dimensions.clientCountryName, count: g.count })),
      topIps: (z.byIp ?? []).map((g) => ({ ip: g.dimensions.clientIP, count: g.count })),
      recent: (z.events ?? []).slice(0, 20).map((e) => ({
        at: e.datetime,
        action: e.action,
        source: e.source,
        ip: e.clientIP,
        country: e.clientCountryName,
        method: e.clientRequestHTTPMethodName,
        path: e.clientRequestPath,
      })),
    };
  }
}
