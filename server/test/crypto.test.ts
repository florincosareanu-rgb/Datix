import { describe, expect, it } from 'vitest';
import { canonicalString, signRequest, verifySignature } from '../src/crypto/hmac';
import { SecretBox } from '../src/crypto/secretBox';
import { base32Decode, base32Encode, totpAt, verifyTotp } from '../src/auth/totp';

describe('semnătura HMAC a cererilor', () => {
  const secret = 'cheie-de-test-suficient-de-lunga-1234';
  const body = '{"event":"ticket.open","data":{"ticketid":1}}';

  it('acceptă cererea semnată corect', () => {
    const h = signRequest(secret, 'POST', '/api/webhooks/whmcs', body);
    const r = verifySignature(secret, { timestamp: h['X-Datix-Timestamp'], nonce: h['X-Datix-Nonce'], signature: h['X-Datix-Signature'] }, 'POST', '/api/webhooks/whmcs', body);
    expect(r).toEqual({ ok: true, nonce: h['X-Datix-Nonce'] });
  });

  it('respinge corp modificat, rută diferită, cheie greșită, cereri vechi', () => {
    const h = signRequest(secret, 'POST', '/api/webhooks/whmcs', body);
    const hdr = { timestamp: h['X-Datix-Timestamp'], nonce: h['X-Datix-Nonce'], signature: h['X-Datix-Signature'] };
    expect(verifySignature(secret, hdr, 'POST', '/api/webhooks/whmcs', body + ' ').ok).toBe(false);
    expect(verifySignature(secret, hdr, 'POST', '/api/webhooks/wordpress', body).ok).toBe(false);
    expect(verifySignature('alta-cheie', hdr, 'POST', '/api/webhooks/whmcs', body).ok).toBe(false);
    const old = signRequest(secret, 'POST', '/x', body, Date.now() - 6 * 60_000);
    const r = verifySignature(secret, { timestamp: old['X-Datix-Timestamp'], nonce: old['X-Datix-Nonce'], signature: old['X-Datix-Signature'] }, 'POST', '/x', body);
    expect(r).toMatchObject({ ok: false });
    expect(verifySignature(secret, { timestamp: hdr.timestamp }, 'POST', '/x', body).ok).toBe(false);
  });

  it('mesajul canonic are forma documentată (identică în PHP)', () => {
    expect(canonicalString('1700000000', 'abcdef0123456789', 'post', '/p', 'x')).toBe(
      '1700000000\nabcdef0123456789\nPOST\n/p\n2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881',
    );
  });
});

describe('criptarea cheilor salvate (AES-256-GCM)', () => {
  it('criptează și decriptează; detectează modificările', () => {
    const box = new SecretBox('cheia-principala-a-aplicatiei-0123456789');
    const enc = box.encrypt('sk-secret-deepseek');
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain('sk-secret');
    expect(box.decrypt(enc)).toBe('sk-secret-deepseek');
    expect(box.encrypt('a')).not.toBe(box.encrypt('a'));
    const raw = Buffer.from(enc.slice(3), 'base64');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    expect(() => box.decrypt(`v1:${raw.toString('base64')}`)).toThrow();
    expect(() => new SecretBox('alta-cheie-principala-0123456789abcdef').decrypt(enc)).toThrow();
  });
});

describe('coduri 2FA (TOTP, RFC 6238)', () => {
  // cheia din RFC: „12345678901234567890” (SHA-1); codurile de 6 cifre sunt ultimele 6 din vectorii de 8 cifre
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('T=%i → %s', (t, code) => {
    expect(totpAt(secret, t * 1000)).toBe(code);
  });

  it('acceptă codul din fereastra de ±30 s și respinge restul', () => {
    const t = 1_700_000_000_000;
    expect(verifyTotp(secret, totpAt(secret, t), t)).not.toBeNull();
    expect(verifyTotp(secret, totpAt(secret, t - 30_000), t)).not.toBeNull();
    expect(verifyTotp(secret, totpAt(secret, t - 120_000), t)).toBeNull();
    expect(verifyTotp(secret, '000000', t)).toBeNull();
  });

  it('base32 dus-întors', () => {
    const buf = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
  });
});
