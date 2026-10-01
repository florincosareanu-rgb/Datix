import type { AppSettings, IntegrationKey, IntegrationStatusDTO } from '@datix/shared';
import type { DB } from '../db';
import { defaultSettings } from './defaults';
import { settingsSchema } from './schema';
import { safeJsonParse } from '../util/text';

type Json = Record<string, unknown>;

function isPlainObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Îmbinare profundă: obiectele se îmbină, tablourile și valorile simple se înlocuiesc. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : (patch as T));
  const out: Json = { ...(base as Json) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const current = out[k];
    out[k] = isPlainObject(current) && isPlainObject(v) ? deepMerge(current, v) : v;
  }
  return out as T;
}

export class SettingsService {
  private cache: AppSettings | null = null;
  private listeners = new Set<(s: AppSettings) => void>();

  constructor(
    private readonly db: DB,
    private readonly appUrl: string,
  ) {}

  get(): AppSettings {
    if (this.cache) return this.cache;
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('app') as { value: string } | undefined;
    const stored = safeJsonParse<Json>(row?.value, {});
    const merged = deepMerge(defaultSettings(this.appUrl), stored);
    merged.general.appUrl = this.appUrl;
    const parsed = settingsSchema.safeParse(merged);
    // dacă ceva salvat nu mai e valid (ex. după o actualizare), revenim la valorile implicite pentru acele câmpuri
    this.cache = parsed.success ? parsed.data : defaultSettings(this.appUrl);
    return this.cache;
  }

  /** Aplică o modificare parțială. Aruncă eroare cu mesaj în română dacă rezultatul nu e valid. */
  update(patch: unknown): AppSettings {
    const merged = deepMerge(this.get(), patch);
    merged.general.appUrl = this.appUrl;
    const parsed = settingsSchema.safeParse(merged);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new SettingsValidationError(msg);
    }
    this.db
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run('app', JSON.stringify(parsed.data), Date.now());
    this.cache = parsed.data;
    for (const l of this.listeners) {
      try {
        l(parsed.data);
      } catch {
        /* un ascultător defect nu trebuie să blocheze salvarea */
      }
    }
    return parsed.data;
  }

  onChange(listener: (s: AppSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ------------------------------------------------------------- starea integrărilor

  recordIntegrationTest(key: IntegrationKey, ok: boolean, message: string): void {
    this.db
      .prepare(
        `INSERT INTO integration_status (key, last_test_at, last_test_ok, last_test_message) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET last_test_at = excluded.last_test_at, last_test_ok = excluded.last_test_ok, last_test_message = excluded.last_test_message`,
      )
      .run(key, Date.now(), ok ? 1 : 0, message.slice(0, 1000));
  }

  integrationTestStatus(key: IntegrationKey): Pick<IntegrationStatusDTO, 'lastTestAt' | 'lastTestOk' | 'lastTestMessage'> {
    const row = this.db.prepare('SELECT * FROM integration_status WHERE key = ?').get(key) as
      | { last_test_at: number | null; last_test_ok: number | null; last_test_message: string | null }
      | undefined;
    return {
      lastTestAt: row?.last_test_at ?? null,
      lastTestOk: row?.last_test_ok == null ? null : row.last_test_ok === 1,
      lastTestMessage: row?.last_test_message ?? null,
    };
  }
}

export class SettingsValidationError extends Error {}
