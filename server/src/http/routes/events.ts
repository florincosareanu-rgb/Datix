import type { FastifyInstance } from 'fastify';
import type { ServerEvent } from '@datix/shared';
import type { Services } from '../../services';
import { requireAuth } from '../context';

/** Flux SSE cu evenimente live (monitoare, incidente, tichete, chat). */
export function eventRoutes(app: FastifyInstance, s: Services) {
  app.get('/api/events', async (req, reply) => {
    requireAuth(req, s);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const send = (event: ServerEvent) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* conexiune închisă */
      }
    };
    send({ type: 'ping', at: Date.now() });
    const unsubscribe = s.bus.subscribe(send);
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        /* ignorat */
      }
    }, 20_000);
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on('close', close);
    res.on('error', close);
  });
}
