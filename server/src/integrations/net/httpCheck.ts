import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import net from 'node:net';
import type { LookupFunction } from 'node:net';
import type { TLSSocket, PeerCertificate } from 'node:tls';
import { stripHtml } from '../../util/text';

export const MONITOR_USER_AGENT = 'Mozilla/5.0 (compatible; DatixAI-Monitor/1.0; +https://datix.ro)';

export interface HttpCheckOptions {
  url: string;
  method?: 'GET' | 'HEAD' | 'POST';
  timeoutMs?: number;
  /** Conectare directă la acest IP (ocolește DNS / Cloudflare), păstrând Host și SNI. */
  resolveTo?: string;
  headers?: Record<string, string>;
  body?: string;
  maxBodyBytes?: number;
  followRedirects?: number;
  keyword?: string;
  /** Nu respinge certificatele invalide (dar raportează problema). */
  insecure?: boolean;
  slowThresholdMs?: number;
}

export type ProblemSeverity = 'down' | 'degraded' | 'warning';

export interface HttpProblem {
  code: string;
  message: string;
  severity: ProblemSeverity;
}

export interface TlsInfo {
  authorized: boolean;
  authorizationError: string | null;
  validFrom: string | null;
  validTo: string | null;
  daysLeft: number | null;
  issuer: string | null;
  subject: string | null;
  altNames: string[];
  protocol: string | null;
}

export interface HttpCheckResult {
  ok: boolean;
  verdict: 'up' | 'degraded' | 'down';
  url: string;
  finalUrl: string;
  method: string;
  status: number | null;
  statusText: string | null;
  timings: { dnsMs: number | null; connectMs: number | null; tlsMs: number | null; ttfbMs: number | null; totalMs: number };
  remoteAddress: string | null;
  headers: Record<string, string>;
  redirects: Array<{ status: number; location: string }>;
  bodyBytes: number;
  bodyText: string;
  bodySnippet: string;
  keywordFound: boolean | null;
  problems: HttpProblem[];
  error: { code: string; message: string } | null;
  tls: TlsInfo | null;
}

interface SingleResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
  remoteAddress: string | null;
  timings: HttpCheckResult['timings'];
  tls: TlsInfo | null;
}

class ProbeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly timings: HttpCheckResult['timings'],
  ) {
    super(message);
  }
}

function certName(c: PeerCertificate['issuer'] | undefined): string | null {
  if (!c) return null;
  return [c.O, c.CN].filter(Boolean).join(' / ') || null;
}

export function tlsInfoFromSocket(socket: TLSSocket): TlsInfo {
  const cert = socket.getPeerCertificate(false);
  const validTo = cert?.valid_to ?? null;
  const daysLeft = validTo ? Math.floor((new Date(validTo).getTime() - Date.now()) / 86_400_000) : null;
  const err = socket.authorizationError;
  return {
    authorized: socket.authorized,
    authorizationError: err ? String(err) : null,
    validFrom: cert?.valid_from ?? null,
    validTo,
    daysLeft,
    issuer: certName(cert?.issuer),
    subject: certName(cert?.subject),
    altNames: (cert?.subjectaltname ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^DNS:/, ''))
      .filter(Boolean),
    protocol: socket.getProtocol?.() ?? null,
  };
}

function translateNetError(code: string | undefined, message: string): string {
  switch (code) {
    case 'ENOTFOUND':
      return 'Domeniul nu se rezolvă în DNS (ENOTFOUND).';
    case 'EAI_AGAIN':
      return 'Serverele DNS nu au răspuns (EAI_AGAIN).';
    case 'ECONNREFUSED':
      return 'Serverul refuză conexiunea (ECONNREFUSED) — serviciul web pare oprit.';
    case 'ECONNRESET':
      return 'Conexiunea a fost închisă brusc de server (ECONNRESET).';
    case 'ETIMEDOUT':
    case 'TIMEOUT':
      return 'Serverul nu a răspuns în timp util (timeout).';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'Serverul nu poate fi atins în rețea (host/rețea inaccesibilă).';
    case 'CERT_HAS_EXPIRED':
      return 'Certificatul SSL a expirat.';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'Certificatul SSL nu e emis pentru acest domeniu.';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'Certificat SSL auto-semnat (nu e de încredere).';
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'Lanțul certificatului SSL e incomplet.';
    default:
      return message;
  }
}

function singleRequest(url: URL, opts: HttpCheckOptions, resolveTo: string | undefined): Promise<SingleResponse> {
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxBody = opts.maxBodyBytes ?? 1_000_000;
  const start = performance.now();
  const timings: HttpCheckResult['timings'] = { dnsMs: null, connectMs: null, tlsMs: null, ttfbMs: null, totalMs: 0 };

  const lookup: LookupFunction | undefined = resolveTo
    ? (_hostname, options, callback) => {
        const family = net.isIPv6(resolveTo) ? 6 : 4;
        if (typeof options === 'object' && options && 'all' in options && options.all) {
          (callback as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [{ address: resolveTo, family }]);
        } else {
          callback(null, resolveTo, family);
        }
      }
    : undefined;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (code: string, message: string) => {
      if (settled) return;
      settled = true;
      timings.totalMs = Math.round(performance.now() - start);
      reject(new ProbeError(code, translateNetError(code, message), timings));
    };

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: opts.method ?? 'GET',
        headers: {
          'User-Agent': MONITOR_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.7',
          'Cache-Control': 'no-cache',
          Host: url.host,
          ...(opts.headers ?? {}),
        },
        agent: false,
        lookup,
        servername: isHttps ? url.hostname : undefined,
        rejectUnauthorized: !opts.insecure,
        timeout: timeoutMs,
      },
      (res) => {
        timings.ttfbMs = Math.round(performance.now() - start);
        const socket = res.socket as TLSSocket;
        const tls = isHttps && socket && typeof socket.getPeerCertificate === 'function' ? tlsInfoFromSocket(socket) : null;
        const chunks: Buffer[] = [];
        let size = 0;
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
        let stream: NodeJS.ReadableStream = res;
        if (enc.includes('br')) stream = res.pipe(zlib.createBrotliDecompress());
        else if (enc.includes('gzip')) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= maxBody) chunks.push(chunk);
          else {
            // am citit destul pentru analiză; oprim descărcarea
            res.destroy();
            finish();
          }
        });
        const finish = () => {
          if (settled) return;
          settled = true;
          timings.totalMs = Math.round(performance.now() - start);
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers,
            body: Buffer.concat(chunks),
            remoteAddress: socket?.remoteAddress ?? null,
            timings,
            tls,
          });
        };
        stream.on('end', finish);
        stream.on('error', (e: NodeJS.ErrnoException) => {
          if (chunks.length) finish();
          else fail(e.code ?? 'EDECOMPRESS', e.message);
        });
        res.on('aborted', finish);
      },
    );
    req.on('socket', (socket) => {
      socket.on('lookup', () => {
        timings.dnsMs = Math.round(performance.now() - start);
      });
      socket.on('connect', () => {
        timings.connectMs = Math.round(performance.now() - start);
      });
      socket.on('secureConnect', () => {
        timings.tlsMs = Math.round(performance.now() - start);
      });
    });
    req.on('timeout', () => {
      req.destroy();
      fail('TIMEOUT', `Fără răspuns în ${Math.round(timeoutMs / 1000)} s`);
    });
    req.on('error', (e: NodeJS.ErrnoException) => fail(e.code ?? 'ERROR', e.message));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** Tipare de probleme recunoscute în conținutul paginii. */
const BODY_PATTERNS: Array<{ re: RegExp; code: string; message: string; severity: ProblemSeverity }> = [
  { re: /Error establishing a database connection|Eroare la stabilirea unei conexiuni cu baza de date/i, code: 'wp_db_error', message: 'WordPress nu se poate conecta la baza de date.', severity: 'down' },
  { re: /There has been a critical error on (this|your) website|A apărut o eroare critică pe acest site|Există o eroare critică/i, code: 'wp_critical_error', message: 'WordPress afișează „eroare critică” (de obicei un plugin sau o temă defectă).', severity: 'down' },
  { re: /Briefly unavailable for scheduled maintenance|Indisponibil pentru scurt timp pentru mentenanță/i, code: 'wp_maintenance_stuck', message: 'Site-ul e blocat în modul de mentenanță WordPress (fișierul .maintenance).', severity: 'down' },
  { re: /<b>(Fatal|Parse) error<\/b>:|PHP (Fatal|Parse) error:|Fatal error: Uncaught/i, code: 'php_fatal', message: 'Eroare fatală PHP afișată în pagină.', severity: 'down' },
  { re: /<b>(Warning|Notice|Deprecated)<\/b>:.+ on line <b>\d+/i, code: 'php_warnings_visible', message: 'Avertismente PHP vizibile vizitatorilor (display_errors activ).', severity: 'warning' },
  { re: /This Account has been suspended|Account Suspended|Contul a fost suspendat/i, code: 'hosting_suspended', message: 'Contul de hosting pare suspendat.', severity: 'down' },
  { re: /508 Resource Limit Is Reached|Resource Limit Is Reached/i, code: 'resource_limit', message: 'Contul de hosting a atins limita de resurse (CloudLinux 508).', severity: 'down' },
  { re: /Bandwidth Limit Exceeded/i, code: 'bandwidth_limit', message: 'Limita de trafic a contului a fost depășită.', severity: 'down' },
  { re: /<title>Index of \//i, code: 'directory_listing', message: 'Se afișează lista de fișiere a directorului în loc de site.', severity: 'down' },
  { re: /hacked by|defaced by|h4ck3d|<title>[^<]*hacked/i, code: 'defacement', message: 'Pagina conține semne de spargere (defacement).', severity: 'down' },
  { re: /(viagra|cialis|casino online|slot gacor|togel|replica watches)/i, code: 'spam_injection', message: 'Conținut spam suspect în pagină (posibilă infectare SEO).', severity: 'warning' },
  { re: /WHMCS.{0,200}(Down for Maintenance|Maintenance Mode)|<title>[^<]*Maintenance[^<]*<\/title>/i, code: 'maintenance_mode', message: 'Site-ul afișează pagina de mentenanță.', severity: 'degraded' },
  { re: /Oops! Something went wrong|A critical error occurred/i, code: 'app_error', message: 'Aplicația afișează o pagină de eroare.', severity: 'down' },
];

export function detectProblems(status: number | null, headers: Record<string, string>, bodyText: string): HttpProblem[] {
  const problems: HttpProblem[] = [];
  const server = (headers['server'] ?? '').toLowerCase();
  const isCloudflare = server.includes('cloudflare') || !!headers['cf-ray'];

  if (isCloudflare && headers['cf-mitigated'] === 'challenge') {
    problems.push({
      code: 'cf_challenge',
      message: 'Cloudflare a cerut o verificare anti-bot monitorului. Site-ul poate fi funcțional, dar monitorul nu vede conținutul — adaugă IP-ul serverului agentului ca excepție în Cloudflare (WAF).',
      severity: 'degraded',
    });
    return problems;
  }
  if (status !== null && status >= 520 && status <= 527 && isCloudflare) {
    const map: Record<number, string> = {
      520: 'Serverul de hosting a trimis un răspuns invalid către Cloudflare (520).',
      521: 'Serverul de hosting refuză conexiunile Cloudflare (521) — serverul web e oprit sau blochează IP-urile Cloudflare.',
      522: 'Cloudflare nu a primit răspuns de la serverul de hosting (522 — timeout).',
      523: 'Cloudflare nu poate ajunge la serverul de hosting (523 — origine inaccesibilă).',
      524: 'Serverul de hosting răspunde prea încet (524 — peste 100 s).',
      525: 'Handshake SSL eșuat între Cloudflare și hosting (525).',
      526: 'Certificat SSL invalid pe serverul de hosting (526).',
      527: 'Eroare Railgun/Cloudflare (527).',
    };
    problems.push({ code: `cf_${status}`, message: map[status] ?? `Eroare Cloudflare ${status}`, severity: 'down' });
  }
  for (const p of BODY_PATTERNS) {
    if (p.re.test(bodyText)) problems.push({ code: p.code, message: p.message, severity: p.severity });
  }
  return problems;
}

export async function httpCheck(opts: HttpCheckOptions): Promise<HttpCheckResult> {
  const startUrl = new URL(opts.url);
  const redirects: Array<{ status: number; location: string }> = [];
  const maxRedirects = opts.followRedirects ?? 5;
  let current = startUrl;
  let resp: SingleResponse | null = null;
  const totalStart = performance.now();

  try {
    for (let i = 0; i <= maxRedirects; i++) {
      // ocolirea DNS se aplică doar pe hostul inițial
      const resolveTo = opts.resolveTo && current.hostname === startUrl.hostname ? opts.resolveTo : undefined;
      resp = await singleRequest(current, opts, resolveTo);
      const location = resp.headers['location'];
      if (resp.status >= 300 && resp.status < 400 && location && i < maxRedirects) {
        redirects.push({ status: resp.status, location });
        current = new URL(location, current);
        continue;
      }
      break;
    }
  } catch (err) {
    const e = err as ProbeError;
    return {
      ok: false,
      verdict: 'down',
      url: opts.url,
      finalUrl: current.toString(),
      method: opts.method ?? 'GET',
      status: null,
      statusText: null,
      timings: e.timings ?? { dnsMs: null, connectMs: null, tlsMs: null, ttfbMs: null, totalMs: Math.round(performance.now() - totalStart) },
      remoteAddress: null,
      headers: {},
      redirects,
      bodyBytes: 0,
      bodyText: '',
      bodySnippet: '',
      keywordFound: null,
      problems: [{ code: (e.code ?? 'error').toLowerCase(), message: e.message, severity: 'down' }],
      error: { code: e.code ?? 'ERROR', message: e.message },
      tls: null,
    };
  }

  const r = resp!;
  const contentType = r.headers['content-type'] ?? '';
  const isText = /text|json|xml|javascript|html/i.test(contentType) || contentType === '';
  const bodyText = isText ? r.body.toString('utf8') : '';
  const problems = detectProblems(r.status, r.headers, bodyText);

  let keywordFound: boolean | null = null;
  if (opts.keyword && opts.keyword.trim() && (opts.method ?? 'GET') !== 'HEAD') {
    keywordFound = bodyText.toLowerCase().includes(opts.keyword.trim().toLowerCase());
    if (!keywordFound && r.status < 400 && !problems.some((p) => p.code === 'cf_challenge')) {
      problems.push({ code: 'keyword_missing', message: `Textul așteptat „${opts.keyword}” nu apare în pagină.`, severity: 'degraded' });
    }
  }

  if (r.status >= 500 && !problems.some((p) => p.severity === 'down')) {
    problems.push({ code: `http_${r.status}`, message: `Serverul răspunde cu eroarea HTTP ${r.status} ${r.statusText}.`, severity: 'down' });
  } else if ((r.status === 404 || r.status === 410) && !problems.length) {
    problems.push({ code: `http_${r.status}`, message: `Pagina nu există (HTTP ${r.status}).`, severity: 'down' });
  } else if (r.status === 429) {
    problems.push({ code: 'http_429', message: 'Serverul limitează cererile (HTTP 429).', severity: 'degraded' });
  } else if ((r.status === 401 || r.status === 403) && !problems.length) {
    problems.push({ code: `http_${r.status}`, message: `Acces refuzat (HTTP ${r.status}) — poate un firewall/WAF blochează monitorul.`, severity: 'degraded' });
  }

  const slow = opts.slowThresholdMs ?? 4000;
  if (r.timings.totalMs > slow && !problems.some((p) => p.severity === 'down')) {
    problems.push({ code: 'slow', message: `Răspuns lent: ${(r.timings.totalMs / 1000).toFixed(1)} s (prag ${(slow / 1000).toFixed(1)} s).`, severity: 'degraded' });
  }
  if (r.tls && !r.tls.authorized && r.tls.authorizationError) {
    problems.push({ code: 'tls_invalid', message: translateNetError(r.tls.authorizationError, `Certificat SSL invalid: ${r.tls.authorizationError}`), severity: 'down' });
  }

  const verdict: HttpCheckResult['verdict'] = problems.some((p) => p.severity === 'down')
    ? 'down'
    : problems.some((p) => p.severity === 'degraded')
      ? 'degraded'
      : 'up';

  const text = /html/i.test(contentType) ? stripHtml(bodyText) : bodyText;
  return {
    ok: verdict === 'up',
    verdict,
    url: opts.url,
    finalUrl: current.toString(),
    method: opts.method ?? 'GET',
    status: r.status,
    statusText: r.statusText,
    timings: { ...r.timings, totalMs: Math.round(performance.now() - totalStart) },
    remoteAddress: r.remoteAddress,
    headers: r.headers,
    redirects,
    bodyBytes: r.body.length,
    bodyText,
    bodySnippet: text.slice(0, 1500),
    keywordFound,
    problems,
    error: null,
    tls: r.tls,
  };
}

/** Versiune compactă pentru agent și pentru stocare. */
export function summarizeHttpCheck(r: HttpCheckResult) {
  return {
    url: r.url,
    finalUrl: r.finalUrl !== r.url ? r.finalUrl : undefined,
    verdict: r.verdict,
    status: r.status,
    timings: r.timings,
    remoteAddress: r.remoteAddress,
    server: r.headers['server'],
    poweredBy: r.headers['x-powered-by'],
    cfRay: r.headers['cf-ray'],
    cfCacheStatus: r.headers['cf-cache-status'],
    redirects: r.redirects.length ? r.redirects : undefined,
    keywordFound: r.keywordFound,
    problems: r.problems,
    error: r.error,
    tls: r.tls ? { authorized: r.tls.authorized, daysLeft: r.tls.daysLeft, issuer: r.tls.issuer, validTo: r.tls.validTo } : null,
    pageTextStart: r.bodySnippet.slice(0, 600),
  };
}
