import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../../services';
import { HttpError, clientIp, parse, requireAuth, requireStepUp } from '../context';
import { MissionError } from '../../missions/service';
import { CollectionsError } from '../../business/collections';
import { EfacturaError } from '../../business/efactura';
import { SeoError } from '../../business/seo';
import { EmailError } from '../../maintenance/email';
import { nextRunOf } from '../../scheduler';
import { connectorSupports } from '../../integrations/wordpress';
import { errorMessage } from '../../util/text';

// API-ul automatizărilor: misiuni, încasări, clienți în risc, backup, actualizări, integritate,
// livrarea e-mailurilor, e-Factura și SEO.

const KNOWN = [MissionError, CollectionsError, EfacturaError, SeoError, EmailError];

/** Erorile „de business” devin 400 cu mesajul lor (în română). */
async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (KNOWN.some((k) => err instanceof k)) throw new HttpError(400, (err as Error).message, 'invalid');
    throw err;
  }
}

/** Pornește o operațiune lungă în fundal (rezultatul vine prin evenimente / notificare). */
function background(s: Services, name: string, p: Promise<unknown>): void {
  p.catch((err) => s.log.warn({ err: errorMessage(err) }, `${name} a eșuat`));
}

const scheduleSchema = z.object({
  frequency: z.enum(['once', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly']),
  time: z.string().max(5).optional(),
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  dayOfMonth: z.number().int().min(1).max(28).optional(),
  everyHours: z.number().int().min(1).max(12).optional(),
  runAt: z.number().int().nullable().optional(),
});

export function automationRoutes(app: FastifyInstance, s: Services) {
  // ------------------------------------------------------------ misiuni programate
  app.get('/api/missions', async (req) => {
    requireAuth(req, s);
    return s.missions.list();
  });

  app.post('/api/missions', async (req) => {
    requireAuth(req, s);
    const b = parse(z.object({ title: z.string().max(80), prompt: z.string().max(4000), schedule: scheduleSchema, allowChanges: z.boolean().default(false) }), req.body);
    return guard(() => s.missions.create({ title: b.title, prompt: b.prompt, schedule: b.schedule, allowChanges: b.allowChanges }));
  });

  app.patch('/api/missions/:id', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    const b = parse(
      z.object({ title: z.string().max(80).optional(), prompt: z.string().max(4000).optional(), schedule: scheduleSchema.optional(), allowChanges: z.boolean().optional(), enabled: z.boolean().optional() }),
      req.body,
    );
    return guard(() => s.missions.update(id, b));
  });

  app.delete('/api/missions/:id', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    if (!s.missions.delete(id)) throw new HttpError(404, 'Misiunea nu există.');
    return { ok: true };
  });

  app.post('/api/missions/:id/run', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    return guard(() => s.missions.runNow(id));
  });

  // ------------------------------------------------------------ încasări
  app.get('/api/collections', async (req) => {
    requireAuth(req, s);
    return s.collections.overview();
  });

  app.post('/api/collections/scan', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    requireAuth(req, s);
    return guard(() => s.collections.scan('manual'));
  });

  app.patch('/api/collections/:id', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    const b = parse(z.object({ subject: z.string().max(200).optional(), message: z.string().max(8000).optional() }), req.body);
    return guard(() => s.collections.update(id, b));
  });

  app.post('/api/collections/:id/send', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    return guard(() => s.collections.send(id, clientIp(req)));
  });

  app.post('/api/collections/:id/dismiss', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    return guard(() => s.collections.dismiss(id));
  });

  // ------------------------------------------------------------ clienți în risc
  app.get('/api/churn', async (req) => {
    requireAuth(req, s);
    return s.churn.latest();
  });

  app.post('/api/churn/analyze', { config: { rateLimit: { max: 4, timeWindow: '1 minute' } } }, async (req) => {
    requireAuth(req, s);
    return guard(() => s.churn.analyze('manual'));
  });

  // ------------------------------------------------------------ backup
  app.get('/api/backups', async (req) => {
    requireAuth(req, s);
    const o = await s.backups.overview();
    return { ...o, nextRunAt: nextRunOf(s.settings.get(), 'backup') };
  });

  app.post('/api/backups/run', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req) => {
    requireAuth(req, s);
    if (!s.integrations.isConfigured('directadmin')) throw new HttpError(400, 'Conectează DirectAdmin mai întâi.');
    if (!s.integrations.storage()) throw new HttpError(400, 'Alege unde se păstrează copiile (Setări → Integrări → Stocare backup).');
    background(s, 'Backup-ul manual', s.backups.run('manual'));
    return { started: true };
  });

  // ------------------------------------------------------------ actualizări sigure
  app.get('/api/updates', async (req) => {
    requireAuth(req, s);
    const o = await s.updates.overview();
    return { ...o, nextRunAt: nextRunOf(s.settings.get(), 'updates') };
  });

  app.post('/api/updates/run', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req) => {
    requireAuth(req, s);
    if (!s.integrations.isConfigured('wordpress')) throw new HttpError(400, 'Conectează pluginul WordPress DAX mai întâi.');
    background(s, 'Actualizarea manuală', s.updates.run('manual'));
    return { started: true };
  });

  // ------------------------------------------------------------ integritatea fișierelor
  app.get('/api/integrity', async (req) => {
    requireAuth(req, s);
    const m = s.monitoring.getMonitor('wp-integrity');
    return { monitor: m, details: m ? s.monitoring.lastDetails('wp-integrity') : null };
  });

  app.post('/api/integrity/reinstall', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    requireStepUp(req, s);
    const b = parse(z.object({ type: z.enum(['plugin', 'core']), item: z.string().max(200).optional() }), req.body);
    const wp = s.integrations.wordpress();
    if (!wp) throw new HttpError(400, 'Pluginul WordPress DAX nu e conectat.');
    const health = await wp.health();
    if (!connectorSupports(health.connector_version)) throw new HttpError(400, 'Actualizează pluginul DAX Connector (Setări → Integrări → WordPress).');
    const r = await wp.reinstall(b.type, b.item);
    s.audit.log({ actor: 'owner', action: 'wp.reinstall', target: b.type === 'core' ? 'WordPress' : b.item ?? '', result: r.ok ? 'reinstalat' : `eșuat: ${r.message}`, ip: clientIp(req) });
    if (r.ok) background(s, 'Reverificarea integrității', s.monitoring.runNow('wp-integrity'));
    return r;
  });

  // ------------------------------------------------------------ livrarea e-mailurilor
  app.get('/api/email', async (req) => {
    requireAuth(req, s);
    return s.email.overview();
  });

  app.post('/api/email/setup-mailbox', async (req) => {
    requireAuth(req, s);
    const r = await guard(() => s.email.setupMailbox());
    s.monitoring.syncBuiltin();
    s.bus.emit({ type: 'settings_changed' });
    return r;
  });

  app.post('/api/email/setup-client', async (req) => {
    requireAuth(req, s);
    const r = await guard(() => s.email.setupWhmcsClient());
    s.bus.emit({ type: 'settings_changed' });
    return r;
  });

  app.post('/api/email/test', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req) => {
    requireAuth(req, s);
    if (!s.integrations.isConfigured('mailbox') || !s.settings.get().email.whmcsTestClientId) throw new HttpError(400, 'Pregătește mai întâi căsuța și clientul de test.');
    background(s, 'Testul de livrare', s.email.runTest('manual'));
    return { started: true };
  });

  // ------------------------------------------------------------ e-Factura (ANAF)
  app.get('/api/efactura', async (req) => {
    requireAuth(req, s);
    return s.efactura.overview();
  });

  app.post('/api/efactura/authorize', async (req) => {
    requireStepUp(req, s);
    return guard(() => ({ url: s.efactura.authorizeUrl() }));
  });

  // întoarcerea de la ANAF: navigare din alt site, deci fără cookie (SameSite=Strict) — validăm prin „state”
  app.get('/api/integrations/anaf/callback', async (req, reply) => {
    const q = parse(z.object({ code: z.string().max(4000).optional(), state: z.string().max(200).optional(), error: z.string().max(500).optional(), error_description: z.string().max(1000).optional() }), req.query);
    const back = (status: string, message?: string) => reply.redirect(`/setari/integrari?anaf=${status}${message ? `&mesaj=${encodeURIComponent(message.slice(0, 300))}` : ''}`);
    if (q.error || !q.code || !q.state) return back('eroare', q.error_description ?? q.error ?? 'Autorizarea a fost anulată.');
    try {
      await s.efactura.handleCallback(q.code, q.state);
      s.monitoring.syncBuiltin();
      s.bus.emit({ type: 'settings_changed' });
      return back('ok');
    } catch (err) {
      return back('eroare', errorMessage(err));
    }
  });

  app.post('/api/efactura/check', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    requireAuth(req, s);
    return guard(() => s.efactura.check());
  });

  app.post('/api/efactura/disconnect', async (req) => {
    requireStepUp(req, s);
    s.efactura.disconnect();
    s.monitoring.syncBuiltin();
    return { ok: true };
  });

  // ------------------------------------------------------------ SEO
  app.get('/api/seo', async (req) => {
    requireAuth(req, s);
    return { ...s.seo.overview(), nextRunAt: nextRunOf(s.settings.get(), 'seo') };
  });

  app.post('/api/seo/generate', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req) => {
    requireAuth(req, s);
    if (!s.integrations.isConfigured('gsc')) throw new HttpError(400, 'Conectează Google Search Console mai întâi (Setări → Integrări).');
    background(s, 'Raportul SEO', s.seo.generate('manual'));
    return { started: true };
  });

  app.get('/api/seo/sites', async (req) => {
    requireAuth(req, s);
    const gsc = s.integrations.gsc();
    if (!gsc) throw new HttpError(400, 'Lipește mai întâi cheia JSON a contului de serviciu.');
    return { serviceEmail: gsc.serviceEmail, sites: await gsc.sites() };
  });
}
