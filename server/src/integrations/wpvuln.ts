// Verificarea vulnerabilităților cunoscute pentru WordPress, pluginuri și teme,
// prin baza de date publică WPVulnerability (wpvulnerability.net, fără cheie API).

export interface VulnMatch {
  component: string;
  type: 'core' | 'plugin' | 'theme';
  version: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  cve: string | null;
  fixedIn: string | null;
  unfixed: boolean;
  link: string | null;
}

type Operator = { min_version?: string | null; min_operator?: string | null; max_version?: string | null; max_operator?: string | null; unfixed?: string | number };
type Vuln = {
  name?: string;
  operator?: Operator;
  source?: Array<{ id?: string; name?: string; link?: string }>;
  impact?: { cvss?: { score?: string | number; severity?: string } };
};

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

function cmp(version: string, op: string | null | undefined, ref: string | null | undefined): boolean {
  if (!ref || !op) return true;
  const c = compareVersions(version, ref);
  switch (op) {
    case 'lt':
      return c < 0;
    case 'le':
      return c <= 0;
    case 'gt':
      return c > 0;
    case 'ge':
      return c >= 0;
    case 'eq':
      return c === 0;
    default:
      return true;
  }
}

export function isAffected(version: string, op: Operator | undefined): boolean {
  if (!op) return false;
  return cmp(version, op.min_operator, op.min_version) && cmp(version, op.max_operator, op.max_version);
}

function severityFrom(v: Vuln): VulnMatch['severity'] {
  const s = String(v.impact?.cvss?.severity ?? '').toLowerCase();
  if (s.startsWith('c')) return 'critical';
  if (s.startsWith('h')) return 'high';
  if (s.startsWith('m')) return 'medium';
  if (s.startsWith('l')) return 'low';
  const score = Number(v.impact?.cvss?.score);
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  if (score > 0) return 'low';
  return 'medium';
}

const cache = new Map<string, { at: number; data: Vuln[] }>();

async function fetchVulns(kind: 'core' | 'plugin' | 'theme', slugOrVersion: string): Promise<Vuln[]> {
  const key = `${kind}:${slugOrVersion}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 12 * 3_600_000) return hit.data;
  const res = await fetch(`https://www.wpvulnerability.net/${kind}/${encodeURIComponent(slugOrVersion)}/`, {
    headers: { Accept: 'application/json', 'User-Agent': 'DAX/1.0' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`WPVulnerability HTTP ${res.status}`);
  const json = (await res.json()) as { error?: number; data?: { vulnerability?: Vuln[] | null } | null };
  const list = json?.data?.vulnerability ?? [];
  cache.set(key, { at: Date.now(), data: list });
  return list;
}

export async function checkComponent(type: 'core' | 'plugin' | 'theme', slug: string, version: string): Promise<VulnMatch[]> {
  const list = await fetchVulns(type, type === 'core' ? version : slug);
  const out: VulnMatch[] = [];
  for (const v of list) {
    const affected = type === 'core' ? true : isAffected(version, v.operator);
    if (!affected) continue;
    const src = v.source?.[0];
    const fixedIn = v.operator?.max_operator === 'lt' ? (v.operator.max_version ?? null) : null;
    out.push({
      component: slug,
      type,
      version,
      title: v.name ?? src?.name ?? 'Vulnerabilitate',
      severity: severityFrom(v),
      cve: v.source?.find((s) => s.id?.startsWith('CVE-'))?.id ?? null,
      fixedIn,
      unfixed: String(v.operator?.unfixed ?? '0') === '1',
      link: src?.link ?? null,
    });
  }
  return out;
}
