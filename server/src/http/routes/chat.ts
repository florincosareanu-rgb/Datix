import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../../services';
import { HttpError, clientIp, parse, requireAuth } from '../context';
import { toolLabel } from '../../agent/tools';
import { BusyError } from '../../agent/runner';
import { ApprovalError } from '../../agent/approvals';

export function chatRoutes(app: FastifyInstance, s: Services) {
  const messagesFor = (id: string) =>
    s.conversations.toDTO(id, toolLabel, (callId) => {
      const a = s.approvals.forToolCall(callId);
      return a ? { id: a.id, status: a.status } : null;
    });

  app.get('/api/conversations', async (req) => {
    requireAuth(req, s);
    const q = parse(z.object({ kind: z.enum(['chat', 'incident', 'ticket', 'report']).optional(), q: z.string().max(100).optional() }), req.query);
    return s.conversations.list({ kind: q.kind, search: q.q });
  });

  app.post('/api/conversations', async (req) => {
    requireAuth(req, s);
    const body = parse(z.object({ title: z.string().max(120).optional() }), req.body);
    const id = s.conversations.create('chat', body.title || 'Conversație nouă');
    return s.conversations.get(id);
  });

  app.get('/api/conversations/:id', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    const conversation = s.conversations.get(id);
    if (!conversation) throw new HttpError(404, 'Conversația nu există.');
    const run = s.agent.lastRunFor(id);
    return {
      conversation,
      messages: messagesFor(id),
      running: s.agent.isRunning(id),
      lastRun: run ? { id: run.id, status: run.status, error: run.error, costUsd: run.cost_usd } : null,
      pendingApprovals: s.approvals.pendingForConversation(id),
    };
  });

  app.patch('/api/conversations/:id', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    const body = parse(z.object({ title: z.string().min(1).max(120).optional(), pinned: z.boolean().optional() }), req.body);
    if (!s.conversations.get(id)) throw new HttpError(404, 'Conversația nu există.');
    if (body.title) s.conversations.rename(id, body.title);
    if (body.pinned !== undefined) s.conversations.setPinned(id, body.pinned);
    return s.conversations.get(id);
  });

  app.delete('/api/conversations/:id', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    s.agent.cancel(id);
    s.conversations.archive(id);
    return { ok: true };
  });

  app.post('/api/conversations/:id/messages', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    const body = parse(z.object({ text: z.string().min(1).max(20_000) }), req.body);
    const conv = s.conversations.get(id);
    if (!conv) throw new HttpError(404, 'Conversația nu există.');
    if (!s.llm.isAvailable()) throw new HttpError(400, 'Agentul AI nu e configurat: adaugă cheia DeepSeek în Setări → AI.', 'llm_missing');
    try {
      return s.agent.startOwnerMessage(id, body.text);
    } catch (err) {
      if (err instanceof BusyError) throw new HttpError(409, err.message, 'busy');
      throw err;
    }
  });

  app.post('/api/conversations/:id/cancel', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    return { cancelled: s.agent.cancel(id) };
  });

  // ------------------------------------------------------------ aprobări
  app.get('/api/approvals', async (req) => {
    requireAuth(req, s);
    const q = parse(z.object({ status: z.enum(['pending', 'approved', 'rejected', 'expired', 'executed', 'failed']).optional() }), req.query);
    return s.approvals.list({ status: q.status, limit: 100 });
  });

  app.get('/api/approvals/:id', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    const a = s.approvals.get(id);
    if (!a) throw new HttpError(404, 'Aprobarea nu există.');
    return a;
  });

  app.post('/api/approvals/:id/decide', async (req) => {
    const session = requireAuth(req, s);
    const { id } = req.params as { id: string };
    const body = parse(z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(500).optional() }), req.body);
    try {
      return await s.approvals.decide(id, body.decision, { stepUpValid: s.auth.hasStepUp(session), ip: clientIp(req), note: body.note });
    } catch (err) {
      if (err instanceof ApprovalError) throw new HttpError(err.status, err.message, err.code);
      throw err;
    }
  });
}
