import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt cu parametrii recomandați de OWASP (N=2^17, r=8, p=1).
const N = 2 ** 17;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 256 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (!n || !r || !p || !salt.length || !expected.length) return false;
  const key = await scrypt(password.normalize('NFKC'), salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Reguli minime pentru parolă; întoarce mesajul de eroare sau null. */
export function passwordProblem(password: string): string | null {
  if (password.length < 12) return 'Parola trebuie să aibă cel puțin 12 caractere.';
  if (password.length > 256) return 'Parola e prea lungă.';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) return 'Folosește cel puțin trei tipuri de caractere: litere mici, litere mari, cifre, simboluri.';
  return null;
}
