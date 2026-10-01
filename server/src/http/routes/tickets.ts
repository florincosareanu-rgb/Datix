import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../../services';
import { HttpError, parse, requireAuth } from '../context';
import { errorMessage } from '../../util/text';

export function ticketRoutes(app: FastifyInstance, s: Services) {
  app.get('/api/tickets', async (req) => {
    requireAuth(req, s);
    const q = parse(
      z.object({ status: z.enum(['attention', 'queued', 'analyzing', 'draft_ready', 'sent', 'escalated', 'skipped', 'discarded', 'error']).optional() }),
      req.query,
    );
    return s.tickets.list({ status: q.status, limit: 200 });
  });

  app.get('/api/tickets/summary', async (req) => {
    requireAuth(req, s);
    return s.tickets.attentionSummary();
  });

  app.patch('/api/tickets/mode', async (req) => {
    requireAuth(req, s);
    const body = parse(
      z.object({
        mode: z.enum(['off', 'draft', 'auto']),
        autoOnlyInSchedule: z.boolean().optional(),
      }),
      req.body,
    );
    const updated = s.settings.update({ tickets: { mode: body.mode, ...(body.autoOnlyInSchedule !== undefined ? { autoOnlyInSchedule: body.autoOnlyInSchedule } : {}) } });
    s.audit.log({ actor: 'owner', action: 'tickets.mode_changed', target: body.mode, details: { autoOnlyInSchedule: updated.tickets.autoOnlyInSchedule } });
    s.bus.emit({ type: 'settings_changed' });
    return s.tickets.attentionSummary();
  });

  app.post('/api/tickets/poll', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    requireAuth(req, s);
    if (!s.integrations.whmcs()) throw new HttpError(400, 'WHMCS nu e conectat.');
    return s.tickets.poll();
  });

  app.post('/api/tickets/analyze', async (req) => {
    requireAuth(req, s);
    const body = parse(z.object({ ticketId: z.number().int().positive() }), req.body);
    if (!s.integrations.whmcs()) throw new HttpError(400, 'WHMCS nu e conectat.');
    void s.tickets.analyzeNow(body.ticketId).catch((err) => s.log.warn({ err: errorMessage(err) }, 'Analiza tichetului a eșuat'));
    return { started: true };
  });

  app.get('/api/tickets/:id', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    const d = await s.tickets.detail(id);
    if (!d) throw new HttpError(404, 'Sarcina nu există.');
    return d;
  });

  app.post('/api/tickets/:id/send', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    const body = parse(z.object({ text: z.string().min(5).max(20_000) }), req.body);
    try {
      return await s.tickets.sendDraft(id, body.text);
    } catch (err) {
      throw new HttpError(400, errorMessage(err));
    }
  });

  app.post('/api/tickets/:id/discard', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    const j = s.tickets.discard(id);
    if (!j) throw new HttpError(404, 'Sarcina nu există.');
    return j;
  });

  app.post('/api/tickets/:id/regenerate', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    const body = parse(z.object({ guidance: z.string().max(2000).default('') }), req.body);
    void s.tickets.regenerate(id, body.guidance).catch((err) => s.log.warn({ err: errorMessage(err) }, 'Regenerarea a eșuat'));
    return { started: true };
  });
}
