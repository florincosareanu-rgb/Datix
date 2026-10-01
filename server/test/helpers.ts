import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { createLogger } from '../src/logger';
import { openDatabase } from '../src/db';
import { buildServices } from '../src/container';
import type { Services } from '../src/services';

/** Servicii complete pe o bază de date temporară (implicit în modul demo, fără programator). */
export function makeServices(env: Record<string, string> = {}): { s: Services; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'datix-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: dir,
    DEMO_MODE: 'true',
    DISABLE_SCHEDULER: 'true',
    APP_URL: 'http://localhost:3000',
    LOG_LEVEL: 'silent',
    ...env,
  });
  const db = openDatabase(config.dataDir);
  const s = buildServices(config, createLogger('silent'), db);
  s.monitoring.syncBuiltin(); // monitoarele implicite (în aplicație le creează pornirea programatorului)
  return {
    s,
    cleanup: () => {
      s.monitoring.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 15_000, stepMs = 25): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor: timp expirat');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
