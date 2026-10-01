import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../services';
import { parse, requireAuth } from '../http/context';
import { demoState } from './state';

/** Rute disponibile doar în modul demo (scenariul „Simulează o cădere”). */
export function demoRoutes(app: FastifyInstance, s: Services) {
  app.get('/api/demo/state', async (req) => {
    requireAuth(req, s);
    return { wpFault: demoState.wpFault, faultyPlugin: demoState.faultyPlugin, rescued: [...demoState.rescueDisabled] };
  });

  app.post('/api/demo/fault', async (req) => {
    requireAuth(req, s);
    const body = parse(z.object({ on: z.boolean() }), req.body);
    demoState.wpFault = body.on;
    if (body.on) demoState.rescueDisabled.clear();
    s.audit.log({ actor: 'owner', action: body.on ? 'demo.fault_on' : 'demo.fault_off' });
    // verificăm imediat site-ul ca să pornească detectarea
    void s.monitoring.runNow('site-wp').then(() => s.monitoring.runNow('site-wp')).catch(() => undefined);
    return { wpFault: demoState.wpFault };
  });
}
