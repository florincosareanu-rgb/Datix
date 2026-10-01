import { describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { signRequest, verifySignature } from '../src/crypto/hmac';

// Compatibilitatea semnăturilor între agent (Node) și codul PHP (pluginul WordPress, hook-ul WHMCS).
// Rulează doar dacă `php` e instalat (pe GitHub Actions este).

const hasPhp = spawnSync('php', ['-v']).status === 0;
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const SECRET = 'a3f1c9e0b7d24e6f8a1b2c3d4e5f60718293a4b5c6d7e8f9';

function runPhp<T>(file: string, input: unknown): T {
  const out = execFileSync('php', [fixture(file)], { input: JSON.stringify(input), encoding: 'utf8' });
  return JSON.parse(out) as T;
}

/** Rulează PHP fără să blocheze bucla Node (serverul HTTP de test trebuie să poată răspunde). */
function runPhpAsync<T>(file: string, input: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn('php', [fixture(file)]);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out) as T) : reject(new Error(`php a ieșit cu ${code}: ${err}`))));
    child.stdin.end(JSON.stringify(input));
  });
}

type VerifyResult = { ok: true; agent: boolean } | { ok: false; status: number; message: string };

describe.skipIf(!hasPhp)('pluginul WordPress acceptă doar cererile semnate de agent', () => {
  const route = '/dax/v1/health';
  const body = JSON.stringify({ deep: false });

  it('acceptă o cerere semnată corect și respinge reluarea ei', () => {
    const headers = signRequest(SECRET, 'POST', route, body);
    const [first, replay] = runPhp<VerifyResult[]>('wp-auth-harness.php', {
      secret: SECRET,
      mode: 'verify',
      requests: [
        { headers, route, body },
        { headers, route, body },
      ],
    });
    expect(first).toEqual({ ok: true, agent: true });
    expect(replay).toMatchObject({ ok: false, status: 409 });
  });

  it('respinge corpul modificat, ruta schimbată, cheia greșită și antetele lipsă', () => {
    const good = signRequest(SECRET, 'POST', route, body);
    const results = runPhp<VerifyResult[]>('wp-auth-harness.php', {
      secret: SECRET,
      mode: 'verify',
      requests: [
        { headers: signRequest(SECRET, 'POST', route, body), route, body: JSON.stringify({ deep: true }) },
        { headers: signRequest(SECRET, 'POST', route, body), route: '/dax/v1/plugins/toggle', body },
        { headers: signRequest('alta-cheie-complet-diferita-1234567890', 'POST', route, body), route, body },
        { headers: { 'X-Datix-Timestamp': good['X-Datix-Timestamp'] }, route, body },
      ],
    });
    expect(results.map((r) => (r.ok ? 200 : r.status))).toEqual([403, 403, 403, 401]);
  });

  it('respinge cererile vechi (ceas desincronizat)', () => {
    const old = signRequest(SECRET, 'POST', route, body, Date.now() - 10 * 60_000);
    const [r] = runPhp<VerifyResult[]>('wp-auth-harness.php', { secret: SECRET, mode: 'verify', requests: [{ headers: old, route, body }] });
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it('blochează IP-ul după 20 de încercări greșite', () => {
    const bad = Array.from({ length: 21 }, () => ({ headers: signRequest('cheie-gresita-0000000000000000', 'POST', route, body), route, body }));
    const results = runPhp<VerifyResult[]>('wp-auth-harness.php', {
      secret: SECRET,
      mode: 'verify',
      requests: [...bad, { headers: signRequest(SECRET, 'POST', route, body), route, body }],
    });
    expect(results.slice(0, 20).every((r) => !r.ok && r.status === 403)).toBe(true);
    expect(results[20]).toMatchObject({ ok: false, status: 429 });
    expect(results[21]).toMatchObject({ ok: false, status: 429 });
  });

  it('evenimentele trimise de plugin sunt acceptate de agent', () => {
    const path = '/api/webhooks/wordpress';
    const payload = JSON.stringify({ event: 'admin_created', data: { user: 'test' }, sent_at: 1 });
    const h = runPhp<Record<string, string>>('wp-auth-harness.php', { secret: SECRET, mode: 'sign', path, body: payload });
    const r = verifySignature(SECRET, { timestamp: h['X-Datix-Timestamp'], nonce: h['X-Datix-Nonce'], signature: h['X-Datix-Signature'] }, 'POST', path, payload);
    expect(r.ok).toBe(true);
  });
});

describe.skipIf(!hasPhp)('hook-ul WHMCS', () => {
  it('trimite evenimente semnate corect, fără conținutul mesajelor', async () => {
    const received: Array<{ headers: Record<string, string>; body: string; url: string }> = [];
    const server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        received.push({ headers: req.headers as Record<string, string>, body: data, url: req.url ?? '' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const out = await runPhpAsync<{ registered: string[] }>('whmcs-hook-harness.php', {
        url: `http://127.0.0.1:${port}`,
        secret: SECRET,
        fire: [
          { hook: 'TicketOpen', vars: { ticketid: 42, ticketmask: 'ABC-123456', userid: 7, deptid: 1, deptname: 'Suport tehnic', subject: 'Site picat', message: 'Parola mea este secret123', priority: 'High' } },
          { hook: 'AdminLogin', vars: { adminid: 1, username: 'florin' } },
        ],
      });
      expect(out.registered).toEqual(['AdminLogin', 'AfterCronJob', 'AfterShoppingCartCheckout', 'CancellationRequest', 'ClientAdd', 'InvoicePaid', 'TicketOpen', 'TicketUserReply']);
      expect(received).toHaveLength(2);
      for (const r of received) {
        expect(r.url).toBe('/api/webhooks/whmcs');
        const v = verifySignature(SECRET, { timestamp: r.headers['x-datix-timestamp'], nonce: r.headers['x-datix-nonce'], signature: r.headers['x-datix-signature'] }, 'POST', '/api/webhooks/whmcs', r.body);
        expect(v.ok).toBe(true);
      }
      const ticket = JSON.parse(received[0]!.body) as { event: string; data: Record<string, unknown> };
      expect(ticket.event).toBe('ticket.open');
      expect(ticket.data.ticketid).toBe(42);
      expect(received[0]!.body).not.toContain('secret123');
      expect(received[0]!.body).not.toContain('Site picat');
      expect(JSON.parse(received[1]!.body).event).toBe('admin.login');
    } finally {
      server.close();
    }
  });

  it('nu trimite nimic cât timp adresa și cheia nu sunt completate', async () => {
    const out = await runPhpAsync<{ registered: string[] }>('whmcs-hook-harness.php', {
      url: '%%DAX_URL%%',
      secret: '%%DAX_SECRET%%',
      fire: [{ hook: 'AfterCronJob', vars: {} }],
    });
    expect(out.registered.length).toBe(8);
  });
});
