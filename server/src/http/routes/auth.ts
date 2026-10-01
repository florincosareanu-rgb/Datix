import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../../services';
import { SESSION_COOKIE } from '../../auth/service';
import { clearSessionCookie, clientIp, HttpError, parse, requireAuth, requireSession, requireStepUp, setSessionCookie } from '../context';

export function authRoutes(app: FastifyInstance, s: Services) {
  const secure = s.config.appUrl.startsWith('https://');
  const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.get('/api/auth/session', async (req) => {
    const info = s.auth.sessionInfo(req.session);
    return info;
  });

  // ------------------------------------------------------------ configurare inițială
  app.post('/api/setup/start', strict, async (req, reply) => {
    const body = parse(
      z.object({ token: z.string().max(200).optional(), displayName: z.string().min(1).max(80), email: z.string().email(), password: z.string().min(1).max(256) }),
      req.body,
    );
    const r = await s.auth.startSetup(body, clientIp(req), req.headers['user-agent'] ?? null);
    setSessionCookie(reply, r.sessionToken, secure);
    return { otpauthUri: r.otpauthUri, qrDataUrl: r.qrDataUrl, totpSecret: r.totpSecret };
  });

  app.post('/api/setup/totp', strict, async (req) => {
    const session = requireSession(req);
    const body = parse(z.object({ code: z.string().min(6).max(12) }), req.body);
    return s.auth.confirmSetupTotp(session, body.code, clientIp(req));
  });

  // ------------------------------------------------------------ autentificare
  app.post('/api/auth/password', strict, async (req, reply) => {
    const body = parse(z.object({ email: z.string().max(200), password: z.string().max(256), code: z.string().max(20) }), req.body);
    const { token } = await s.auth.loginWithPassword(body, clientIp(req), req.headers['user-agent'] ?? null);
    setSessionCookie(reply, token, secure);
    if (s.auth.failedAttemptsLastHour() >= 5) {
      void s.notifier.notify({ kind: 'security', title: 'Autentificare reușită după mai multe eșecuri', body: `IP: ${clientIp(req) ?? '?'}`, priority: 'normal', dedupeKey: 'login-after-failures' });
    }
    return { ok: true };
  });

  app.post('/api/auth/passkey/options', strict, async () => {
    return s.auth.passkeyAuthOptions('login', null);
  });

  app.post('/api/auth/passkey/verify', strict, async (req, reply) => {
    const body = parse(z.object({ challengeId: z.string(), response: z.any() }), req.body);
    const r = await s.auth.verifyPasskeyAuth('login', body.challengeId, body.response, null, clientIp(req), req.headers['user-agent'] ?? null);
    if (r.token) setSessionCookie(reply, r.token, secure);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    s.auth.revokeSessionByToken(req.cookies[SESSION_COOKIE]);
    clearSessionCookie(reply, secure);
    return { ok: true };
  });

  // ------------------------------------------------------------ confirmare (step-up)
  app.post('/api/auth/stepup/options', strict, async (req) => {
    const session = requireAuth(req, s);
    return s.auth.passkeyAuthOptions('stepup', session);
  });

  app.post('/api/auth/stepup/verify', strict, async (req) => {
    const session = requireAuth(req, s);
    const body = parse(z.object({ challengeId: z.string(), response: z.any() }), req.body);
    const r = await s.auth.verifyPasskeyAuth('stepup', body.challengeId, body.response, session, clientIp(req), null);
    return { stepUpUntil: r.stepUpUntil };
  });

  app.post('/api/auth/stepup/totp', strict, async (req) => {
    const session = requireAuth(req, s);
    const body = parse(z.object({ code: z.string().min(6).max(20) }), req.body);
    return { stepUpUntil: s.auth.stepUpWithTotp(session, body.code, clientIp(req)) };
  });

  // ------------------------------------------------------------ passkeys
  app.get('/api/auth/passkeys', async (req) => {
    requireAuth(req, s);
    return s.auth.listPasskeys();
  });

  app.post('/api/auth/passkeys/options', strict, async (req) => {
    const session = requireSession(req);
    // la configurare (sau primul passkey) e suficientă sesiunea; altfel cerem confirmare
    if (s.auth.passkeyCount() > 0 && session.auth_method !== 'setup' && !s.auth.hasStepUp(session)) {
      throw new HttpError(403, 'Confirmă cu Face ID sau cu codul 2FA.', 'step_up_required');
    }
    return s.auth.passkeyRegistrationOptions(session);
  });

  app.post('/api/auth/passkeys/verify', strict, async (req) => {
    const session = requireSession(req);
    const body = parse(z.object({ challengeId: z.string(), response: z.any(), name: z.string().max(60).default('iPhone') }), req.body);
    return s.auth.verifyPasskeyRegistration(session, body.challengeId, body.response, body.name, clientIp(req));
  });

  app.delete('/api/auth/passkeys/:id', async (req) => {
    requireStepUp(req, s);
    const { id } = req.params as { id: string };
    if (!s.auth.deletePasskey(id, clientIp(req))) throw new HttpError(404, 'Passkey inexistent.');
    return { ok: true };
  });

  // ------------------------------------------------------------ sesiuni, parolă, coduri
  app.get('/api/auth/sessions', async (req) => {
    const session = requireAuth(req, s);
    return s.auth.listSessions(session.id);
  });

  app.delete('/api/auth/sessions/:id', async (req) => {
    const session = requireAuth(req, s);
    const { id } = req.params as { id: string };
    if (!s.auth.revokeSessionByPrefix(id, session.id)) throw new HttpError(404, 'Sesiune inexistentă.');
    return { ok: true };
  });

  app.post('/api/auth/sessions/revoke-others', async (req) => {
    const session = requireStepUp(req, s);
    return { revoked: s.auth.revokeOtherSessions(session.id) };
  });

  app.post('/api/auth/password/change', strict, async (req) => {
    requireStepUp(req, s);
    const body = parse(z.object({ current: z.string().max(256), next: z.string().max(256) }), req.body);
    await s.auth.changePassword(body.current, body.next, clientIp(req));
    return { ok: true };
  });

  app.post('/api/auth/recovery-codes', async (req) => {
    requireStepUp(req, s);
    return { codes: s.auth.regenerateRecoveryCodes(clientIp(req)) };
  });
}
