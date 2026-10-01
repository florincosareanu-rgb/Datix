import { randomBytes } from 'node:crypto';
import type { Severity } from '@datix/shared';
import { httpCheck, type HttpCheckResult } from './httpCheck';

export interface ScanFinding {
  key: string;
  severity: Severity;
  title: string;
  details: string;
  recommendation: string;
}

export interface SecurityScanResult {
  url: string;
  kind: 'wordpress' | 'whmcs' | 'generic';
  scannedAt: number;
  headersGrade: 'A' | 'B' | 'C' | 'D' | 'F';
  findings: ScanFinding[];
  checkedPaths: number;
}

interface ExposureProbe {
  path: string;
  severity: Severity;
  title: string;
  recommendation: string;
  /** confirmă că răspunsul chiar e fișierul sensibil (evită paginile 404 „moi”) */
  confirm: (r: HttpCheckResult) => boolean;
}

const text = (r: HttpCheckResult) => r.bodyText ?? '';
const ok = (r: HttpCheckResult) => r.status === 200;

const COMMON_PROBES: ExposureProbe[] = [
  {
    path: '/.env',
    severity: 'critical',
    title: 'Fișierul .env e accesibil public',
    recommendation: 'Șterge fișierul din directorul public sau blochează-l din .htaccess. Schimbă imediat toate parolele/cheile din el.',
    confirm: (r) => ok(r) && /^[A-Z][A-Z0-9_]{2,}=.*/m.test(text(r)) && !/<html/i.test(text(r)),
  },
  {
    path: '/.git/HEAD',
    severity: 'high',
    title: 'Depozitul .git e accesibil public',
    recommendation: 'Blochează accesul la /.git (ex. în .htaccess: RedirectMatch 404 /\\.git) sau mută depozitul în afara directorului public.',
    confirm: (r) => ok(r) && /^ref: refs\//.test(text(r).trim()),
  },
  {
    path: '/backup.zip',
    severity: 'critical',
    title: 'Arhivă de backup accesibilă public (backup.zip)',
    recommendation: 'Șterge arhivele de backup din directorul public.',
    confirm: (r) => ok(r) && (r.headers['content-type'] ?? '').includes('zip'),
  },
  {
    path: '/backup.sql',
    severity: 'critical',
    title: 'Dump de bază de date accesibil public (backup.sql)',
    recommendation: 'Șterge fișierul imediat și schimbă parolele din baza de date.',
    confirm: (r) => ok(r) && /(CREATE TABLE|INSERT INTO)/i.test(text(r)),
  },
  {
    path: '/db.sql',
    severity: 'critical',
    title: 'Dump de bază de date accesibil public (db.sql)',
    recommendation: 'Șterge fișierul imediat și schimbă parolele din baza de date.',
    confirm: (r) => ok(r) && /(CREATE TABLE|INSERT INTO)/i.test(text(r)),
  },
  {
    path: '/phpinfo.php',
    severity: 'medium',
    title: 'phpinfo() expus public',
    recommendation: 'Șterge fișierul phpinfo.php — dezvăluie configurația serverului.',
    confirm: (r) => ok(r) && /phpinfo\(\)|PHP Version/i.test(text(r)),
  },
];

const WORDPRESS_PROBES: ExposureProbe[] = [
  {
    path: '/wp-config.php.bak',
    severity: 'critical',
    title: 'Copie a wp-config.php accesibilă public (.bak)',
    recommendation: 'Șterge copia și schimbă parola bazei de date și cheile de securitate WordPress.',
    confirm: (r) => ok(r) && /DB_PASSWORD/.test(text(r)),
  },
  {
    path: '/wp-config.php~',
    severity: 'critical',
    title: 'Copie a wp-config.php accesibilă public (~)',
    recommendation: 'Șterge copia și schimbă parola bazei de date și cheile de securitate WordPress.',
    confirm: (r) => ok(r) && /DB_PASSWORD/.test(text(r)),
  },
  {
    path: '/wp-config.old',
    severity: 'critical',
    title: 'Copie a wp-config.php accesibilă public (.old)',
    recommendation: 'Șterge copia și schimbă parola bazei de date și cheile de securitate WordPress.',
    confirm: (r) => ok(r) && /DB_PASSWORD/.test(text(r)),
  },
  {
    path: '/wp-content/debug.log',
    severity: 'medium',
    title: 'Jurnalul de erori WordPress (debug.log) e public',
    recommendation: 'Dezactivează WP_DEBUG_LOG în producție sau mută jurnalul în afara directorului public; șterge fișierul.',
    confirm: (r) => ok(r) && /PHP (Warning|Notice|Fatal|Deprecated)|\[\d{2}-[A-Za-z]{3}-\d{4}/.test(text(r)),
  },
  {
    path: '/wp-content/uploads/',
    severity: 'low',
    title: 'Listarea directorului uploads e activă',
    recommendation: 'Adaugă „Options -Indexes” în .htaccess.',
    confirm: (r) => ok(r) && /<title>Index of/i.test(text(r)),
  },
  {
    path: '/wp-json/wp/v2/users',
    severity: 'low',
    title: 'Lista utilizatorilor WordPress e publică (enumerare utilizatori)',
    recommendation: 'Restricționează endpoint-ul /wp/v2/users pentru vizitatori (pluginul DAX poate face asta) — ajută atacatorii la ghicirea parolelor.',
    confirm: (r) => ok(r) && /^\s*\[\s*\{.*"slug"/s.test(text(r)),
  },
  {
    path: '/readme.html',
    severity: 'info',
    title: 'Fișierul readme.html dezvăluie că site-ul e WordPress',
    recommendation: 'Poți șterge readme.html (se recreează la actualizări).',
    confirm: (r) => ok(r) && /WordPress/i.test(text(r)),
  },
];

const WHMCS_PROBES: ExposureProbe[] = [
  {
    path: '/install/install.php',
    severity: 'critical',
    title: 'Directorul /install al WHMCS există încă',
    recommendation: 'Șterge imediat directorul /install din WHMCS — permite reinstalarea și preluarea sistemului.',
    confirm: (r) => ok(r) && /WHMCS|install/i.test(text(r)),
  },
  {
    path: '/configuration.php',
    severity: 'critical',
    title: 'configuration.php al WHMCS e servit ca text',
    recommendation: 'PHP nu rulează pentru acest fișier — verifică urgent configurarea serverului și schimbă toate parolele.',
    confirm: (r) => ok(r) && /\$db_password|\$license/.test(text(r)),
  },
  {
    path: '/admin/login.php',
    severity: 'medium',
    title: 'Panoul de administrare WHMCS e la adresa implicită /admin',
    recommendation: 'Redenumește directorul admin (customadminpath în configuration.php) și restricționează-l pe IP.',
    confirm: (r) => ok(r) && /WHMCS|login/i.test(text(r)) && /password/i.test(text(r)),
  },
  {
    path: '/downloads/',
    severity: 'medium',
    title: 'Directorul /downloads al WHMCS are listare publică',
    recommendation: 'Mută directoarele downloads/attachments/templates_c în afara directorului public (recomandarea oficială WHMCS).',
    confirm: (r) => ok(r) && /<title>Index of/i.test(text(r)),
  },
  {
    path: '/attachments/',
    severity: 'high',
    title: 'Directorul /attachments al WHMCS are listare publică',
    recommendation: 'Mută directorul attachments în afara directorului public — conține fișierele trimise de clienți în tichete.',
    confirm: (r) => ok(r) && /<title>Index of/i.test(text(r)),
  },
  {
    path: '/vendor/composer/installed.json',
    severity: 'low',
    title: 'Lista bibliotecilor WHMCS e publică (vendor)',
    recommendation: 'Blochează accesul web la /vendor.',
    confirm: (r) => ok(r) && /"packages"|"name":/.test(text(r)),
  },
];

function gradeHeaders(headers: Record<string, string>, isHttps: boolean): { grade: SecurityScanResult['headersGrade']; findings: ScanFinding[]; key: string } {
  const findings: ScanFinding[] = [];
  let score = 0;
  const has = (h: string) => !!headers[h];
  if (isHttps && has('strict-transport-security')) score++;
  else
    findings.push({
      key: 'hsts',
      severity: 'medium',
      title: 'Lipsește antetul HSTS (Strict-Transport-Security)',
      details: 'Browserul poate fi păcălit să folosească HTTP necriptat la prima vizită.',
      recommendation: 'Activează HSTS din Cloudflare (SSL/TLS → Edge Certificates) sau adaugă antetul în .htaccess.',
    });
  if (has('content-security-policy')) score++;
  else
    findings.push({
      key: 'csp',
      severity: 'low',
      title: 'Lipsește Content-Security-Policy',
      details: 'Fără CSP, un script injectat (XSS) poate rula liber în pagină.',
      recommendation: 'Adaugă o politică CSP (începe cu Content-Security-Policy-Report-Only ca să nu strici site-ul).',
    });
  if (has('x-frame-options') || /frame-ancestors/i.test(headers['content-security-policy'] ?? '')) score++;
  else
    findings.push({
      key: 'xfo',
      severity: 'low',
      title: 'Site-ul poate fi încadrat în alte pagini (clickjacking)',
      details: 'Lipsește X-Frame-Options sau CSP frame-ancestors.',
      recommendation: 'Adaugă „X-Frame-Options: SAMEORIGIN”.',
    });
  if ((headers['x-content-type-options'] ?? '').toLowerCase() === 'nosniff') score++;
  else
    findings.push({
      key: 'xcto',
      severity: 'low',
      title: 'Lipsește X-Content-Type-Options: nosniff',
      details: 'Browserul poate interpreta greșit tipul fișierelor.',
      recommendation: 'Adaugă „X-Content-Type-Options: nosniff”.',
    });
  if (has('referrer-policy')) score++;
  if (has('permissions-policy')) score++;
  const powered = headers['x-powered-by'] ?? '';
  const server = headers['server'] ?? '';
  if (/\d/.test(powered) || /\/\d/.test(server)) {
    findings.push({
      key: 'version_leak',
      severity: 'low',
      title: 'Serverul își dezvăluie versiunile software',
      details: `Antete: ${[server && `Server: ${server}`, powered && `X-Powered-By: ${powered}`].filter(Boolean).join('; ')}`,
      recommendation: 'Ascunde versiunile (expose_php = Off, ServerTokens Prod) — sau cere furnizorului de hosting.',
    });
  }
  const grade: SecurityScanResult['headersGrade'] = score >= 6 ? 'A' : score >= 5 ? 'B' : score >= 3 ? 'C' : score >= 2 ? 'D' : 'F';
  return { grade, findings, key: 'headers' };
}

export async function securityScan(url: string, kind: SecurityScanResult['kind'], opts: { timeoutMs?: number } = {}): Promise<SecurityScanResult> {
  const base = new URL(url);
  const origin = base.origin;
  const findings: ScanFinding[] = [];
  const main = await httpCheck({ url: origin + '/', timeoutMs: opts.timeoutMs ?? 20_000 });
  const host = base.hostname;
  const isHttps = base.protocol === 'https:';

  if (!main.error) {
    const g = gradeHeaders(main.headers, isHttps);
    for (const f of g.findings) findings.push({ ...f, key: `${host}:${f.key}` });
    // Redirect HTTP → HTTPS
    if (isHttps) {
      const plain = await httpCheck({ url: `http://${base.host}/`, followRedirects: 0, timeoutMs: 15_000 }).catch(() => null);
      if (plain && plain.status === 200) {
        findings.push({
          key: `${host}:no_https_redirect`,
          severity: 'medium',
          title: 'Site-ul se încarcă și pe HTTP necriptat',
          details: 'http:// nu redirecționează către https://.',
          recommendation: 'Activează „Always Use HTTPS” în Cloudflare sau redirecționarea în .htaccess.',
        });
      }
    }
  }

  // Răspunsul pentru o adresă inexistentă — ca să detectăm paginile 404 „moi” (care răspund 200)
  const randomPath = `/dax-${randomBytes(6).toString('hex')}.txt`;
  const baseline = await httpCheck({ url: origin + randomPath, timeoutMs: 15_000, followRedirects: 0 }).catch(() => null);
  const baselineLen = baseline?.bodyBytes ?? -1;

  const probes = [...COMMON_PROBES, ...(kind === 'wordpress' ? WORDPRESS_PROBES : []), ...(kind === 'whmcs' ? WHMCS_PROBES : [])];
  let checked = 0;
  for (const probe of probes) {
    checked++;
    const r = await httpCheck({ url: origin + probe.path, timeoutMs: 15_000, followRedirects: 0, maxBodyBytes: 200_000 }).catch(() => null);
    if (!r || r.error) continue;
    if (baseline && baseline.status === 200 && r.status === 200 && Math.abs(r.bodyBytes - baselineLen) < 64) continue; // 404 moale
    if (probe.confirm(r)) {
      findings.push({
        key: `${host}:exposed:${probe.path}`,
        severity: probe.severity,
        title: probe.title,
        details: `${origin}${probe.path} răspunde cu HTTP ${r.status} (${r.bodyBytes} octeți).`,
        recommendation: probe.recommendation,
      });
    }
  }

  if (kind === 'wordpress') {
    const xmlrpc = await httpCheck({ url: origin + '/xmlrpc.php', timeoutMs: 15_000, followRedirects: 0 }).catch(() => null);
    if (xmlrpc && xmlrpc.status === 405 && /XML-RPC server accepts POST requests only/i.test(xmlrpc.bodyText)) {
      findings.push({
        key: `${host}:xmlrpc`,
        severity: 'low',
        title: 'XML-RPC e activ',
        details: 'xmlrpc.php e folosit des pentru atacuri de ghicire a parolelor și DDoS.',
        recommendation: 'Dezactivează XML-RPC dacă nu folosești aplicația mobilă WordPress sau Jetpack (pluginul DAX îl poate bloca).',
      });
    }
  }

  const g = main.error ? 'F' : gradeHeaders(main.headers, isHttps).grade;
  return { url: origin, kind, scannedAt: Date.now(), headersGrade: g, findings, checkedPaths: checked };
}
