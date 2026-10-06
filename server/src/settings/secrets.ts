import type { SecretStatus } from '@datix/shared';
import type { DB } from '../db';
import { SecretBox } from '../crypto/secretBox';
import { randomToken } from '../util/ids';
import { secretHint } from '../util/text';

export const SECRET_KEYS = [
  'llm.apiKey',
  'whmcs.identifier',
  'whmcs.secret',
  'whmcs.webhookSecret',
  'directadmin.loginKey',
  'reseller.loginKey',
  'cloudflare.apiToken',
  'wordpress.secret',
  'pagespeed.apiKey',
  'push.vapidPrivateKey',
  'storage.accessKeyId',
  'storage.secretAccessKey',
  'backup.passphrase',
  'mailbox.password',
  'anaf.clientSecret',
  'anaf.accessToken',
  'anaf.refreshToken',
  'gsc.serviceAccount',
] as const;

export type SecretKey = (typeof SECRET_KEYS)[number];

/** Secrete generate de aplicație, pe care proprietarul le copiază în WordPress / WHMCS. */
export const GENERATED_SECRETS: SecretKey[] = ['whmcs.webhookSecret', 'wordpress.secret', 'backup.passphrase'];

/** Secrete gestionate intern (tokenuri obținute automat): nu se setează din interfață. */
export const INTERNAL_SECRETS: SecretKey[] = ['push.vapidPrivateKey', 'anaf.accessToken', 'anaf.refreshToken'];

/** Variabile de mediu acceptate ca alternativă (utile la instalări automate). */
const ENV_FALLBACK: Partial<Record<SecretKey, string>> = {
  'llm.apiKey': 'DEEPSEEK_API_KEY',
  'whmcs.identifier': 'WHMCS_API_IDENTIFIER',
  'whmcs.secret': 'WHMCS_API_SECRET',
  'whmcs.webhookSecret': 'WHMCS_WEBHOOK_SECRET',
  'directadmin.loginKey': 'DIRECTADMIN_LOGIN_KEY',
  'reseller.loginKey': 'RESELLER_LOGIN_KEY',
  'cloudflare.apiToken': 'CLOUDFLARE_API_TOKEN',
  'wordpress.secret': 'WP_CONNECTOR_SECRET',
  'pagespeed.apiKey': 'PAGESPEED_API_KEY',
  'storage.accessKeyId': 'BACKUP_S3_ACCESS_KEY_ID',
  'storage.secretAccessKey': 'BACKUP_S3_SECRET_ACCESS_KEY',
  'backup.passphrase': 'BACKUP_PASSPHRASE',
};

export function isSecretKey(key: string): key is SecretKey {
  return (SECRET_KEYS as readonly string[]).includes(key);
}

export class SecretsService {
  private readonly box: SecretBox;
  private cache = new Map<SecretKey, string | null>();

  constructor(
    private readonly db: DB,
    masterSecret: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.box = new SecretBox(masterSecret);
  }

  get(key: SecretKey): string | null {
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    const row = this.db.prepare('SELECT value_enc FROM secrets WHERE key = ?').get(key) as { value_enc: string } | undefined;
    let value: string | null = null;
    if (row) {
      try {
        value = this.box.decrypt(row.value_enc);
      } catch {
        value = null; // cheie principală schimbată sau date corupte
      }
    }
    if (!value) {
      const envName = ENV_FALLBACK[key];
      value = envName ? (this.env[envName]?.trim() || null) : null;
    }
    this.cache.set(key, value);
    return value;
  }

  set(key: SecretKey, value: string): void {
    const trimmed = value.trim();
    if (!trimmed) return this.delete(key);
    this.db
      .prepare(
        `INSERT INTO secrets (key, value_enc, hint, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, hint = excluded.hint, updated_at = excluded.updated_at`,
      )
      .run(key, this.box.encrypt(trimmed), secretHint(trimmed), Date.now());
    this.cache.set(key, trimmed);
  }

  delete(key: SecretKey): void {
    this.db.prepare('DELETE FROM secrets WHERE key = ?').run(key);
    this.cache.delete(key);
  }

  has(key: SecretKey): boolean {
    return !!this.get(key);
  }

  /** Generează secretul dacă nu există (pentru webhook-uri / conectorul WordPress). */
  ensureGenerated(key: SecretKey, bytes = 32): string {
    const existing = this.get(key);
    if (existing) return existing;
    const value = randomToken(bytes);
    this.set(key, value);
    return value;
  }

  regenerate(key: SecretKey, bytes = 32): string {
    const value = randomToken(bytes);
    this.set(key, value);
    return value;
  }

  status(): Record<string, SecretStatus> {
    const out: Record<string, SecretStatus> = {};
    for (const key of SECRET_KEYS) {
      if (key === 'push.vapidPrivateKey') continue;
      const value = this.get(key);
      out[key] = { configured: !!value, hint: value ? secretHint(value) : null };
    }
    return out;
  }

  /** Criptare/decriptare generală (ex. secretul TOTP). */
  encrypt(value: string): string {
    return this.box.encrypt(value);
  }

  decrypt(token: string): string {
    return this.box.decrypt(token);
  }
}
