import { z } from 'zod';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** Adresa publică a aplicației, ex. https://dax.datix.ro (folosită pentru Face ID, linkuri, verificarea originii). */
  APP_URL: z.string().url().default('http://localhost:5173'),
  DATA_DIR: z.string().default('./data'),
  /** Cheia principală (min. 32 caractere) cu care se criptează datele de acces salvate. */
  APP_SECRET_KEY: z.string().optional(),
  DEMO_MODE: bool,
  SETUP_TOKEN: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
  /** Directorul cu interfața construită (web/dist). */
  WEB_DIST: z.string().optional(),
  /** Directorul cu pluginul WordPress și hook-ul WHMCS (pentru descărcări). */
  INTEGRATIONS_DIR: z.string().optional(),
  /** Dezactivează programatorul de verificări (util în teste). */
  DISABLE_SCHEDULER: bool,
});

export interface Config {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  host: string;
  appUrl: string;
  appOrigin: string;
  rpId: string;
  dataDir: string;
  secretKey: string;
  demoMode: boolean;
  setupToken: string | undefined;
  logLevel: string;
  webDist: string;
  integrationsDir: string;
  disableScheduler: boolean;
  version: string;
}

/** Prima cale care există (rădăcina proiectului sau, în dezvoltare, directorul server/); altfel prima. */
function firstExisting(...paths: string[]): string {
  return paths.find((p) => existsSync(p)) ?? paths[0]!;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configurație invalidă: ${issues}`);
  }
  const e = parsed.data;
  const dataDir = resolve(e.DATA_DIR);
  mkdirSync(dataDir, { recursive: true });

  const isProduction = e.NODE_ENV === 'production';
  let secretKey = e.APP_SECRET_KEY;
  if (!secretKey) {
    if (isProduction && !e.DEMO_MODE) {
      throw new Error('APP_SECRET_KEY lipsește. Rulează install.sh sau setează o cheie aleatorie de minim 32 de caractere în .env.');
    }
    // Dezvoltare/demo: generăm o cheie și o păstrăm în directorul de date.
    const keyFile = join(dataDir, '.secret-key');
    if (existsSync(keyFile)) {
      secretKey = readFileSync(keyFile, 'utf8').trim();
    } else {
      secretKey = randomBytes(32).toString('base64url');
      writeFileSync(keyFile, secretKey, { mode: 0o600 });
      try {
        chmodSync(keyFile, 0o600);
      } catch {
        /* ignorăm pe sisteme fără chmod */
      }
    }
  }
  if (secretKey.length < 32) {
    throw new Error('APP_SECRET_KEY trebuie să aibă minim 32 de caractere.');
  }

  const url = new URL(e.APP_URL);
  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    host: e.HOST,
    appUrl: e.APP_URL.replace(/\/+$/, ''),
    appOrigin: url.origin,
    rpId: url.hostname,
    dataDir,
    secretKey,
    demoMode: e.DEMO_MODE,
    setupToken: e.SETUP_TOKEN,
    logLevel: e.LOG_LEVEL,
    webDist: resolve(e.WEB_DIST ?? firstExisting(join(process.cwd(), 'web', 'dist'), join(process.cwd(), '..', 'web', 'dist'))),
    integrationsDir: resolve(e.INTEGRATIONS_DIR ?? firstExisting(join(process.cwd(), 'integrations'), join(process.cwd(), '..', 'integrations'))),
    disableScheduler: e.DISABLE_SCHEDULER,
    version: process.env.DATIX_VERSION ?? '1.0.0',
  };
}
