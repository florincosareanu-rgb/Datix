import type { NetApi } from '../integrations/types';
import type { HttpCheckResult } from '../integrations/net/httpCheck';
import { detectProblems } from '../integrations/net/httpCheck';
import { wpIsBroken } from './state';

const rand = (a: number, b: number) => Math.round(a + Math.random() * (b - a));

function fakeHttp(url: string, keyword?: string): HttpCheckResult {
  const u = new URL(url);
  const broken = wpIsBroken() && (u.hostname === 'datix.ro' || u.hostname === 'www.datix.ro');
  const body = broken
    ? '<html><head><title>Eroare WordPress</title></head><body><p>There has been a critical error on this website.</p></body></html>'
    : `<html><head><title>${u.hostname === 'my.datix.ro' ? 'Zona clienți — Datix' : 'Datix — găzduire web și servicii IT'}</title></head><body>Datix — găzduire web, domenii, web design WordPress.</body></html>`;
  const total = rand(280, 900);
  const headers = { server: 'cloudflare', 'cf-ray': `8f${rand(1000, 9999)}-OTP`, 'content-type': 'text/html; charset=UTF-8', 'cf-cache-status': 'DYNAMIC' };
  const status = broken ? 500 : 200;
  const problems = detectProblems(status, headers, body);
  if (keyword && !body.toLowerCase().includes(keyword.toLowerCase()) && !broken) problems.push({ code: 'keyword_missing', message: `Textul „${keyword}” lipsește.`, severity: 'degraded' });
  if (status >= 500 && !problems.some((p) => p.severity === 'down')) problems.push({ code: 'http_500', message: 'Serverul răspunde cu eroarea HTTP 500.', severity: 'down' });
  const verdict = problems.some((p) => p.severity === 'down') ? 'down' : problems.length ? 'degraded' : 'up';
  return {
    ok: verdict === 'up',
    verdict,
    url,
    finalUrl: url,
    method: 'GET',
    status,
    statusText: broken ? 'Internal Server Error' : 'OK',
    timings: { dnsMs: rand(5, 30), connectMs: rand(20, 60), tlsMs: rand(60, 140), ttfbMs: total - 40, totalMs: total },
    remoteAddress: '104.21.32.1',
    headers,
    redirects: [],
    bodyBytes: body.length,
    bodyText: body,
    bodySnippet: body.replace(/<[^>]+>/g, ' ').trim(),
    keywordFound: keyword ? body.toLowerCase().includes(keyword.toLowerCase()) : null,
    problems,
    error: null,
    tls: { authorized: true, authorizationError: null, validFrom: '2026-08-15', validTo: '2026-11-13', daysLeft: 43, issuer: "Google Trust Services / WE1", subject: u.hostname, altNames: [u.hostname], protocol: 'TLSv1.3' },
  };
}

export const demoNet: NetApi = {
  http: async (opts) => {
    await new Promise((r) => setTimeout(r, rand(80, 250)));
    return fakeHttp(opts.url, opts.keyword);
  },
  tls: async (host, opts = {}) => ({
    host,
    connectedTo: opts.ip ?? '104.21.32.1',
    ok: true,
    info: { authorized: true, authorizationError: null, validFrom: '2026-08-15', validTo: '2026-11-13', daysLeft: 43, issuer: opts.ip ? "Let's Encrypt / R11" : 'Google Trust Services / WE1', subject: host, altNames: [host], protocol: 'TLSv1.3' },
    error: null,
    verdict: 'up',
    message: `Certificat valid încă 43 de zile (emis de ${opts.ip ? "Let's Encrypt" : 'Google Trust Services'}).`,
  }),
  dns: async (domain) => ({
    domain,
    at: Date.now(),
    records: {
      A: ['104.21.32.1', '172.67.150.2'],
      AAAA: ['2606:4700:3036::6815:2001'],
      MX: ['10 mail.datix.ro'],
      NS: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
      TXT: ['v=spf1 a mx include:_spf.datix.ro ~all'],
      CAA: [],
    },
    errors: {},
  }),
  emailAuth: async () => ({ spf: 'v=spf1 a mx include:_spf.datix.ro ~all', spfCount: 1, spfAll: '~', dmarc: null, dmarcPolicy: null }),
  domainExpiry: async (domain) => ({ domain, expiresAt: new Date(Date.now() + 214 * 86_400_000).toISOString(), daysLeft: 214, registrar: 'ROTLD', source: 'whois', error: null }),
  blacklist: async (target) => ({
    target,
    kind: /^\d/.test(target) ? 'ip' : 'domain',
    listedOn: [],
    checks: [{ list: 'Spamhaus', zone: 'zen.spamhaus.org', listed: false, code: null, note: null }],
  }),
  securityScan: async (url, kind) => ({
    url,
    kind,
    scannedAt: Date.now(),
    headersGrade: 'C',
    checkedPaths: 12,
    findings: [
      {
        key: `${new URL(url).hostname}:csp`,
        severity: 'low',
        title: 'Lipsește Content-Security-Policy',
        details: 'Fără CSP, un script injectat (XSS) poate rula liber în pagină.',
        recommendation: 'Adaugă o politică CSP (începe cu modul Report-Only).',
      },
      ...(kind === 'wordpress'
        ? [
            {
              key: `${new URL(url).hostname}:xmlrpc`,
              severity: 'low' as const,
              title: 'XML-RPC e activ',
              details: 'xmlrpc.php e folosit des pentru atacuri de ghicire a parolelor.',
              recommendation: 'Dezactivează XML-RPC dacă nu îl folosești.',
            },
          ]
        : []),
    ],
  }),
  fetchPage: async (url) => ({ url, status: 200, contentType: 'text/html', title: 'Pagină demo', problems: [], text: `Conținut simulat pentru ${url}.` }),
  pagespeed: async (url, strategy) => {
    await new Promise((r) => setTimeout(r, 400));
    return {
      url,
      strategy,
      at: Date.now(),
      scores: { performance: strategy === 'mobile' ? 74 : 96, seo: 92, accessibility: 88, bestPractices: 96 },
      lab: { lcpMs: strategy === 'mobile' ? 3100 : 1100, cls: 0.04, tbtMs: 180, fcpMs: 1500, speedIndexMs: 3200, ttfbMs: 420 },
      field: null,
      opportunities: [
        { title: 'Servește imaginile în formate moderne (WebP/AVIF)', savingsMs: 900 },
        { title: 'Elimină resursele care blochează afișarea', savingsMs: 450 },
      ],
    };
  },
  wpVuln: async (type, slug, version) =>
    type === 'plugin' && slug === 'contact-form-7' && version === '5.9.2'
      ? [
          {
            component: slug,
            type,
            version,
            title: 'Contact Form 7 < 5.9.5 — Open Redirect',
            severity: 'medium',
            cve: 'CVE-2024-4704',
            fixedIn: '5.9.5',
            unfixed: false,
            link: 'https://www.wpvulnerability.net/',
          },
        ]
      : [],
};
