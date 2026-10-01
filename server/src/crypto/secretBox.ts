import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Criptare AES-256-GCM pentru datele de acces salvate în baza de date
 * (chei API, login key DirectAdmin, secretul TOTP etc.).
 * Cheia derivă din APP_SECRET_KEY prin HKDF; fără ea, datele nu pot fi citite.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(masterSecret: string, purpose = 'datix-ai/secrets/v1') {
    this.key = Buffer.from(hkdfSync('sha256', Buffer.from(masterSecret, 'utf8'), Buffer.alloc(0), Buffer.from(purpose, 'utf8'), 32));
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${Buffer.concat([iv, tag, ct]).toString('base64')}`;
  }

  decrypt(token: string): string {
    if (!token.startsWith('v1:')) throw new Error('Format de date criptate necunoscut');
    const raw = Buffer.from(token.slice(3), 'base64');
    if (raw.length < 28) throw new Error('Date criptate corupte');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}
