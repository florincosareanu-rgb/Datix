import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { httpCheck } from './httpCheck';
import { stripHtml, truncate } from '../../util/text';

/** Adrese care nu au voie să fie accesate de agent (rețele interne, metadate cloud etc.). */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    return false;
  }
  return true;
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Adresă URL invalidă.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Sunt permise doar adrese http(s).');
  if (url.username || url.password) throw new Error('Adresele cu date de autentificare nu sunt permise.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length) throw new Error('Domeniul nu se rezolvă.');
  for (const a of addresses) {
    if (isPrivateAddress(a.address)) throw new Error('Adresa indică o rețea internă — accesul e blocat din motive de securitate.');
  }
  return url;
}

/** Descarcă o pagină publică și întoarce textul ei (pentru agent). */
export async function fetchPublicPage(raw: string, maxChars = 12_000) {
  const url = await assertPublicUrl(raw);
  const r = await httpCheck({ url: url.toString(), timeoutMs: 20_000, maxBodyBytes: 2_000_000, followRedirects: 5 });
  if (r.finalUrl !== url.toString()) await assertPublicUrl(r.finalUrl);
  const ct = r.headers['content-type'] ?? '';
  const body = /html/i.test(ct) ? stripHtml(r.bodyText) : r.bodyText;
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(r.bodyText)?.[1]?.trim() ?? null;
  return {
    url: r.finalUrl,
    status: r.status,
    contentType: ct,
    title,
    problems: r.problems,
    text: truncate(body, maxChars),
  };
}
