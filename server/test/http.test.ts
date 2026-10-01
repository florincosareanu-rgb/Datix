import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../src/services';
import { buildApp } from '../src/http/app';
import { signRequest } from '../src/crypto/hmac';
import { totpAt } from '../src/auth/totp';
import { makeServices } from './helpers';

// API-ul HTTP real (Fastify), apelat în proces: configurarea contului, protecții, webhook-uri, descărcări.

let s: Services;
let cleanup: () => void;
let app: FastifyInstance;
let cookie = '';
let totpSecret = '';
const ORIGIN = 'http://localhost:3000';
const mutate = { 'x-datix-csrf': '1', origin: ORIGIN };

beforeAll(async () => {
  ({ s, cleanup } = makeServices());
  app = await buildApp(s);
});
afterAll(async () => {
  await app.close();
  cleanup();
});

function sessionCookie(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return (raw ?? '').split(';')[0] ?? '';
}

describe('configurarea inițială și autentificarea', () => {
  it('cere configurare la prima pornire', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/auth/session' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ authenticated: false, setupRequired: true, setupTokenRequired: true });
  });

  it('respinge cererile fără antetul anti-CSRF sau din altă origine', async () => {
    const body = { displayName: 'Test', email: 'test@datix.ro', password: 'O-parola-Foarte-Lunga-2026' };
    expect((await app.inject({ method: 'POST', url: '/api/setup/start', payload: body })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/setup/start', payload: body, headers: { 'x-datix-csrf': '1', origin: 'https://evil.example' } })).statusCode).toBe(403);
  });

  it('nu permite configurarea fără codul de instalare', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/setup/start', headers: mutate, payload: { token: 'gresit', displayName: 'Test', email: 'test@datix.ro', password: 'O-parola-Foarte-Lunga-2026' } });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
  });

  it('creează contul cu parolă + 2FA și emite coduri de recuperare', async () => {
    const token = s.auth.ensureSetupToken();
    const start = await app.inject({ method: 'POST', url: '/api/setup/start', headers: mutate, payload: { token, displayName: 'Florin', email: 'test@datix.ro', password: 'O-parola-Foarte-Lunga-2026' } });
    expect(start.statusCode).toBe(200);
    cookie = sessionCookie(start.headers['set-cookie']);
    expect(start.headers['set-cookie']).toMatch(/HttpOnly/i);
    expect(start.headers['set-cookie']).toMatch(/SameSite=Strict/i);
    totpSecret = start.json().totpSecret;

    const confirm = await app.inject({ method: 'POST', url: '/api/setup/totp', headers: { ...mutate, cookie }, payload: { code: totpAt(totpSecret, Date.now()) } });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().recoveryCodes).toHaveLength(8);

    const session = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });
    expect(session.json()).toMatchObject({ authenticated: true, setupRequired: false, totpEnabled: true, displayName: 'Florin' });
  });

  it('blochează datele fără sesiune și le servește cu sesiune', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/status' })).statusCode).toBe(401);
    const r = await app.inject({ method: 'GET', url: '/api/status', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json().monitors.length).toBeGreaterThan(5);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-frame-options']).toBe('DENY');
  });

  it('autentificarea cu parolă cere și codul 2FA', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/auth/password', headers: mutate, payload: { email: 'test@datix.ro', password: 'O-parola-Foarte-Lunga-2026', code: '000000' } });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    const wrongPass = await app.inject({ method: 'POST', url: '/api/auth/password', headers: mutate, payload: { email: 'test@datix.ro', password: 'gresita', code: totpAt(totpSecret, Date.now() + 30_000) } });
    expect(wrongPass.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('acțiunile sensibile cer confirmare', () => {
  it('cheile se pot schimba doar după confirmare (Face ID / cod 2FA)', async () => {
    // sesiunea de configurare are o confirmare inițială; o anulăm ca să testăm cazul normal
    s.db.prepare('UPDATE sessions SET step_up_until = 0').run();
    const r = await app.inject({ method: 'PUT', url: '/api/settings/secrets/llm.apiKey', headers: { ...mutate, cookie }, payload: { value: 'sk-test' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('step_up_required');

    const step = await app.inject({ method: 'POST', url: '/api/auth/stepup/totp', headers: { ...mutate, cookie }, payload: { code: totpAt(totpSecret, Date.now() + 30_000) } });
    expect(step.statusCode).toBe(200);
    const ok = await app.inject({ method: 'PUT', url: '/api/settings/secrets/llm.apiKey', headers: { ...mutate, cookie }, payload: { value: 'sk-test-1234567890' } });
    expect(ok.statusCode).toBe(200);
    expect(JSON.stringify(ok.json())).not.toContain('sk-test-1234567890');
    expect(ok.json().secrets['llm.apiKey'].configured).toBe(true);
  });

  it('descarcă pluginul WordPress (cu cheia inclusă) și hook-ul WHMCS', async () => {
    const zip = await app.inject({ method: 'GET', url: '/api/downloads/wordpress-plugin.zip', headers: { cookie } });
    expect(zip.statusCode).toBe(200);
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(zip.rawPayload.subarray(0, 2).toString()).toBe('PK');
    const hook = await app.inject({ method: 'GET', url: '/api/downloads/whmcs-hook.php', headers: { cookie } });
    expect(hook.statusCode).toBe(200);
    expect(hook.body).toContain(`define('DATIX_AI_SECRET', '${s.secrets.get('whmcs.webhookSecret')}');`);
  });
});

describe('webhook-uri semnate', () => {
  const path = '/api/webhooks/whmcs';
  const body = JSON.stringify({ event: 'cron.heartbeat', data: { at: 1 }, sent_at: 1 });

  it('acceptă cererea semnată, o respinge la reluare și refuză semnăturile greșite', async () => {
    const headers = { ...signRequest(s.secrets.get('whmcs.webhookSecret')!, 'POST', path, body), 'content-type': 'application/json' };
    expect((await app.inject({ method: 'POST', url: path, headers, payload: body })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: path, headers, payload: body })).statusCode).toBe(409);
    const forged = { ...signRequest('cheie-falsa-0000000000000000', 'POST', path, body), 'content-type': 'application/json' };
    expect((await app.inject({ method: 'POST', url: path, headers: forged, payload: body })).statusCode).toBe(401);
    const n = s.db.prepare("SELECT COUNT(*) n FROM events_inbox WHERE source = 'whmcs' AND event = 'cron.heartbeat'").get() as { n: number };
    expect(n.n).toBe(1);
  });
});
