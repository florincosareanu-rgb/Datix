import { ToolFailure, type ToolContext } from './types';
import type { CloudflareApi, DirectAdminApi, WhmcsApi, WordPressApi } from '../../integrations/types';
import type { WpRescue } from '../../integrations/wpRescue';

export function needWhmcs(ctx: ToolContext): WhmcsApi {
  const c = ctx.services.integrations.whmcs();
  if (!c) throw new ToolFailure('Integrarea WHMCS nu e configurată (Setări → Integrări → WHMCS).');
  return c;
}

export function needDa(ctx: ToolContext): DirectAdminApi {
  const c = ctx.services.integrations.directadmin();
  if (!c) throw new ToolFailure('Integrarea DirectAdmin nu e configurată (Setări → Integrări → DirectAdmin).');
  return c;
}

export function needReseller(ctx: ToolContext): DirectAdminApi {
  const c = ctx.services.integrations.reseller();
  if (!c) throw new ToolFailure('Contul de reseller nu e activat încă (Setări → Integrări → Reseller).');
  return c;
}

export function needCf(ctx: ToolContext): CloudflareApi {
  const c = ctx.services.integrations.cloudflare();
  if (!c) throw new ToolFailure('Integrarea Cloudflare nu e configurată (Setări → Integrări → Cloudflare).');
  return c;
}

export function needWp(ctx: ToolContext): WordPressApi {
  const c = ctx.services.integrations.wordpress();
  if (!c) throw new ToolFailure('Pluginul WordPress Datix AI nu e conectat (Setări → Integrări → WordPress).');
  return c;
}

export function needRescue(ctx: ToolContext): WpRescue {
  const r = ctx.services.integrations.wpRescue();
  if (!r) throw new ToolFailure('Trusa de salvare WordPress necesită integrarea DirectAdmin și calea site-ului (Setări → Integrări → DirectAdmin).');
  return r;
}

let originIpCache: { at: number; ip: string | null } | null = null;

/** IP-ul serverului de hosting (originea din spatele Cloudflare). */
export async function originIp(ctx: ToolContext): Promise<string | null> {
  const configured = ctx.services.settings.get().sites.originIp;
  if (configured) return configured;
  if (originIpCache && Date.now() - originIpCache.at < 3_600_000) return originIpCache.ip;
  let ip: string | null = null;
  const da = ctx.services.integrations.directadmin();
  if (da) {
    try {
      ip = (await da.usage()).ip;
    } catch {
      ip = null;
    }
  }
  originIpCache = { at: Date.now(), ip };
  return ip;
}

export function hostOf(urlOrDomain: string): string {
  try {
    return new URL(urlOrDomain.includes('://') ? urlOrDomain : `https://${urlOrDomain}`).hostname;
  } catch {
    return urlOrDomain;
  }
}

/** Verifică că o cale din DirectAdmin e sub directorul contului și nu conține „..”. */
export function safeDaPath(path: string): string {
  const p = path.trim();
  if (!p.startsWith('/')) throw new ToolFailure('Calea trebuie să înceapă cu / (relativă la directorul contului, ex. /domains/datix.ro/public_html).');
  if (p.split('/').includes('..')) throw new ToolFailure('Căile cu „..” nu sunt permise.');
  return p.replace(/\/+$/, '') || '/';
}
