import net from 'node:net';

export interface DomainExpiryResult {
  domain: string;
  expiresAt: string | null;
  daysLeft: number | null;
  registrar: string | null;
  source: 'rdap' | 'whois' | null;
  error: string | null;
}

const WHOIS_SERVERS: Record<string, string> = {
  ro: 'whois.rotld.ro',
  eu: 'whois.eu',
  md: 'whois.nic.md',
};

let rdapBootstrap: { at: number; services: Array<[string[], string[]]> } | null = null;

async function rdapBaseFor(tld: string): Promise<string | null> {
  if (!rdapBootstrap || Date.now() - rdapBootstrap.at > 7 * 86_400_000) {
    const res = await fetch('https://data.iana.org/rdap/dns.json', { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`IANA RDAP bootstrap HTTP ${res.status}`);
    const data = (await res.json()) as { services: Array<[string[], string[]]> };
    rdapBootstrap = { at: Date.now(), services: data.services };
  }
  for (const [tlds, urls] of rdapBootstrap.services) {
    if (tlds.includes(tld)) return urls[0] ?? null;
  }
  return null;
}

function whoisQuery(server: string, query: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: server, port: 43 });
    let data = '';
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => socket.write(`${query}\r\n`));
    socket.on('data', (c) => (data += c.toString('utf8')));
    socket.on('end', () => resolve(data));
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('WHOIS timeout'));
    });
    socket.on('error', reject);
  });
}

export function parseWhoisExpiry(text: string): { expiresAt: string | null; registrar: string | null } {
  const expiryPatterns = [
    /Expires On:\s*(.+)/i,
    /Registry Expiry Date:\s*(.+)/i,
    /Expiration Date:\s*(.+)/i,
    /Expiry Date:\s*(.+)/i,
    /paid-till:\s*(.+)/i,
    /expires:\s*(.+)/i,
  ];
  let expiresAt: string | null = null;
  for (const re of expiryPatterns) {
    const m = re.exec(text);
    if (m?.[1]) {
      const d = new Date(m[1].trim());
      if (!Number.isNaN(d.getTime())) {
        expiresAt = d.toISOString();
        break;
      }
    }
  }
  const reg = /Registrar:\s*(.+)/i.exec(text)?.[1]?.trim() ?? null;
  return { expiresAt, registrar: reg };
}

export async function domainExpiry(domain: string): Promise<DomainExpiryResult> {
  const clean = domain.toLowerCase().replace(/\.$/, '');
  const tld = clean.split('.').pop() ?? '';
  const result: DomainExpiryResult = { domain: clean, expiresAt: null, daysLeft: null, registrar: null, source: null, error: null };
  try {
    const base = await rdapBaseFor(tld);
    if (base) {
      const res = await fetch(`${base.replace(/\/$/, '')}/domain/${clean}`, {
        headers: { Accept: 'application/rdap+json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          events?: Array<{ eventAction: string; eventDate: string }>;
          entities?: Array<{ roles?: string[]; vcardArray?: [string, Array<[string, unknown, string, string]>] }>;
        };
        const exp = data.events?.find((e) => e.eventAction === 'expiration')?.eventDate;
        if (exp) {
          result.expiresAt = new Date(exp).toISOString();
          result.source = 'rdap';
          const registrar = data.entities?.find((e) => e.roles?.includes('registrar'));
          const fn = registrar?.vcardArray?.[1]?.find((v) => v[0] === 'fn');
          result.registrar = fn ? String(fn[3]) : null;
        }
      }
    }
  } catch (err) {
    result.error = (err as Error).message;
  }
  if (!result.expiresAt) {
    const server = WHOIS_SERVERS[tld];
    if (server) {
      try {
        const text = await whoisQuery(server, clean);
        const parsed = parseWhoisExpiry(text);
        if (parsed.expiresAt) {
          result.expiresAt = parsed.expiresAt;
          result.registrar = parsed.registrar;
          result.source = 'whois';
          result.error = null;
        } else if (!result.error) {
          result.error = 'Data expirării nu apare în WHOIS';
        }
      } catch (err) {
        result.error = (err as Error).message;
      }
    } else if (!result.error) {
      result.error = `Nu știu cum să verific expirarea pentru .${tld}`;
    }
  }
  if (result.expiresAt) result.daysLeft = Math.floor((new Date(result.expiresAt).getTime() - Date.now()) / 86_400_000);
  return result;
}
