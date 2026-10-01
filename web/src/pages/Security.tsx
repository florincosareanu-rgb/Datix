import { useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Bot, CheckCircle2, ChevronDown, EyeOff, RotateCcw, ScanSearch, ShieldCheck } from 'lucide-react';
import { SEVERITY_LABEL, SEVERITY_ORDER, type FindingDTO, type FindingStatus, type Severity } from '@datix/shared';
import { api, errorText } from '../lib/api';
import { useToast } from '../lib/toast';
import { useStatus } from '../layout/Shell';
import { dateTime, timeAgo } from '../lib/format';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorBox, Loading, Page, PageHeader, Segmented } from '../components/ui';
import { SeverityBadge, StatusBadge, severityBar } from '../components/status';

const SOURCE_LABEL: Record<string, string> = {
  scan: 'Scanare externă',
  tls: 'Certificat SSL',
  domain: 'Domeniu',
  dns: 'DNS / e-mail',
  blacklist: 'Liste negre',
  pagespeed: 'Viteză / SEO',
  wp: 'WordPress',
  wpvuln: 'Vulnerabilități WP',
  whmcs: 'WHMCS',
  hosting: 'Hosting',
  cloudflare: 'Cloudflare',
  reseller: 'Reseller',
};

const SECURITY_KINDS = ['security_scan', 'wp_health', 'wp_vulns', 'whmcs_health', 'blacklist', 'tls', 'dns', 'domain', 'cloudflare_security'];

function FindingCard({ f }: { f: FindingDTO }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const [, navigate] = useLocation();
  const setStatus = useMutation({
    mutationFn: (status: FindingStatus) => api.patch<FindingDTO>(`/api/findings/${f.id}`, { status }),
    onSuccess: (_d, status) => {
      toast(status === 'ignored' ? 'Ignorat. Nu vei mai fi notificat pentru asta.' : status === 'resolved' ? 'Marcat ca rezolvat.' : 'Redeschis.', 'good');
      qc.invalidateQueries({ queryKey: ['findings'] });
      qc.invalidateQueries({ queryKey: ['status'] });
    },
    onError: (err) => toast(errorText(err), 'critical'),
  });
  const askAgent = () => {
    const q = `Am o problemă de securitate: „${f.title}” (${SEVERITY_LABEL[f.severity]}, sursa: ${SOURCE_LABEL[f.source] ?? f.source}).${f.details ? `\nDetalii: ${f.details}` : ''}\nVerifică și spune-mi ce propui; repară ce se poate repara în siguranță.`;
    navigate(`/?q=${encodeURIComponent(q)}`);
  };
  return (
    <div className="flex gap-3 border-t border-line px-4 py-3.5 first:border-t-0 sm:px-5">
      <span className={clsx('w-1 shrink-0 rounded-full', severityBar[f.severity])} aria-hidden />
      <div className="min-w-0 flex-1">
        <button className="flex w-full items-start gap-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <div className="min-w-0 flex-1">
            <div className="font-medium">{f.title}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
              <SeverityBadge severity={f.severity} />
              <Badge>{SOURCE_LABEL[f.source] ?? f.source}</Badge>
              <span>
                {f.status === 'open' ? `detectat ${timeAgo(f.firstSeenAt)}` : f.status === 'resolved' ? `rezolvat ${timeAgo(f.resolvedAt)}` : 'ignorat'}
              </span>
            </div>
          </div>
          <ChevronDown className={clsx('mt-1 size-4 shrink-0 text-ink-3 transition-transform', open && 'rotate-180')} />
        </button>
        {open && (
          <div className="mt-3 space-y-3 text-sm">
            {f.details && <p className="whitespace-pre-wrap text-ink-2">{f.details}</p>}
            {f.recommendation && (
              <div className="rounded-xl bg-surface-2 px-3 py-2.5">
                <div className="text-[13px] font-medium text-ink-2">Recomandare</div>
                <p className="whitespace-pre-wrap">{f.recommendation}</p>
              </div>
            )}
            <div className="text-xs text-ink-3">
              Prima dată: {dateTime(f.firstSeenAt)} · Ultima dată: {dateTime(f.lastSeenAt)}
            </div>
            <div className="flex flex-wrap gap-2">
              {f.status === 'open' ? (
                <>
                  <Button size="sm" variant="primary" icon={<Bot className="size-4" />} onClick={askAgent}>
                    Cere agentului să rezolve
                  </Button>
                  <Button size="sm" variant="secondary" icon={<CheckCircle2 className="size-4" />} loading={setStatus.isPending && setStatus.variables === 'resolved'} onClick={() => setStatus.mutate('resolved')}>
                    Am rezolvat
                  </Button>
                  <Button size="sm" variant="ghost" icon={<EyeOff className="size-4" />} loading={setStatus.isPending && setStatus.variables === 'ignored'} onClick={() => setStatus.mutate('ignored')}>
                    Ignoră
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="secondary" icon={<RotateCcw className="size-4" />} loading={setStatus.isPending} onClick={() => setStatus.mutate('open')}>
                  Redeschide
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function SecurityPage() {
  const [filter, setFilter] = useState<FindingStatus>('open');
  const toast = useToast();
  const status = useStatus();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['findings', filter],
    queryFn: () => api.get<FindingDTO[]>(`/api/findings?status=${filter}`),
  });
  const scan = useMutation({
    mutationFn: () => api.post<{ started: number }>('/api/security/scan'),
    onSuccess: (r) => toast(`Am pornit ${r.started} verificări. Rezultatele apar aici în câteva momente.`, 'good'),
    onError: (err) => toast(errorText(err), 'critical'),
  });

  const sorted = useMemo(() => [...(data ?? [])].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.lastSeenAt - a.lastSeenAt), [data]);
  const counts = status.data?.findingsBySeverity;
  const checks = (status.data?.monitors ?? []).filter((m) => SECURITY_KINDS.includes(m.kind));
  const tiles: Severity[] = ['critical', 'high', 'medium', 'low'];

  return (
    <Page>
      <PageHeader
        title="Securitate"
        subtitle="datix.ro (WordPress) și my.datix.ro (WHMCS): vulnerabilități, configurări riscante, certificate, DNS, liste negre și evenimente suspecte."
        actions={
          <Button size="sm" variant="primary" icon={<ScanSearch className="size-4" />} loading={scan.isPending} onClick={() => scan.mutate()}>
            Scanează acum
          </Button>
        }
      />

      {counts && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {tiles.map((s) => (
            <div key={s} className="rounded-2xl border border-line bg-surface p-3.5">
              <SeverityBadge severity={s} />
              <div className="mt-2 text-2xl font-semibold tabular">{counts[s]}</div>
              <div className="text-xs text-ink-3">deschise</div>
            </div>
          ))}
        </div>
      )}

      <div className="mb-3 flex items-center justify-between gap-3">
        <Segmented
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'open', label: 'Deschise' },
            { value: 'resolved', label: 'Rezolvate' },
            { value: 'ignored', label: 'Ignorate' },
          ]}
        />
      </div>

      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} onRetry={() => refetch()} />
      ) : !sorted.length ? (
        <Card className="mb-5">
          <EmptyState icon={<ShieldCheck className="size-8 text-good" />} title={filter === 'open' ? 'Nicio problemă deschisă' : 'Nimic aici'}>
            {filter === 'open' ? 'Verificările rulează automat; orice problemă nouă apare aici și primești notificare dacă e importantă.' : null}
          </EmptyState>
        </Card>
      ) : (
        <Card className="mb-5 overflow-hidden">
          {sorted.map((f) => (
            <FindingCard key={f.id} f={f} />
          ))}
        </Card>
      )}

      {checks.length > 0 && (
        <Card>
          <CardHeader title="Verificări de securitate" subtitle="Rulează automat; apasă pe una pentru istoric." />
          <ul className="px-2 pb-2">
            {checks.map((m) => (
              <li key={m.id}>
                <Link href={`/monitor/${m.id}`} className="flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-surface-2/50">
                  <StatusBadge status={m.status} className="w-[104px] justify-center" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{m.name}</div>
                    <div className="truncate text-[12.5px] text-ink-3">{m.lastMessage ?? 'Încă neverificat'}</div>
                  </div>
                  <span className="hidden shrink-0 text-xs text-ink-3 sm:block">{timeAgo(m.lastCheckAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
}
