import { useState } from 'react';
import { Link } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CheckCircle2, CircleDashed, Play, RefreshCw, Siren, Sparkles, XCircle, Zap } from 'lucide-react';
import { INTEGRATION_LABEL, type IncidentDTO, type MonitorDTO, type SessionInfoDTO, type StatusOverviewDTO } from '@datix/shared';
import { api, errorText } from '../lib/api';
import { useStatus } from '../layout/Shell';
import { useToast } from '../lib/toast';
import { ms, pct, timeAgo, usd } from '../lib/format';
import { Badge, Button, Card, CardHeader, ErrorBox, Loading, Page, PageHeader } from '../components/ui';
import { SeverityBadge, StatusBadge } from '../components/status';
import { StatTile, UptimeStrip } from '../components/charts';

type BannerState = 'ok' | 'recovered' | 'incident' | 'degraded' | 'down' | 'unknown';

/** Starea afișată ține cont și de incidentele deschise, nu doar de ultimele verificări. */
function bannerState(overall: StatusOverviewDTO['overall'], incidents: IncidentDTO[]): BannerState {
  if (overall === 'down' || overall === 'unknown') return overall;
  if (incidents.some((i) => i.status !== 'mitigated')) return 'incident';
  if (overall === 'degraded') return 'degraded';
  return incidents.length ? 'recovered' : 'ok';
}

function OverallBanner({ state }: { state: BannerState }) {
  const map = {
    ok: { Icon: CheckCircle2, cls: 'border-good/30 bg-good-soft', icon: 'text-good', title: 'Totul funcționează normal', text: 'Site-urile răspund, nu sunt incidente deschise.' },
    recovered: { Icon: CheckCircle2, cls: 'border-good/30 bg-good-soft', icon: 'text-good', title: 'Site-urile funcționează din nou', text: 'Agentul a remediat problema; incidentul se închide automat după ce revenirea e confirmată.' },
    incident: { Icon: Siren, cls: 'border-critical/30 bg-critical-soft', icon: 'text-critical', title: 'Incident în curs', text: 'Agentul investighează; detaliile sunt mai jos.' },
    degraded: { Icon: AlertTriangle, cls: 'border-warning/40 bg-warning-soft', icon: 'text-warning-ink', title: 'Funcționează, cu probleme', text: 'Unele verificări raportează probleme. Detaliile sunt mai jos.' },
    down: { Icon: XCircle, cls: 'border-critical/30 bg-critical-soft', icon: 'text-critical', title: 'Un site nu funcționează', text: 'Agentul investighează automat; vezi incidentul de mai jos.' },
    unknown: { Icon: CircleDashed, cls: 'border-line bg-surface', icon: 'text-ink-3', title: 'Se fac primele verificări', text: 'Primele rezultate apar în câteva secunde.' },
  }[state];
  return (
    <div className={`mb-5 flex items-center gap-3 rounded-2xl border px-4 py-3.5 ${map.cls}`} role="status">
      <map.Icon className={`size-6 shrink-0 ${map.icon}`} />
      <div>
        <div className="font-semibold">{map.title}</div>
        <div className="text-sm text-ink-2">{map.text}</div>
      </div>
    </div>
  );
}

function SiteCard({ m }: { m: MonitorDTO }) {
  return (
    <Link href={`/monitor/${m.id}`} className="block">
      <Card className="p-4 transition-colors hover:border-line-strong">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-semibold">{m.name}</div>
            <div className="truncate text-[13px] text-ink-3">{m.target}</div>
          </div>
          <StatusBadge status={m.status} />
        </div>
        <div className="mt-3">
          <UptimeStrip series={m.latencySeries} />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
          <div>
            <div className="text-ink-3">Răspuns</div>
            <div className="tabular font-semibold text-ink">{ms(m.lastLatencyMs)}</div>
          </div>
          <div>
            <div className="text-ink-3">Uptime 24 h</div>
            <div className="tabular font-semibold text-ink">{pct(m.uptime24h)}</div>
          </div>
          <div>
            <div className="text-ink-3">Uptime 30 zile</div>
            <div className="tabular font-semibold text-ink">{pct(m.uptime30d)}</div>
          </div>
        </div>
        {m.status !== 'up' && m.lastMessage && <p className="mt-3 text-[13px] text-ink-2">{m.lastMessage}</p>}
      </Card>
    </Link>
  );
}

function Onboarding({ integrations, demo }: { integrations: Array<{ key: string; configured: boolean }>; demo: boolean }) {
  const missing = integrations.filter((i) => !i.configured && i.key !== 'reseller' && i.key !== 'pagespeed');
  if (!missing.length || demo) return null;
  return (
    <Card className="mb-5">
      <CardHeader title="Pași de configurare" subtitle="Conectează serviciile ca agentul să poată vedea și repara tot." icon={<Sparkles className="size-4" />} />
      <ul className="px-4 pb-4 sm:px-5">
        {missing.map((i) => (
          <li key={i.key}>
            <Link href={`/setari/${i.key === 'llm' ? 'ai' : 'integrari'}`} className="flex items-center justify-between gap-3 border-t border-line py-2.5 text-sm first:border-t-0">
              <span className="flex items-center gap-2">
                <CircleDashed className="size-4 text-ink-3" />
                Conectează {INTEGRATION_LABEL[i.key] ?? i.key}
              </span>
              <ArrowRight className="size-4 text-ink-3" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function DemoScenario() {
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['demo-state'], queryFn: () => api.get<{ wpFault: boolean }>('/api/demo/state'), refetchInterval: 5000 });
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (on: boolean) => api.post('/api/demo/fault', { on }),
    onSuccess: (_d, on) => {
      qc.invalidateQueries({ queryKey: ['demo-state'] });
      toast(on ? 'Am stricat un plugin pe datix.ro (simulat). Urmărește cum îl repară agentul.' : 'Simularea a fost oprită.', 'info');
    },
    onError: (err) => toast(errorText(err), 'critical'),
  });
  return (
    <Card className="mb-5 border-dashed">
      <CardHeader title="Încearcă scenariul de cădere" subtitle="Un plugin defect pică site-ul; agentul detectează, investighează și repară singur (simulat)." icon={<Zap className="size-4" />} />
      <div className="flex gap-2 px-4 pb-4 sm:px-5">
        {data?.wpFault ? (
          <Button size="sm" variant="secondary" onClick={() => m.mutate(false)} loading={m.isPending}>
            Oprește simularea
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={() => m.mutate(true)} loading={m.isPending} icon={<Siren className="size-4" />}>
            Simulează o cădere a datix.ro
          </Button>
        )}
      </div>
    </Card>
  );
}

export function StatusPage() {
  const { data, isLoading, error, refetch } = useStatus();
  const qc = useQueryClient();
  const session = qc.getQueryData<SessionInfoDTO>(['session']);
  const toast = useToast();
  const [runningId, setRunningId] = useState<string | null>(null);

  const runNow = async (id: string) => {
    setRunningId(id);
    try {
      await api.post(`/api/monitors/${id}/run`);
      await qc.invalidateQueries({ queryKey: ['status'] });
    } catch (err) {
      toast(errorText(err), 'critical');
    } finally {
      setRunningId(null);
    }
  };

  if (isLoading) return <Loading />;
  if (error || !data)
    return (
      <Page>
        <ErrorBox error={error} onRetry={() => refetch()} />
      </Page>
    );

  const sites = data.monitors.filter((m) => m.kind === 'http');
  const others = data.monitors.filter((m) => m.kind !== 'http');
  return (
    <Page wide>
      <PageHeader title="Status" subtitle="Disponibilitate, viteză și verificări automate pentru datix.ro și my.datix.ro." />
      <OverallBanner state={bannerState(data.overall, data.openIncidents)} />
      <Onboarding integrations={data.integrations} demo={!!session?.demoMode} />
      {session?.demoMode && <DemoScenario />}

      {data.openIncidents.length > 0 && (
        <div className="mb-5 space-y-2">
          {data.openIncidents.map((i) => (
            <Link
              key={i.id}
              href={`/incidente/${i.id}`}
              className={`flex items-center gap-3 rounded-2xl border px-4 py-3 ${i.status === 'mitigated' ? 'border-warning/40 bg-warning-soft' : 'border-critical/30 bg-critical-soft'}`}
            >
              <Siren className={`size-5 shrink-0 ${i.status === 'mitigated' ? 'text-warning-ink' : 'text-critical'}`} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{i.title}</div>
                <div className="text-[13px] text-ink-2">
                  {i.status === 'investigating' ? 'Agentul investighează' : i.status === 'mitigated' ? 'Atenuat — se confirmă revenirea' : 'Deschis'} · {timeAgo(i.openedAt)}
                </div>
              </div>
              <SeverityBadge severity={i.severity} />
            </Link>
          ))}
        </div>
      )}

      <div className="mb-6 grid gap-4 md:grid-cols-2">
        {sites.map((m) => (
          <SiteCard key={m.id} m={m} />
        ))}
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <StatTile label="Incidente deschise" value={data.openIncidents.length} sub={data.recentIncidents.length ? `${data.recentIncidents.length} în ultima perioadă` : 'niciun incident recent'} />
        <StatTile
          label="Probleme de securitate"
          value={data.findingsBySeverity.critical + data.findingsBySeverity.high + data.findingsBySeverity.medium}
          sub={`${data.findingsBySeverity.critical} critice · ${data.findingsBySeverity.high} ridicate`}
          tone={data.findingsBySeverity.critical ? 'critical' : undefined}
        />
        <StatTile label="Cost AI luna aceasta" value={usd(data.usage.monthCostUsd)} sub={`din bugetul de ${usd(data.usage.monthBudgetUsd)} · ${data.usage.monthRequests} cereri`} tone={data.usage.budgetExceeded ? 'critical' : undefined} />
      </div>

      <Card>
        <CardHeader title="Toate verificările" subtitle="Se rulează automat; poți porni oricare acum." action={<Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} onClick={() => refetch()}>Actualizează</Button>} />
        <ul className="px-2 pb-2">
          {others.map((m) => (
            <li key={m.id} className="flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-surface-2/50">
              <StatusBadge status={m.status} className="w-[104px] justify-center" />
              <Link href={`/monitor/${m.id}`} className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{m.name}</div>
                <div className="truncate text-[12.5px] text-ink-3">{m.lastMessage ?? 'Încă neverificat'}</div>
              </Link>
              <span className="hidden shrink-0 text-xs text-ink-3 sm:block">{timeAgo(m.lastCheckAt)}</span>
              <button onClick={() => runNow(m.id)} disabled={runningId === m.id} className="rounded-lg p-2 text-ink-3 hover:bg-surface-3 hover:text-ink disabled:animate-pulse" aria-label="Rulează acum" title="Rulează acum">
                <Play className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      </Card>

      <div className="mt-6 flex flex-wrap gap-2">
        {data.integrations.map((i) => (
          <Badge key={i.key} tone={i.configured ? 'good' : 'neutral'}>
            {i.configured ? <CheckCircle2 className="size-3" /> : <CircleDashed className="size-3" />}
            {INTEGRATION_LABEL[i.key]}
          </Badge>
        ))}
      </div>
    </Page>
  );
}
