import { Resolver } from 'node:dns/promises';

export type DnsRecordType = 'A' | 'AAAA' | 'MX' | 'NS' | 'TXT' | 'CAA' | 'CNAME';

export interface DnsSnapshot {
  domain: string;
  at: number;
  records: Partial<Record<DnsRecordType, string[]>>;
  errors: Partial<Record<DnsRecordType, string>>;
}

function makeResolver(servers?: string[]): Resolver {
  const r = new Resolver({ timeout: 4000, tries: 2 });
  if (servers?.length) r.setServers(servers);
  return r;
}

async function resolveType(resolver: Resolver, domain: string, type: DnsRecordType): Promise<string[]> {
  switch (type) {
    case 'A':
      return (await resolver.resolve4(domain)).sort();
    case 'AAAA':
      return (await resolver.resolve6(domain)).sort();
    case 'MX':
      return (await resolver.resolveMx(domain)).map((m) => `${m.priority} ${m.exchange.toLowerCase()}`).sort();
    case 'NS':
      return (await resolver.resolveNs(domain)).map((n) => n.toLowerCase()).sort();
    case 'TXT':
      return (await resolver.resolveTxt(domain)).map((chunks) => chunks.join('')).sort();
    case 'CAA':
      return (await resolver.resolveCaa(domain)).map((c) => `${c.critical} ${Object.keys(c).filter((k) => k !== 'critical').map((k) => `${k} ${(c as unknown as Record<string, string>)[k]}`).join(' ')}`).sort();
    case 'CNAME':
      return (await resolver.resolveCname(domain)).map((c) => c.toLowerCase()).sort();
  }
}

const NO_DATA = new Set(['ENODATA', 'ENOTFOUND']);

export async function dnsSnapshot(domain: string, types: DnsRecordType[] = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CAA'], servers?: string[]): Promise<DnsSnapshot> {
  const resolver = makeResolver(servers);
  const snap: DnsSnapshot = { domain, at: Date.now(), records: {}, errors: {} };
  await Promise.all(
    types.map(async (t) => {
      try {
        snap.records[t] = await resolveType(resolver, domain, t);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? 'ERROR';
        if (NO_DATA.has(code)) snap.records[t] = [];
        else snap.errors[t] = code;
      }
    }),
  );
  return snap;
}

export interface DnsDiff {
  type: DnsRecordType;
  added: string[];
  removed: string[];
}

/** Compară două instantanee DNS; ignoră tipurile care au dat eroare într-unul dintre ele. */
export function diffDns(prev: DnsSnapshot, next: DnsSnapshot): DnsDiff[] {
  const out: DnsDiff[] = [];
  const types = new Set([...Object.keys(prev.records), ...Object.keys(next.records)] as DnsRecordType[]);
  for (const t of types) {
    if (prev.errors[t] || next.errors[t]) continue;
    const a = new Set(prev.records[t] ?? []);
    const b = new Set(next.records[t] ?? []);
    const added = [...b].filter((x) => !a.has(x));
    const removed = [...a].filter((x) => !b.has(x));
    if (added.length || removed.length) out.push({ type: t, added, removed });
  }
  return out;
}

/** Verificări de bază pentru securitatea e-mailului (SPF, DMARC). */
export async function emailAuthCheck(domain: string, servers?: string[]) {
  const resolver = makeResolver(servers);
  const txt = async (name: string) => {
    try {
      return (await resolver.resolveTxt(name)).map((c) => c.join(''));
    } catch {
      return [];
    }
  };
  const root = await txt(domain);
  const dmarc = await txt(`_dmarc.${domain}`);
  const spf = root.filter((r) => r.toLowerCase().startsWith('v=spf1'));
  const dmarcRec = dmarc.find((r) => r.toLowerCase().startsWith('v=dmarc1')) ?? null;
  const policy = dmarcRec ? (/;\s*p=([a-z]+)/i.exec(dmarcRec)?.[1]?.toLowerCase() ?? null) : null;
  return {
    spf: spf[0] ?? null,
    spfCount: spf.length,
    spfAll: spf[0] ? (/([~?+-])all\b/i.exec(spf[0])?.[1] ?? null) : null,
    dmarc: dmarcRec,
    dmarcPolicy: policy,
  };
}

export async function resolveFirstIp(host: string, servers?: string[]): Promise<string | null> {
  try {
    const r = makeResolver(servers);
    const ips = await r.resolve4(host);
    return ips[0] ?? null;
  } catch {
    return null;
  }
}
