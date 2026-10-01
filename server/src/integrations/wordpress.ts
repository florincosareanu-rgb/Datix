import { signRequest } from '../crypto/hmac';
import { fetchWithRetry, IntegrationError } from './http';

// Client pentru pluginul „DAX Connector” instalat pe WordPress.
// Toate apelurile sunt POST cu corp JSON, semnate HMAC (vezi crypto/hmac.ts și pluginul PHP).

const SERVICE = 'WordPress';
const NAMESPACE = '/dax/v1';

export interface WpHealth {
  wp_version: string;
  php_version: string;
  db_version?: string;
  site_url: string;
  home_url: string;
  multisite: boolean;
  theme: { name: string; version: string; stylesheet: string; update?: string | null };
  plugins_total: number;
  plugins_active: number;
  updates: { core: string | null; plugins: number; themes: number; translations: number };
  flags: Record<string, boolean | string | null>;
  debug_log_bytes: number | null;
  cron: { disabled: boolean; overdue: number };
  memory_limit: string;
  cache_plugins: string[];
  maintenance: boolean;
  connector_version: string;
  [k: string]: unknown;
}

export interface WpPlugin {
  file: string;
  slug: string;
  name: string;
  version: string;
  active: boolean;
  update: string | null;
  auto_update: boolean;
  author?: string;
}

export class WordPressConnector {
  private useQueryRoute = false;

  constructor(
    private readonly siteUrl: string,
    private readonly secret: string,
  ) {}

  private urlFor(route: string): string {
    const base = this.siteUrl.replace(/\/+$/, '');
    return this.useQueryRoute ? `${base}/?rest_route=${encodeURIComponent(route)}` : `${base}/wp-json${route}`;
  }

  async call<T = unknown>(endpoint: string, body: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const route = `${NAMESPACE}${endpoint}`;
    const payload = JSON.stringify(body);
    const attempt = async () => {
      const headers = signRequest(this.secret, 'POST', route, payload);
      return fetchWithRetry(this.urlFor(route), {
        service: SERVICE,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'DAX/1.0', ...headers },
        body: payload,
        timeoutMs,
        retries: 0,
      });
    };
    let res = await attempt();
    // site cu permalinkuri simple sau /wp-json blocat → încercăm ?rest_route=
    if (res.status === 404 && !this.useQueryRoute) {
      const text = await res.text();
      if (!/\bdax_|rest_no_route.*dax/i.test(text)) {
        this.useQueryRoute = true;
        res = await attempt();
      }
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new IntegrationError(
        SERVICE,
        `răspuns invalid (HTTP ${res.status}). ${res.status >= 500 ? 'Site-ul WordPress pare să aibă o eroare.' : 'Verifică dacă pluginul DAX Connector e activ.'} ${text.slice(0, 120)}`,
        res.status,
      );
    }
    if (!res.ok) {
      const d = data as { code?: string; message?: string };
      if (d.code === 'rest_no_route') throw new IntegrationError(SERVICE, 'pluginul DAX Connector nu e instalat sau nu e activ pe site.', res.status);
      if (res.status === 401 || res.status === 403) throw new IntegrationError(SERVICE, `${d.message ?? 'acces refuzat'} — verifică secretul DAX_SECRET din wp-config.php.`, res.status);
      throw new IntegrationError(SERVICE, d.message ?? `HTTP ${res.status}`, res.status);
    }
    const env = data as { ok?: boolean; data?: T; error?: string };
    if (env.ok === false) throw new IntegrationError(SERVICE, env.error ?? 'eroare necunoscută');
    return (env.data ?? (data as T)) as T;
  }

  health() {
    return this.call<WpHealth>('/health');
  }

  plugins() {
    return this.call<WpPlugin[]>('/plugins');
  }

  togglePlugin(plugin: string, active: boolean) {
    return this.call<{ plugin: string; active: boolean }>('/plugins/toggle', { plugin, active });
  }

  runUpdates(type: 'plugin' | 'theme' | 'core' | 'translations', items: string[] = []) {
    return this.call<{ results: Array<{ item: string; ok: boolean; message: string; from?: string; to?: string }> }>('/updates/run', { type, items }, 180_000);
  }

  securityAudit(deep = false) {
    return this.call<Record<string, unknown>>('/security/audit', { deep }, 120_000);
  }

  securityEvents(sinceUnix?: number, limit = 200) {
    return this.call<Array<{ id: number; at: number; type: string; user: string | null; ip: string | null; details: string | null }>>('/security/events', {
      since: sinceUnix,
      limit,
    });
  }

  admins() {
    return this.call<Array<{ id: number; login: string; email: string; registered: string; last_login: number | null }>>('/users/admins');
  }

  setMaintenance(enabled: boolean, message?: string) {
    return this.call<{ enabled: boolean }>('/maintenance', { enabled, message });
  }

  purgeCache() {
    return this.call<{ purged: string[] }>('/cache/purge');
  }

  debugLog(lines = 200) {
    return this.call<{ path: string | null; bytes: number; content: string }>('/debug-log', { lines });
  }

  hardening(opts: { disable_xmlrpc?: boolean; block_user_enum?: boolean; disable_file_edit?: boolean }) {
    return this.call<Record<string, boolean>>('/hardening', opts);
  }
}
