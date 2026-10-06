import { createSign } from 'node:crypto';
import { fetchWithRetry, IntegrationError } from './http';

// Google Search Console cu un cont de serviciu (service account): fără autorizare din browser.
// Pași: Google Cloud → creezi un cont de serviciu + cheie JSON → activezi „Google Search Console API”
// → în Search Console adaugi adresa contului de serviciu ca utilizator (permisiune „Restricționat” e suficientă).

const SERVICE = 'Google Search Console';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscSitemap {
  path: string;
  lastSubmitted: string | null;
  lastDownloaded: string | null;
  isPending: boolean;
  errors: number;
  warnings: number;
  submitted: number | null;
  indexed: number | null;
}

export interface GscInspection {
  url: string;
  verdict: string | null;
  coverageState: string | null;
  indexingState: string | null;
  lastCrawlTime: string | null;
  robotsTxtState: string | null;
  googleCanonical: string | null;
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function parseServiceAccount(json: string): ServiceAccount {
  let data: Partial<ServiceAccount> & { type?: string };
  try {
    data = JSON.parse(json);
  } catch {
    throw new IntegrationError(SERVICE, 'cheia contului de serviciu nu e un JSON valid (lipește tot conținutul fișierului .json descărcat din Google Cloud).');
  }
  if (!data.client_email || !data.private_key || !/BEGIN (RSA )?PRIVATE KEY/.test(data.private_key)) {
    throw new IntegrationError(SERVICE, 'cheia JSON nu conține client_email și private_key (alege „Create key → JSON” la contul de serviciu).');
  }
  return { client_email: data.client_email, private_key: data.private_key, token_uri: data.token_uri };
}

/** Aserțiunea JWT semnată RS256 pentru schimbul de token (exportată pentru teste). */
export function signedAssertion(sa: ServiceAccount, now = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri ?? TOKEN_URL, iat: now, exp: now + 3600 }));
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key);
  return `${header}.${claims}.${b64url(signature)}`;
}

export class SearchConsoleClient {
  private token: { value: string; until: number } | null = null;
  private readonly sa: ServiceAccount;

  constructor(serviceAccountJson: string) {
    this.sa = parseServiceAccount(serviceAccountJson);
  }

  get serviceEmail(): string {
    return this.sa.client_email;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now() + 60_000) return this.token.value;
    const res = await fetchWithRetry(this.sa.token_uri ?? TOKEN_URL, {
      service: SERVICE,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedAssertion(this.sa) }).toString(),
      timeoutMs: 20_000,
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!res.ok || !data.access_token) throw new IntegrationError(SERVICE, `autentificarea contului de serviciu a eșuat: ${data.error_description ?? data.error ?? `HTTP ${res.status}`}`, res.status);
    this.token = { value: data.access_token, until: Date.now() + (data.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async api<T>(url: string, body?: unknown): Promise<T> {
    const token = await this.accessToken();
    const res = await fetchWithRetry(url, {
      service: SERVICE,
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: 45_000,
      retries: 1,
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; status?: string } };
    if (!res.ok) {
      const msg = data.error?.message ?? `HTTP ${res.status}`;
      const hint =
        res.status === 403
          ? ` — adaugă ${this.sa.client_email} ca utilizator al proprietății în Search Console și verifică dacă „Google Search Console API” e activat în proiectul Google Cloud.`
          : '';
      throw new IntegrationError(SERVICE, `${msg}${hint}`, res.status);
    }
    return data;
  }

  async sites(): Promise<Array<{ siteUrl: string; permissionLevel: string }>> {
    const d = await this.api<{ siteEntry?: Array<{ siteUrl: string; permissionLevel: string }> }>('https://www.googleapis.com/webmasters/v3/sites');
    return d.siteEntry ?? [];
  }

  async query(site: string, body: { startDate: string; endDate: string; dimensions: string[]; rowLimit?: number; dimensionFilterGroups?: unknown[] }): Promise<GscRow[]> {
    const d = await this.api<{ rows?: GscRow[] }>(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, { dataState: 'final', ...body });
    return d.rows ?? [];
  }

  async sitemaps(site: string): Promise<GscSitemap[]> {
    const d = await this.api<{ sitemap?: Array<Record<string, unknown>> }>(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/sitemaps`);
    return (d.sitemap ?? []).map((s) => {
      const contents = (s.contents as Array<{ submitted?: string; indexed?: string }> | undefined) ?? [];
      const sum = (k: 'submitted' | 'indexed') => (contents.length ? contents.reduce((a, c) => a + Number(c[k] ?? 0), 0) : null);
      return {
        path: String(s.path ?? ''),
        lastSubmitted: (s.lastSubmitted as string) ?? null,
        lastDownloaded: (s.lastDownloaded as string) ?? null,
        isPending: !!s.isPending,
        errors: Number(s.errors ?? 0),
        warnings: Number(s.warnings ?? 0),
        submitted: sum('submitted'),
        indexed: sum('indexed'),
      };
    });
  }

  async inspect(site: string, url: string): Promise<GscInspection> {
    const d = await this.api<{ inspectionResult?: { indexStatusResult?: Record<string, unknown> } }>('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
      inspectionUrl: url,
      siteUrl: site,
      languageCode: 'ro-RO',
    });
    const r = d.inspectionResult?.indexStatusResult ?? {};
    const s = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : null);
    return {
      url,
      verdict: s('verdict'),
      coverageState: s('coverageState'),
      indexingState: s('indexingState'),
      lastCrawlTime: s('lastCrawlTime'),
      robotsTxtState: s('robotsTxtState'),
      googleCanonical: s('googleCanonical'),
    };
  }
}
