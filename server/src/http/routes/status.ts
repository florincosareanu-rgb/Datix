import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StatusOverviewDTO } from '@datix/shared';
import type { Services } from '../../services';
import { HttpError, parse, requireAuth } from '../context';
import { HOUR } from '../../util/time';

export function statusOverview(s: Services): StatusOverviewDTO {
  const monitors = s.monitoring.listMonitors();
  const sites = monitors.filter((m) => m.kind === 'http' && m.enabled);
  const overall: StatusOverviewDTO['overall'] = !sites.length
    ? 'unknown'
    : sites.some((m) => m.status === 'down')
      ? 'down'
      : sites.some((m) => m.status === 'degraded') || monitors.some((m) => m.status === 'down')
        ? 'degraded'
        : sites.every((m) => m.status === 'unknown')
          ? 'unknown'
          : 'ok';
  const summary = s.tickets.attentionSummary();
  return {
    monitors,
    openIncidents: s.incidents.list({ status: 'active', limit: 20 }),
    recentIncidents: s.incidents.list({ status: 'all', limit: 10 }),
    findingsBySeverity: s.findings.countsBySeverity(),
    pendingApprovals: s.approvals.pendingCount(),
    ticketsNeedingAttention: (summary.counts.draft_ready ?? 0) + (summary.counts.escalated ?? 0) + (summary.counts.error ?? 0),
    usage: s.llm.usageSummary(),
    integrations: s.integrations.statuses(),
    overall,
  };
}

export function statusRoutes(app: FastifyInstance, s: Services) {
  app.get('/api/status', async (req) => {
    requireAuth(req, s);
    return statusOverview(s);
  });

  app.get('/api/monitors', async (req) => {
    requireAuth(req, s);
    return s.monitoring.listMonitors();
  });

  app.get('/api/monitors/:id', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    const q = parse(z.object({ hours: z.coerce.number().int().min(1).max(24 * 90).default(24) }), req.query);
    const monitor = s.monitoring.getMonitor(id);
    if (!monitor) throw new HttpError(404, 'Monitorul nu există.');
    return { monitor, history: s.monitoring.history(id, Date.now() - q.hours * HOUR, 2000), lastDetails: s.monitoring.lastDetails(id) };
  });

  app.post('/api/monitors/:id/run', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    return s.monitoring.runNow(id);
  });

  app.patch('/api/monitors/:id', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    const body = parse(z.object({ enabled: z.boolean() }), req.body);
    const m = s.monitoring.setEnabled(id, body.enabled);
    if (!m) throw new HttpError(404, 'Monitorul nu există.');
    s.audit.log({ actor: 'owner', action: body.enabled ? 'monitor.enabled' : 'monitor.paused', target: m.name });
    return m;
  });

  // ------------------------------------------------------------ incidente
  app.get('/api/incidents', async (req) => {
    requireAuth(req, s);
    const q = parse(z.object({ status: z.enum(['active', 'all']).default('all') }), req.query);
    return s.incidents.list({ status: q.status, limit: 200 });
  });

  app.get('/api/incidents/:id', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    const incident = s.incidents.get(id);
    if (!incident) throw new HttpError(404, 'Incidentul nu există.');
    return { incident, events: s.incidents.events(id) };
  });

  app.post('/api/incidents/:id/investigate', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    if (!s.incidents.get(id)) throw new HttpError(404, 'Incidentul nu există.');
    if (!s.llm.isAvailable()) throw new HttpError(400, 'Agentul AI nu e configurat.');
    void s.incidents.investigate(id);
    return { started: true };
  });

  app.post('/api/incidents/:id/resolve', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    const body = parse(z.object({ note: z.string().max(500).default('Marcat rezolvat manual.') }), req.body);
    if (!s.incidents.get(id)) throw new HttpError(404, 'Incidentul nu există.');
    s.incidents.resolve(id, body.note);
    return s.incidents.get(id);
  });

  // ------------------------------------------------------------ securitate
  app.get('/api/findings', async (req) => {
    requireAuth(req, s);
    const q = parse(z.object({ status: z.enum(['open', 'resolved', 'ignored']).optional() }), req.query);
    return s.findings.list({ status: q.status });
  });

  app.patch('/api/findings/:id', async (req) => {
    requireAuth(req, s);
    const { id } = req.params as { id: string };
    const body = parse(z.object({ status: z.enum(['open', 'resolved', 'ignored']) }), req.body);
    const f = s.findings.setStatus(id, body.status);
    if (!f) throw new HttpError(404, 'Constatarea nu există.');
    s.audit.log({ actor: 'owner', action: `finding.${body.status}`, target: f.title });
    return f;
  });

  app.post('/api/security/scan', { config: { rateLimit: { max: 3, timeWindow: '10 minutes' } } }, async (req) => {
    requireAuth(req, s);
    const ids = s.monitoring
      .listMonitors()
      .filter((m) => ['security_scan', 'wp_health', 'wp_vulns', 'whmcs_health', 'blacklist', 'tls', 'dns'].includes(m.kind))
      .map((m) => m.id);
    void Promise.allSettled(ids.map((id) => s.monitoring.runNow(id)));
    return { started: ids.length };
  });
}
