import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IntegrationKey, SettingsResponseDTO } from '@datix/shared';
import type { Services } from '../../services';
import { HttpError, parse, requireAuth, requireStepUp, clientIp } from '../context';
import { GENERATED_SECRETS, isSecretKey } from '../../settings/secrets';
import { SettingsValidationError } from '../../settings/service';

export function settingsResponse(s: Services): SettingsResponseDTO {
  return {
    settings: s.settings.get(),
    secrets: s.secrets.status(),
    integrations: s.integrations.statuses(),
    demoMode: s.config.demoMode,
    version: s.config.version,
    vapidPublicKey: s.notifier.vapidPublicKey(),
  };
}

export function settingsRoutes(app: FastifyInstance, s: Services) {
  app.get('/api/settings', async (req) => {
    requireAuth(req, s);
    return settingsResponse(s);
  });

  app.patch('/api/settings', async (req) => {
    const session = requireAuth(req, s);
    const patch = (req.body ?? {}) as Record<string, unknown>;
    // schimbarea autonomiei sau a modelului AI e sensibilă: cere confirmare
    if (('autonomy' in patch || 'llm' in patch) && !s.auth.hasStepUp(session)) {
      throw new HttpError(403, 'Confirmă cu Face ID sau cu codul 2FA pentru a schimba aceste setări.', 'step_up_required');
    }
    try {
      s.settings.update(patch);
    } catch (err) {
      if (err instanceof SettingsValidationError) throw new HttpError(400, err.message, 'validation');
      throw err;
    }
    s.monitoring.syncBuiltin();
    s.audit.log({ actor: 'owner', action: 'settings.updated', details: Object.keys(patch).join(', '), ip: clientIp(req) });
    s.bus.emit({ type: 'settings_changed' });
    return settingsResponse(s);
  });

  app.put('/api/settings/secrets/:key', async (req) => {
    requireStepUp(req, s);
    const { key } = req.params as { key: string };
    if (!isSecretKey(key) || key === 'push.vapidPrivateKey') throw new HttpError(404, 'Cheie necunoscută.');
    const body = parse(z.object({ value: z.string().min(1).max(4000) }), req.body);
    s.secrets.set(key, body.value);
    s.monitoring.syncBuiltin();
    s.audit.log({ actor: 'owner', action: 'secret.updated', target: key, ip: clientIp(req) });
    s.bus.emit({ type: 'settings_changed' });
    return settingsResponse(s);
  });

  app.delete('/api/settings/secrets/:key', async (req) => {
    requireStepUp(req, s);
    const { key } = req.params as { key: string };
    if (!isSecretKey(key) || key === 'push.vapidPrivateKey') throw new HttpError(404, 'Cheie necunoscută.');
    s.secrets.delete(key);
    s.monitoring.syncBuiltin();
    s.audit.log({ actor: 'owner', action: 'secret.deleted', target: key, ip: clientIp(req) });
    return settingsResponse(s);
  });

  /** Secretele generate de aplicație (pentru WordPress / WHMCS) pot fi afișate, cu confirmare. */
  app.post('/api/settings/secrets/:key/reveal', async (req) => {
    requireStepUp(req, s);
    const { key } = req.params as { key: string };
    if (!isSecretKey(key) || !GENERATED_SECRETS.includes(key)) throw new HttpError(403, 'Acest secret nu poate fi afișat.');
    s.audit.log({ actor: 'owner', action: 'secret.revealed', target: key, ip: clientIp(req) });
    return { value: s.secrets.ensureGenerated(key) };
  });

  app.post('/api/settings/secrets/:key/regenerate', async (req) => {
    requireStepUp(req, s);
    const { key } = req.params as { key: string };
    if (!isSecretKey(key) || !GENERATED_SECRETS.includes(key)) throw new HttpError(403, 'Acest secret nu poate fi regenerat.');
    s.audit.log({ actor: 'owner', action: 'secret.regenerated', target: key, ip: clientIp(req) });
    return { value: s.secrets.regenerate(key) };
  });

  app.post('/api/integrations/:key/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    requireAuth(req, s);
    const { key } = req.params as { key: string };
    const keys: IntegrationKey[] = ['llm', 'whmcs', 'directadmin', 'reseller', 'cloudflare', 'wordpress', 'pagespeed'];
    if (!keys.includes(key as IntegrationKey)) throw new HttpError(404, 'Integrare necunoscută.');
    const r = await s.integrations.test(key as IntegrationKey);
    if (r.ok) s.monitoring.syncBuiltin();
    return r;
  });

  /** Informații de instalare pentru pluginul WordPress și hook-ul WHMCS. */
  app.get('/api/settings/install-info', async (req) => {
    requireAuth(req, s);
    return {
      appUrl: s.config.appUrl,
      whmcsWebhookUrl: `${s.config.appUrl}/api/webhooks/whmcs`,
      wordpressWebhookUrl: `${s.config.appUrl}/api/webhooks/wordpress`,
      serverIpHint: 'IP-ul public al serverului pe care rulează agentul (pentru restricțiile de IP din WHMCS / DirectAdmin / Cloudflare).',
    };
  });
}
