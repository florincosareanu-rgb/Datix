import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../../services';
import { HttpError, parse, requireAuth } from '../context';

export function miscRoutes(app: FastifyInstance, s: Services) {
  // ------------------------------------------------------------ notificări + push
  app.get('/api/notifications', async (req) => {
    requireAuth(req, s);
    return { items: s.notifier.list(100), unread: s.notifier.unreadCount() };
  });

  app.post('/api/notifications/read', async (req) => {
    requireAuth(req, s);
    const body = parse(z.object({ id: z.string().optional() }), req.body);
    s.notifier.markRead(body.id);
    return { unread: s.notifier.unreadCount() };
  });

  app.get('/api/push/key', async (req) => {
    requireAuth(req, s);
    return { publicKey: s.notifier.vapidPublicKey(), subscriptions: s.notifier.subscriptionCount() };
  });

  app.post('/api/push/subscribe', async (req) => {
    requireAuth(req, s);
    const body = parse(
      z.object({ subscription: z.object({ endpoint: z.string().url().max(2000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) }) }),
      req.body,
    );
    s.notifier.subscribe(body.subscription, req.headers['user-agent'] ?? null);
    s.audit.log({ actor: 'owner', action: 'push.subscribed', details: req.headers['user-agent'] ?? null });
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', async (req) => {
    requireAuth(req, s);
    const body = parse(z.object({ endpoint: z.string().max(2000) }), req.body);
    s.notifier.unsubscribe(body.endpoint);
    return { ok: true };
  });

  app.post('/api/push/test', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    requireAuth(req, s);
    const devices = await s.notifier.sendTest();
    return { devices };
  });

  // ------------------------------------------------------------ business, rapoarte, consum
  app.get('/api/business', async (req) => {
    requireAuth(req, s);
    return s.business.dto();
  });

  app.post('/api/business/refresh', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    requireAuth(req, s);
    await s.business.refresh();
    return s.business.dto();
  });

  app.get('/api/reports', async (req) => {
    requireAuth(req, s);
    return s.reports.list(60);
  });

  app.get('/api/reports/:id', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    const r = s.reports.get(id);
    if (!r) throw new HttpError(404, 'Raportul nu există.');
    return r;
  });

  app.post('/api/reports/daily', { config: { rateLimit: { max: 3, timeWindow: '5 minutes' } } }, async (req) => {
    requireAuth(req, s);
    return s.reports.generateDaily();
  });

  app.get('/api/usage', async (req) => {
    requireAuth(req, s);
    return s.llm.usageSummary();
  });

  // ------------------------------------------------------------ audit, cunoștințe, memorie, copii fișiere
  app.get('/api/audit', async (req) => {
    requireAuth(req, s);
    const q = parse(z.object({ before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(500).default(100), actor: z.enum(['owner', 'agent', 'system']).optional() }), req.query);
    return s.audit.list(q);
  });

  app.get('/api/kb', async (req) => {
    requireAuth(req, s);
    return s.kb.list();
  });

  const kbBody = z.object({ title: z.string().min(2).max(200), content: z.string().min(1).max(100_000), tags: z.array(z.string().max(40)).max(20).default([]) });

  app.post('/api/kb', async (req) => {
    requireAuth(req, s);
    const body = parse(kbBody, req.body);
    const doc = s.kb.upsert(body);
    s.audit.log({ actor: 'owner', action: 'kb.created', target: body.title });
    return doc;
  });

  app.put('/api/kb/:id', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    if (!s.kb.get(id)) throw new HttpError(404, 'Documentul nu există.');
    const body = parse(kbBody, req.body);
    return s.kb.upsert({ id, ...body });
  });

  app.delete('/api/kb/:id', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    if (!s.kb.remove(id)) throw new HttpError(404, 'Documentul nu există.');
    s.audit.log({ actor: 'owner', action: 'kb.deleted', target: id });
    return { ok: true };
  });

  app.get('/api/memory', async (req) => {
    requireAuth(req, s);
    return s.memory.list(200);
  });

  app.delete('/api/memory/:id', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    if (!s.memory.remove(id)) throw new HttpError(404, 'Notița nu există.');
    return { ok: true };
  });

  app.get('/api/file-backups', async (req) => {
    requireAuth(req, s);
    return s.fileBackups.list(undefined, undefined, 100);
  });
}
