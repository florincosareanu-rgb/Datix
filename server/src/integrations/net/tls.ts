import tls from 'node:tls';
import net from 'node:net';
import { tlsInfoFromSocket, type TlsInfo } from './httpCheck';

export interface TlsCheckResult {
  host: string;
  connectedTo: string | null;
  ok: boolean;
  info: TlsInfo | null;
  error: string | null;
  verdict: 'up' | 'degraded' | 'down';
  message: string;
}

/**
 * Verifică certificatul SSL al unui domeniu. Cu `ip`, se conectează direct la serverul de hosting
 * (util când domeniul e în spatele Cloudflare și vrem certificatul de pe origine).
 */
export function checkTls(host: string, opts: { ip?: string; port?: number; timeoutMs?: number; warnDays?: number } = {}): Promise<TlsCheckResult> {
  const warnDays = opts.warnDays ?? 14;
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: TlsCheckResult) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const socket = tls.connect({
      host: opts.ip ?? host,
      port: opts.port ?? 443,
      servername: net.isIP(host) ? undefined : host,
      rejectUnauthorized: false,
      timeout: opts.timeoutMs ?? 15_000,
    });
    socket.once('secureConnect', () => {
      const info = tlsInfoFromSocket(socket);
      socket.end();
      let verdict: TlsCheckResult['verdict'] = 'up';
      let message = `Certificat valid încă ${info.daysLeft} zile (emis de ${info.issuer ?? 'necunoscut'}).`;
      if (!info.authorized) {
        verdict = 'down';
        message = `Certificat SSL invalid: ${info.authorizationError ?? 'motiv necunoscut'}.`;
      } else if (info.daysLeft !== null && info.daysLeft < 0) {
        verdict = 'down';
        message = 'Certificatul SSL a expirat.';
      } else if (info.daysLeft !== null && info.daysLeft <= warnDays) {
        verdict = 'degraded';
        message = `Certificatul SSL expiră în ${info.daysLeft} zile.`;
      }
      finish({ host, connectedTo: socket.remoteAddress ?? null, ok: verdict === 'up', info, error: null, verdict, message });
    });
    socket.once('timeout', () => {
      socket.destroy();
      finish({ host, connectedTo: null, ok: false, info: null, error: 'timeout', verdict: 'down', message: 'Conexiunea SSL nu a răspuns în timp util.' });
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      finish({ host, connectedTo: null, ok: false, info: null, error: err.code ?? err.message, verdict: 'down', message: `Conexiune SSL eșuată: ${err.message}` });
    });
  });
}
