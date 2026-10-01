import { randomBytes } from 'node:crypto';

/** ID sortabil în timp (timestamp base36 + 10 octeți aleatori). */
export function newId(prefix = ''): string {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rnd = randomBytes(10).toString('hex');
  return `${prefix}${ts}${rnd}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
