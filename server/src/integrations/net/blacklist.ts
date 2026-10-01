import { Resolver } from 'node:dns/promises';
import net from 'node:net';

// Liste negre (DNSBL) relevante pentru un hosting. Folosim resolverul sistemului:
// Spamhaus refuză interogările venite prin resolverele publice mari (1.1.1.1, 8.8.8.8).
const IP_LISTS = [
  { zone: 'zen.spamhaus.org', name: 'Spamhaus ZEN' },
  { zone: 'bl.spamcop.net', name: 'SpamCop' },
  { zone: 'b.barracudacentral.org', name: 'Barracuda' },
  { zone: 'psbl.surriel.com', name: 'PSBL' },
  { zone: 'dnsbl-1.uceprotect.net', name: 'UCEPROTECT L1' },
  { zone: 'bl.mailspike.net', name: 'Mailspike' },
];

const DOMAIN_LISTS = [
  { zone: 'dbl.spamhaus.org', name: 'Spamhaus DBL' },
  { zone: 'multi.surbl.org', name: 'SURBL' },
];

export interface BlacklistHit {
  list: string;
  zone: string;
  listed: boolean | null;
  code: string | null;
  note: string | null;
}

export interface BlacklistResult {
  target: string;
  kind: 'ip' | 'domain';
  listedOn: string[];
  checks: BlacklistHit[];
}

function reverseIPv4(ip: string): string {
  return ip.split('.').reverse().join('.');
}

async function lookup(resolver: Resolver, name: string): Promise<{ listed: boolean | null; code: string | null; note: string | null }> {
  try {
    const answers = await resolver.resolve4(name);
    const code = answers[0] ?? null;
    // 127.255.255.x = interogare refuzată (resolver public / limită), nu înseamnă listare
    if (code && code.startsWith('127.255.255.')) return { listed: null, code, note: 'Interogare refuzată de listă (resolver public sau limită de cereri).' };
    // SURBL / Spamhaus DBL: 127.0.1.255 etc. pot însemna erori
    if (code && /^127\.0\.1\.25[45]$/.test(code)) return { listed: null, code, note: 'Răspuns de eroare de la listă.' };
    return { listed: true, code, note: null };
  } catch (err) {
    const c = (err as NodeJS.ErrnoException).code;
    if (c === 'ENOTFOUND' || c === 'ENODATA') return { listed: false, code: null, note: null };
    return { listed: null, code: null, note: c ?? 'eroare DNS' };
  }
}

export async function checkBlacklists(target: string): Promise<BlacklistResult> {
  const resolver = new Resolver({ timeout: 5000, tries: 1 });
  const isIp = net.isIPv4(target);
  const lists = isIp ? IP_LISTS : DOMAIN_LISTS;
  const base = isIp ? reverseIPv4(target) : target.toLowerCase();
  const checks = await Promise.all(
    lists.map(async (l) => {
      const r = await lookup(resolver, `${base}.${l.zone}`);
      return { list: l.name, zone: l.zone, ...r };
    }),
  );
  return {
    target,
    kind: isIp ? 'ip' : 'domain',
    listedOn: checks.filter((c) => c.listed === true).map((c) => c.list),
    checks,
  };
}
