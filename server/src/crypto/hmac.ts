import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Semnătură HMAC folosită între agent și pluginul WordPress / hook-ul WHMCS.
 *
 * Mesajul semnat:  timestamp \n nonce \n METHOD \n path \n sha256(body)
 * Antete:          X-Datix-Timestamp, X-Datix-Nonce, X-Datix-Signature (hex)
 */
export interface SignedHeaders {
  'X-Datix-Timestamp': string;
  'X-Datix-Nonce': string;
  'X-Datix-Signature': string;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function canonicalString(timestamp: string, nonce: string, method: string, path: string, body: string | Buffer): string {
  return [timestamp, nonce, method.toUpperCase(), path, sha256Hex(body)].join('\n');
}

export function signRequest(secret: string, method: string, path: string, body: string | Buffer, nowMs = Date.now()): SignedHeaders {
  const timestamp = String(Math.floor(nowMs / 1000));
  const nonce = randomBytes(16).toString('hex');
  const signature = createHmac('sha256', secret).update(canonicalString(timestamp, nonce, method, path, body)).digest('hex');
  return { 'X-Datix-Timestamp': timestamp, 'X-Datix-Nonce': nonce, 'X-Datix-Signature': signature };
}

export type VerifyResult = { ok: true; nonce: string } | { ok: false; reason: string };

export function verifySignature(
  secret: string,
  headers: { timestamp?: string; nonce?: string; signature?: string },
  method: string,
  path: string,
  body: string | Buffer,
  nowMs = Date.now(),
  maxSkewSec = 300,
): VerifyResult {
  const { timestamp, nonce, signature } = headers;
  if (!timestamp || !nonce || !signature) return { ok: false, reason: 'antete de semnătură lipsă' };
  if (!/^\d{9,12}$/.test(timestamp)) return { ok: false, reason: 'timestamp invalid' };
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(nonce)) return { ok: false, reason: 'nonce invalid' };
  const skew = Math.abs(Math.floor(nowMs / 1000) - Number(timestamp));
  if (skew > maxSkewSec) return { ok: false, reason: `ceas desincronizat (${skew}s)` };
  const expected = createHmac('sha256', secret).update(canonicalString(timestamp, nonce, method, path, body)).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'hex');
  } catch {
    return { ok: false, reason: 'semnătură invalidă' };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'semnătură invalidă' };
  return { ok: true, nonce };
}
