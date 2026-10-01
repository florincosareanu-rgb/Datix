import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Services } from '../services';
import { SESSION_COOKIE, AuthError } from '../auth/service';
import { HttpError } from './context';
import { IntegrationError } from '../integrations/http';
import { LlmError } from '../llm/types';
import { authRoutes } from './routes/auth';
import { chatRoutes } from './routes/chat';
import { statusRoutes } from './routes/status';
import { ticketRoutes } from './routes/tickets';
import { settingsRoutes } from './routes/settings';
import { miscRoutes } from './routes/misc';
import { webhookRoutes } from './routes/webhooks';
import { eventRoutes } from './routes/events';
import { downloadRoutes } from './routes/downloads';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export async function buildApp(s: Services): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: process.env.TRUST_PROXY ?? 'loopback,uniquelocal',
    bodyLimit: 1_000_000,
  });

  // corpul brut e necesar pentru verificarea semnăturii webhook-urilor
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as typeof req & { rawBody?: string }).rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      const err = new HttpError(400, 'JSON invalid.');
      done(err, undefined);
    }
  });

  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, error: 'Prea multe cereri. Încearcă din nou peste câteva secunde.', code: 'rate_limited', retryAfter: ctx.after }),
  });

  app.decorateRequest('session', null);

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    req.session = s.auth.getSession(req.cookies[SESSION_COOKIE]);
    // protecție CSRF: cererile care modifică ceva trebuie să vină din aplicație
    const method = req.method.toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !req.url.startsWith('/api/webhooks/')) {
      if (req.headers['x-datix-csrf'] !== '1') throw new HttpError(403, 'Cerere respinsă (CSRF).', 'csrf');
      const origin = req.headers.origin;
      if (origin && origin !== s.config.appOrigin) throw new HttpError(403, 'Origine nepermisă.', 'origin');
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (s.config.appUrl.startsWith('https://')) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    else reply.header('Content-Security-Policy', CSP);
    return payload;
  });

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    const send = (status: number, message: string, code: string | null = null) => reply.status(status).send({ error: message, code });
    if (err instanceof HttpError) return send(err.status, err.message, err.code);
    if (err instanceof AuthError) return send(err.status, err.message, 'auth');
    if (err instanceof IntegrationError) return send(502, err.message, 'integration');
    if (err instanceof LlmError) return send(502, err.message, 'llm');
    const fe = err as FastifyError;
    if (fe.statusCode === 429) return send(429, 'Prea multe cereri. Încearcă din nou peste câteva secunde.', 'rate_limited');
    if (fe.statusCode && fe.statusCode < 500) return send(fe.statusCode, fe.message, fe.code ?? null);
    s.log.error({ err, url: req.url }, 'Eroare internă');
    return send(500, 'A apărut o eroare internă. Detaliile sunt în jurnalul serverului.', 'internal');
  });

  app.get('/api/health', async () => ({ ok: true, version: s.config.version, demo: s.config.demoMode }));

  authRoutes(app, s);
  chatRoutes(app, s);
  statusRoutes(app, s);
  ticketRoutes(app, s);
  settingsRoutes(app, s);
  miscRoutes(app, s);
  webhookRoutes(app, s);
  eventRoutes(app, s);
  downloadRoutes(app, s);

  // interfața web (PWA)
  const dist = s.config.webDist;
  if (existsSync(join(dist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: dist,
      prefix: '/',
      index: ['index.html'],
      setHeaders(res, path) {
        if (/[/\\]assets[/\\]/.test(path)) res.header('Cache-Control', 'public, max-age=31536000, immutable');
        else res.header('Cache-Control', 'no-cache');
        if (path.endsWith('.webmanifest')) res.header('Content-Type', 'application/manifest+json');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Adresă API inexistentă.', code: 'not_found' });
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Adresă API inexistentă.', code: 'not_found' });
      return reply.type('text/plain; charset=utf-8').status(404).send('Interfața web nu e construită. Rulează: npm run build');
    });
  }

  return app;
}
