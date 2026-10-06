import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { IntegrationError } from './http';
import { decodeHtmlEntities, toNumber } from '../util/text';
import type { DirectAdminApi } from './types';

// Client DirectAdmin.
// - API modern (/api/...) pentru fișiere — necesită în Login Key permisiunile „filemanager” și „filemanager-actions”.
// - API clasic (CMD_API_*) cu json=yes pentru domenii, consum, baze de date, SSL, backup.
// - Pentru reseller: „login as” prin utilizatorul `reseller|client` cu cheia reseller-ului.

const SERVICE = 'DirectAdmin';

export interface DirectAdminOptions {
  url: string;
  username: string;
  loginKey: string;
  timeoutMs?: number;
  /** Doar pentru reseller: acționează în numele acestui client. */
  actAs?: string;
}

export interface DaFileEntry {
  name: string;
  type: string;
  sizeBytes: number;
  mode: string | null;
  modified: string | null;
}

type Raw = Record<string, unknown>;

export class DirectAdminClient {
  private readonly base: string;
  private readonly auth: string;
  readonly label: string;

  constructor(private readonly opts: DirectAdminOptions) {
    if (!opts.url) throw new IntegrationError(SERVICE, 'adresa panoului lipsește (ex. https://server.furnizor.ro:2222)');
    this.base = opts.url.replace(/\/+$/, '');
    const user = opts.actAs ? `${opts.username}|${opts.actAs}` : opts.username;
    this.auth = `Basic ${Buffer.from(`${user}:${opts.loginKey}`).toString('base64')}`;
    this.label = opts.actAs ? `${SERVICE} (client ${opts.actAs})` : SERVICE;
  }

  /** Client nou care acționează ca un utilizator al reseller-ului. */
  asUser(user: string): DirectAdminApi {
    if (!/^[a-z0-9_-]{1,32}$/i.test(user)) throw new IntegrationError(SERVICE, `nume de utilizator invalid: ${user}`);
    return new DirectAdminClient({ ...this.opts, actAs: user });
  }

  private async doFetch(url: URL, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000) });
    } catch (err) {
      const e = err as Error;
      const reason = e.name === 'TimeoutError' ? 'nu a răspuns în timp util' : `conexiune eșuată (${e.message})`;
      throw new IntegrationError(this.label, `${url.pathname}: ${reason}`, null, true);
    }
  }

  private checkAuth(res: Response, what: string) {
    if (res.status === 401 || res.status === 403 || res.headers.get('x-directadmin') === 'Unauthorized') {
      throw new IntegrationError(
        this.label,
        `${what}: acces refuzat (HTTP ${res.status}). Verifică Login Key-ul, permisiunile lui (comanda „${what}”) și dacă IP-ul serverului agentului e permis.`,
        res.status,
      );
    }
  }

  // ------------------------------------------------------------------ API modern

  async request<T = unknown>(path: string, init: { method?: string; query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
    const res = await this.doFetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: this.auth,
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    this.checkAuth(res, path);
    if (!res.ok) throw new IntegrationError(this.label, `${path}: HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async session(): Promise<Raw> {
    return this.request<Raw>('/api/session');
  }

  async listFiles(path: string, opts: { query?: string; limit?: number } = {}): Promise<{ path: string; total: number; files: DaFileEntry[] }> {
    const r = await this.request<{ canonicalPath?: string; filesTotal?: number; files?: Raw[] }>('/api/filemanager/list', {
      query: { path, ...(opts.query ? { query: opts.query } : {}), limit: String(opts.limit ?? 500) },
    });
    return {
      path: String(r.canonicalPath ?? path),
      total: Number(r.filesTotal ?? r.files?.length ?? 0),
      files: (r.files ?? []).map((f) => ({
        name: String(f.name ?? ''),
        type: String(f.type ?? ''),
        sizeBytes: Number(f.sizeBytes ?? 0),
        mode: f.mode == null ? null : String(f.mode),
        modified: f.modifyTime == null ? null : String(f.modifyTime),
      })),
    };
  }

  async downloadFile(path: string): Promise<Buffer> {
    const url = new URL(this.base + '/api/filemanager/download');
    url.searchParams.set('path', path);
    const res = await this.doFetch(url, { headers: { Authorization: this.auth } });
    this.checkAuth(res, 'filemanager');
    if (res.status === 404) throw new IntegrationError(this.label, `fișierul nu există: ${path}`, 404);
    if (!res.ok) throw new IntegrationError(this.label, `descărcare ${path}: HTTP ${res.status}`, res.status);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Descarcă un fișier mare direct pe disc (ex. arhiva de backup), cu sumă SHA-256.
   * Se oprește dacă nu mai vin date timp de `idleMs` (nu are limită totală de timp).
   */
  async downloadToFile(path: string, dest: string, opts: { idleMs?: number; onProgress?: (bytes: number) => void; signal?: AbortSignal } = {}): Promise<{ bytes: number; sha256: string }> {
    const url = new URL(this.base + '/api/filemanager/download');
    url.searchParams.set('path', path);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort);
    let idle: NodeJS.Timeout | null = null;
    const arm = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), opts.idleMs ?? 120_000);
    };
    arm();
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      let res: Response;
      try {
        res = await fetch(url, { headers: { Authorization: this.auth }, signal: controller.signal });
      } catch (err) {
        throw new IntegrationError(this.label, `descărcare ${path}: conexiune eșuată (${(err as Error).message})`, null, true);
      }
      this.checkAuth(res, 'filemanager');
      if (res.status === 404) throw new IntegrationError(this.label, `fișierul nu există: ${path}`, 404);
      if (!res.ok || !res.body) throw new IntegrationError(this.label, `descărcare ${path}: HTTP ${res.status}`, res.status);
      const out = createWriteStream(dest);
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          arm();
          const buf = Buffer.from(chunk);
          hash.update(buf);
          bytes += buf.length;
          if (!out.write(buf)) await new Promise<void>((r) => out.once('drain', () => r()));
          opts.onProgress?.(bytes);
        }
      } finally {
        await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      }
      return { bytes, sha256: hash.digest('hex') };
    } catch (err) {
      await unlink(dest).catch(() => undefined);
      if (controller.signal.aborted && !(err instanceof IntegrationError)) {
        throw new IntegrationError(this.label, `descărcarea ${path} s-a oprit (fără date ${Math.round((opts.idleMs ?? 120_000) / 1000)} s sau anulată)`, null, true);
      }
      throw err;
    } finally {
      if (idle) clearTimeout(idle);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  async readText(path: string, maxBytes = 256 * 1024): Promise<{ path: string; sizeBytes: number; truncated: boolean; binary: boolean; content: string }> {
    const bytes = await this.downloadFile(path);
    const truncated = bytes.length > maxBytes;
    const slice = truncated ? bytes.subarray(bytes.length - maxBytes) : bytes; // pentru loguri ne interesează finalul
    const binary = slice.subarray(0, 8192).includes(0);
    return { path, sizeBytes: bytes.length, truncated, binary, content: binary ? '' : slice.toString('utf8') };
  }

  /** Scrie un fișier și verifică prin recitire. */
  async uploadFile(path: string, content: string | Buffer, overwrite = true): Promise<{ verified: boolean; sizeBytes: number }> {
    const lastSlash = path.lastIndexOf('/');
    const dir = lastSlash > 0 ? path.slice(0, lastSlash) : '/';
    const name = path.slice(lastSlash + 1);
    if (!name) throw new IntegrationError(this.label, `cale fără nume de fișier: ${path}`);
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(data)]), name);
    const url = new URL(this.base + '/api/filemanager-actions/upload');
    url.searchParams.set('dir', dir);
    url.searchParams.set('name', name);
    url.searchParams.set('overwrite', overwrite ? 'true' : 'false');
    const res = await this.doFetch(url, { method: 'POST', headers: { Authorization: this.auth, Accept: 'application/json' }, body: form });
    const text = await res.text();
    this.checkAuth(res, 'filemanager-actions');
    if (!res.ok) throw new IntegrationError(this.label, `încărcare ${path}: HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
    const readBack = await this.downloadFile(path);
    return { verified: Buffer.compare(readBack, data) === 0, sizeBytes: readBack.length };
  }

  async mkdir(path: string): Promise<void> {
    await this.request('/api/filemanager-actions/mkdir', { method: 'POST', body: { path } });
  }

  /** Mută în coșul contului (recuperabil din panou), nu șterge definitiv. */
  async trash(paths: string[]): Promise<void> {
    await this.request('/api/filemanager-actions/remove', { method: 'POST', body: { paths, trash: true } });
  }

  /** Ștergere definitivă (folosită doar pentru backup-urile create de DAX, după ce au fost copiate în altă parte). */
  async removePermanently(paths: string[]): Promise<void> {
    await this.request('/api/filemanager-actions/remove', { method: 'POST', body: { paths, trash: false } });
  }

  async exists(path: string): Promise<boolean> {
    const lastSlash = path.lastIndexOf('/');
    const dir = lastSlash > 0 ? path.slice(0, lastSlash) : '/';
    const name = path.slice(lastSlash + 1);
    try {
      const listing = await this.listFiles(dir, { limit: 5000 });
      return listing.files.some((f) => f.name === name);
    } catch (err) {
      if (err instanceof IntegrationError && err.status === 404) return false;
      throw err;
    }
  }

  async searchFiles(path: string, query: string, limit = 100): Promise<unknown> {
    return this.request('/api/filemanager/search-files', { query: { path, query, 'ignore-case': 'true', limit: String(limit) } });
  }

  async searchText(path: string, query: string, limit = 50): Promise<unknown> {
    return this.request('/api/filemanager/search-text', { query: { path, query, limit: String(limit) } });
  }

  // ------------------------------------------------------------------ API clasic

  async legacy(command: string, params: Record<string, string | number | undefined> = {}, method: 'GET' | 'POST' = 'GET'): Promise<unknown> {
    if (!/^CMD_[A-Z_]+$/.test(command)) throw new IntegrationError(this.label, `comandă invalidă: ${command}`);
    const url = new URL(`${this.base}/${command}`);
    url.searchParams.set('json', 'yes');
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) form.set(k, String(v));
    if (method === 'GET') for (const [k, v] of form) url.searchParams.set(k, v);
    const res = await this.doFetch(url, {
      method,
      headers: {
        Authorization: this.auth,
        Accept: 'application/json',
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: method === 'POST' ? form.toString() : undefined,
    });
    const text = await res.text();
    this.checkAuth(res, command);
    if (!res.ok) throw new IntegrationError(this.label, `${command}: HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
    let parsed: unknown;
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = Object.fromEntries(new URLSearchParams(trimmed));
      }
    } else {
      parsed = Object.fromEntries(new URLSearchParams(trimmed));
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rec = parsed as Raw;
      if (rec.error && rec.error !== '0' && rec.error !== 0) {
        throw new IntegrationError(this.label, `${command}: ${decodeHtmlEntities(String(rec.text ?? 'eroare'))}${rec.details ? ` — ${decodeHtmlEntities(String(rec.details))}` : ''}`, res.status);
      }
    }
    return parsed;
  }

  private static asList(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String);
    if (value && typeof value === 'object') {
      const rec = value as Raw;
      if (Array.isArray(rec.list)) return rec.list.map(String);
      if (rec['list[]']) return ([] as unknown[]).concat(rec['list[]']).map(String);
      return Object.keys(rec).filter((k) => !['error', 'text', 'details'].includes(k));
    }
    return [];
  }

  async loginTest(): Promise<boolean> {
    await this.legacy('CMD_API_LOGIN_TEST');
    return true;
  }

  async listDomains(): Promise<string[]> {
    return DirectAdminClient.asList(await this.legacy('CMD_API_SHOW_DOMAINS'));
  }

  async userConfig(user?: string): Promise<Raw> {
    return (await this.legacy('CMD_API_SHOW_USER_CONFIG', user ? { user } : {})) as Raw;
  }

  async usage(user?: string) {
    const [usageRaw, configRaw] = await Promise.all([
      this.legacy('CMD_API_SHOW_USER_USAGE', user ? { user } : {}) as Promise<Raw>,
      this.userConfig(user).catch(() => ({}) as Raw),
    ]);
    const val = (r: Raw, k: string) => {
      const v = r[k];
      if (v && typeof v === 'object' && 'usage' in (v as Raw)) return toNumber((v as Raw).usage);
      return toNumber(v);
    };
    const limit = (k: string) => {
      const v = configRaw[k];
      const s = String(v ?? '');
      if (!s || /unlimited/i.test(s)) return null;
      return toNumber(s);
    };
    const pct = (used: number | null, max: number | null) => (used != null && max ? Math.round((used / max) * 1000) / 10 : null);
    const diskMb = val(usageRaw, 'quota');
    const diskLimitMb = limit('quota');
    const bwMb = val(usageRaw, 'bandwidth');
    const bwLimitMb = limit('bandwidth');
    const inodes = val(usageRaw, 'inode');
    const inodeLimit = limit('inode');
    return {
      diskMb,
      diskLimitMb,
      diskPct: pct(diskMb, diskLimitMb),
      bandwidthMb: bwMb,
      bandwidthLimitMb: bwLimitMb,
      bandwidthPct: pct(bwMb, bwLimitMb),
      inodes,
      inodeLimit,
      inodePct: pct(inodes, inodeLimit),
      emailAccounts: val(usageRaw, 'nemails'),
      databases: val(usageRaw, 'mysql'),
      domains: val(usageRaw, 'vdomains'),
      ip: String(configRaw.ip ?? '') || null,
      package: String(configRaw.package ?? '') || null,
      suspended: String(configRaw.suspended ?? 'no') === 'yes',
      php: String(configRaw.php ?? '') || null,
      raw: { usage: usageRaw, config: Object.fromEntries(Object.entries(configRaw).filter(([k]) => !/pass/i.test(k))) },
    };
  }

  async listDatabases(): Promise<string[]> {
    return DirectAdminClient.asList(await this.legacy('CMD_API_DATABASES'));
  }

  async listEmailAccounts(domain: string): Promise<string[]> {
    return DirectAdminClient.asList(await this.legacy('CMD_API_POP', { action: 'list', domain }));
  }

  /** Creează o căsuță de e-mail (ex. pentru testele de livrare și rapoartele DMARC). */
  async createEmailAccount(domain: string, user: string, password: string, quotaMb = 200): Promise<void> {
    if (!/^[a-z0-9._-]{1,64}$/i.test(user)) throw new IntegrationError(this.label, `nume de căsuță invalid: ${user}`);
    await this.legacy('CMD_API_POP', { action: 'create', domain, user, passwd: password, passwd2: password, quota: quotaMb, limit: 0 }, 'POST');
  }

  async dnsRecords(domain: string): Promise<unknown> {
    const r = (await this.legacy('CMD_API_DNS_CONTROL', { domain })) as Raw;
    return Array.isArray(r.records) ? r.records : r;
  }

  /** Cere (reînnoiește) certificatul Let's Encrypt pentru domeniu (și www). */
  async requestLetsEncrypt(domain: string, opts: { includeWww?: boolean; email?: string } = {}): Promise<unknown> {
    return this.legacy(
      'CMD_API_SSL',
      {
        domain,
        action: 'save',
        type: 'create',
        request: 'letsencrypt',
        name: domain,
        keysize: 'secp384r1',
        encryption: 'sha256',
        email: opts.email,
        le_select0: domain,
        le_select1: opts.includeWww === false ? undefined : `www.${domain}`,
      },
      'POST',
    );
  }

  /** Pornește un backup al contului (DirectAdmin îl creează în fundal în /backups). */
  async createBackup(domain?: string): Promise<unknown> {
    const sections = ['domain', 'subdomain', 'email', 'forwarder', 'autoresponder', 'vacation', 'list', 'emailsettings', 'ftp', 'ftpsettings', 'database'];
    const params: Record<string, string | undefined> = { action: 'backup', domain };
    sections.forEach((s, i) => (params[`select${i}`] = s));
    return this.legacy('CMD_API_SITE_BACKUP', params, 'POST');
  }

  async listBackups(): Promise<DaFileEntry[]> {
    try {
      const l = await this.listFiles('/backups', { limit: 200 });
      return l.files.filter((f) => /\.tar(\.gz|\.zst)?$/.test(f.name)).sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
    } catch (err) {
      if (err instanceof IntegrationError && err.status === 404) return [];
      throw err;
    }
  }

  async restoreBackup(file: string): Promise<unknown> {
    if (!/^[\w.-]+\.tar(\.gz|\.zst)?$/.test(file)) throw new IntegrationError(this.label, `nume de arhivă invalid: ${file}`);
    const sections = ['domain', 'subdomain', 'email', 'forwarder', 'autoresponder', 'vacation', 'list', 'emailsettings', 'ftp', 'ftpsettings', 'database'];
    const params: Record<string, string> = { action: 'restore', file, where: 'local' };
    sections.forEach((s, i) => (params[`select${i}`] = s));
    return this.legacy('CMD_API_SITE_BACKUP', params, 'POST');
  }

  // ------------------------------------------------------------------ reseller

  async listUsers(): Promise<string[]> {
    return DirectAdminClient.asList(await this.legacy('CMD_API_SHOW_USERS'));
  }

  async userDomains(user: string): Promise<string[]> {
    const r = await this.legacy('CMD_API_SHOW_USER_DOMAINS', { user });
    return DirectAdminClient.asList(r).map((d) => d.replace(/_/g, '.'));
  }

  async setSuspended(user: string, suspended: boolean): Promise<unknown> {
    return this.legacy('CMD_API_SELECT_USERS', { location: 'CMD_SELECT_USERS', suspend: suspended ? 'Suspend' : 'Unsuspend', select0: user }, 'POST');
  }
}
