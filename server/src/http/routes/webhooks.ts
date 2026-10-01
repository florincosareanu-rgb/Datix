import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Services } from '../../services';
import { verifySignature } from '../../crypto/hmac';
import { HttpError, clientIp } from '../context';
import { DAY } from '../../util/time';
import { errorMessage, truncate } from '../../util/text';

// Webhook-uri semnate HMAC de la hook-ul WHMCS și de la pluginul WordPress.
// Protecții: semnătură, fereastră de timp ±5 min, nonce unic (anti-reluare), limită de rată.

function verify(req: FastifyRequest, s: Services, secret: string | null, path: string): void {
  if (!secret) throw new HttpError(503, 'Webhook-ul nu e configurat.');
  const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
  const h = req.headers;
  const result = verifySignature(
    secret,
    { timestamp: String(h['x-datix-timestamp'] ?? ''), nonce: String(h['x-datix-nonce'] ?? ''), signature: String(h['x-datix-signature'] ?? '') },
    'POST',
    path,
    raw,
  );
  if (!result.ok) {
    s.audit.log({ actor: 'system', action: 'webhook.rejected', target: path, details: result.reason, ip: clientIp(req) });
    throw new HttpError(401, 'Semnătură invalidă.');
  }
  const inserted = s.db.prepare('INSERT OR IGNORE INTO webhook_nonces (nonce, at) VALUES (?, ?)').run(result.nonce, Date.now());
  if (!inserted.changes) throw new HttpError(409, 'Cerere repetată.');
}

const envelope = z.object({ event: z.string().min(1).max(60), data: z.record(z.string(), z.unknown()).default({}), sent_at: z.number().optional() });

function remember(s: Services, source: string, event: string, data: unknown): void {
  s.db.prepare('INSERT INTO events_inbox (source, event, at, data) VALUES (?, ?, ?, ?)').run(source, event, Date.now(), truncate(JSON.stringify(data), 8000));
}

export function webhookRoutes(app: FastifyInstance, s: Services) {
  const limits = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  app.post('/api/webhooks/whmcs', limits, async (req) => {
    verify(req, s, s.secrets.get('whmcs.webhookSecret'), '/api/webhooks/whmcs');
    const body = envelope.parse(req.body);
    const d = body.data;
    remember(s, 'whmcs', body.event, d);
    switch (body.event) {
      case 'ticket.open':
      case 'ticket.reply': {
        const ticketId = Number(d.ticketid);
        if (ticketId > 0) void s.tickets.onWebhook(ticketId, body.event).catch((err) => s.log.warn({ err: errorMessage(err) }, 'Tichet din webhook eșuat'));
        break;
      }
      case 'admin.login': {
        const ip = String(d.ip ?? '');
        const username = String(d.username ?? '?');
        const seen = s.db
          .prepare("SELECT 1 FROM events_inbox WHERE source = 'whmcs' AND event = 'admin.login' AND at < ? AND at > ? AND json_extract(data, '$.ip') = ? LIMIT 1")
          .get(Date.now() - 1000, Date.now() - 90 * DAY, ip);
        if (ip && !seen) {
          s.findings.report(
            'whmcs',
            [
              {
                key: `event:admin_new_ip:${username}:${ip}`,
                severity: 'medium',
                title: `Autentificare admin WHMCS (${username}) de pe un IP nou: ${ip}`,
                details: `Browser: ${truncate(String(d.user_agent ?? '?'), 160)}`,
                recommendation: 'Dacă nu ai fost tu, schimbă imediat parola, activează 2FA și verifică jurnalul de activitate.',
              },
            ],
            { notifyFrom: 'medium' },
          );
        }
        break;
      }
      case 'order.created':
        void s.notifier.notify({ kind: 'system', title: '🛒 Comandă nouă în WHMCS', body: `Comanda #${String(d.orderid ?? '?')}${d.amount ? ` — ${String(d.amount)}` : ''}`, priority: 'low', url: '/business' });
        break;
      case 'cancellation.request':
        void s.notifier.notify({ kind: 'ticket', title: '⚠️ Cerere de anulare', body: `Clientul #${String(d.userid ?? '?')} a cerut anularea unui serviciu${d.reason ? `: ${truncate(String(d.reason), 120)}` : ''}.`, priority: 'high', url: '/business' });
        break;
      default:
        break; // cron.heartbeat, invoice.paid, client.add — doar înregistrate
    }
    return { ok: true };
  });

  app.post('/api/webhooks/wordpress', limits, async (req) => {
    verify(req, s, s.secrets.get('wordpress.secret'), '/api/webhooks/wordpress');
    const body = envelope.parse(req.body);
    const d = body.data;
    remember(s, 'wordpress', body.event, d);
    const critical: Record<string, { title: string; severity: 'critical' | 'high' | 'medium' }> = {
      admin_created: { title: `Administrator WordPress nou creat: ${String(d.user ?? '?')}`, severity: 'critical' },
      role_changed: { title: `Utilizatorul ${String(d.user ?? '?')} a primit rolul ${String(d.role ?? '?')}`, severity: 'critical' },
      login_failed_burst: { title: `${String(d.count ?? 'Multe')} autentificări eșuate pe WordPress în ultimele minute`, severity: 'high' },
      plugin_installed: { title: `Plugin nou instalat pe WordPress: ${String(d.plugin ?? '?')}`, severity: 'medium' },
      theme_switched: { title: `Tema WordPress a fost schimbată: ${String(d.theme ?? '?')}`, severity: 'medium' },
      file_changed: { title: `Fișier nucleu WordPress modificat: ${String(d.file ?? '?')}`, severity: 'high' },
    };
    const c = critical[body.event];
    if (c) {
      s.findings.report(
        'wp',
        [
          {
            key: `event:${body.event}:${Date.now()}`,
            severity: c.severity,
            title: c.title,
            details: truncate(JSON.stringify(d), 800),
            recommendation: 'Dacă nu ai făcut tu această acțiune, cere agentului un audit de securitate imediat.',
          },
        ],
        { notifyFrom: 'medium' },
      );
    }
    return { ok: true };
  });
}
