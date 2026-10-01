// Mascarea datelor sensibile înainte ca textul să ajungă la AI (DeepSeek) sau în istoricul conversației.
// Păstrăm ce e util pentru diagnostic (domenii, e-mailuri, IP-uri) și ascundem secrete și date personale critice.

const WP_SECRETS = /(define\(\s*['"](?:DB_PASSWORD|AUTH_KEY|SECURE_AUTH_KEY|LOGGED_IN_KEY|NONCE_KEY|AUTH_SALT|SECURE_AUTH_SALT|LOGGED_IN_SALT|NONCE_SALT|DATIX_AI_SECRET|WP_REDIS_PASSWORD|SMTP_PASS(?:WORD)?)['"]\s*,\s*)(['"])(?:(?!\2).)*\2/g;
const WHMCS_SECRETS = /(\$(?:db_password|cc_encryption_hash|license|api_access_key|autoauthkey|mysql_root_password|smtp_password)\s*=\s*)(['"])(?:(?!\2).)*\2/gi;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{16,}=*/g;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g;
const API_KEYS = /\b(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/g;
const KV_SECRET = /\b((?:password|passwd|pass|pwd|parola|parolă|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|login[_-]?key)["']?\s*[:=]\s*["']?)([^\s"',;&<>]{3,})/gi;
const RO_PASSWORD_PHRASE = /\b(parola|parolă|password|pass)(\s+(?:mea|nouă|noua|veche|contului|de la \S+))?\s+(?:este|e|is|era)\s*[:\-]?\s*(\S{3,})/gi;
const IBAN_RO = /\bRO\d{2}\s?[A-Z]{4}(?:\s?[0-9A-Z]{4}){4}\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Validare CNP (cod numeric personal românesc). */
export function isValidCnp(cnp: string): boolean {
  if (!/^[1-9]\d{12}$/.test(cnp)) return false;
  const w = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
  const sum = w.reduce((s, x, i) => s + x * Number(cnp[i]), 0);
  let c = sum % 11;
  if (c === 10) c = 1;
  return c === Number(cnp[12]);
}

export function redactSensitive(input: string): string {
  if (!input) return input;
  let out = input
    .replace(PRIVATE_KEY, '[cheie privată ascunsă]')
    .replace(WP_SECRETS, (_m, pre: string, q: string) => `${pre}${q}[ascuns]${q}`)
    .replace(WHMCS_SECRETS, (_m, pre: string, q: string) => `${pre}${q}[ascuns]${q}`)
    .replace(BEARER, '$1 [ascuns]')
    .replace(JWT, '[token ascuns]')
    .replace(API_KEYS, '[cheie API ascunsă]')
    .replace(RO_PASSWORD_PHRASE, (_m, word: string, extra: string | undefined) => `${word}${extra ?? ''} este [parolă ascunsă]`)
    .replace(KV_SECRET, (_m, pre: string) => `${pre}[ascuns]`)
    .replace(IBAN_RO, '[IBAN ascuns]');
  // numere de card (13-19 cifre, cu spații/cratime) — doar dacă trec testul Luhn
  out = out.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => {
    const digits = m.replace(/\D/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? '[card ascuns]' : m;
  });
  // CNP
  out = out.replace(/\b[1-9]\d{12}\b/g, (m) => (isValidCnp(m) ? '[CNP ascuns]' : m));
  return out;
}

/** Încadrează conținutul extern (tichete, pagini web, loguri) ca date nesigure, nu ca instrucțiuni. */
export function fenceUntrusted(source: string, content: string): string {
  const safe = content.replace(/<\/?untrusted_data[^>]*>/gi, '[tag eliminat]');
  return `<untrusted_data source="${source.replace(/"/g, "'")}">\n${safe}\n</untrusted_data>`;
}
