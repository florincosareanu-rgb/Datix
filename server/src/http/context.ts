import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SessionRow } from '../auth/service';
import { SESSION_COOKIE } from '../auth/service';
import type { Services } from '../services';

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionRow | null;
  }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string | null = null,
  ) {
    super(message);
  }
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'cerere'}: ${i.message}`).join('; '), 'validation');
  }
  return r.data;
}

export function clientIp(req: FastifyRequest): string | null {
  return req.ip ?? null;
}

export function requireSession(req: FastifyRequest): SessionRow {
  if (!req.session) throw new HttpError(401, 'Trebuie să te autentifici.', 'unauthenticated');
  return req.session;
}

/** Sesiune completă (nu doar sesiunea temporară de configurare). */
export function requireAuth(req: FastifyRequest, s: Services): SessionRow {
  const session = requireSession(req);
  if (session.auth_method === 'setup' && s.auth.isSetupRequired()) throw new HttpError(403, 'Finalizează mai întâi configurarea.', 'setup_incomplete');
  return session;
}

/** Acțiunile sensibile cer confirmare recentă cu Face ID sau cod 2FA. */
export function requireStepUp(req: FastifyRequest, s: Services): SessionRow {
  const session = requireAuth(req, s);
  if (!s.auth.hasStepUp(session)) throw new HttpError(403, 'Confirmă cu Face ID sau cu codul 2FA.', 'step_up_required');
  return session;
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
    maxAge: 30 * 24 * 3600,
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure, sameSite: 'strict' });
}
