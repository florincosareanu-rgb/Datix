import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// TOTP conform RFC 6238 (SHA-1, 6 cifre, pas de 30 s) — compatibil cu Google Authenticator,
// Microsoft Authenticator, 1Password, Authy, aplicația Parole din iOS etc.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Secret TOTP invalid');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
  const code =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totpAt(secretBase32: string, timeMs: number, step = 30): string {
  return hotp(base32Decode(secretBase32), Math.floor(timeMs / 1000 / step));
}

/**
 * Verifică un cod TOTP cu o toleranță de ±1 pas (±30 s).
 * Întoarce pasul de timp folosit (pentru protecția la refolosire) sau null.
 */
export function verifyTotp(secretBase32: string, code: string, timeMs = Date.now(), window = 1, step = 30): number | null {
  const normalized = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return null;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(timeMs / 1000 / step);
  for (let delta = -window; delta <= window; delta++) {
    const candidate = hotp(secret, counter + delta);
    const a = Buffer.from(candidate);
    const b = Buffer.from(normalized);
    if (a.length === b.length && timingSafeEqual(a, b)) return counter + delta;
  }
  return null;
}

export function totpUri(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}
