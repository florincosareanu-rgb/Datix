import { useState } from 'react';
import clsx from 'clsx';
import { Link } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CheckCircle2, CircleDashed, Coins, Play, RefreshCw, ShieldCheck, Siren, Sparkles, XCircle, Zap } from 'lucide-react';
import { INTEGRATION_LABEL, type IncidentDTO, type MonitorDTO, type SessionInfoDTO, type StatusOverviewDTO } from '@datix/shared';
import { api, errorText } from '../lib/api';
import { useStatus } from '../layout/Shell';
import { useToast } from '../lib/toast';
import { ms, pct, timeAgo, usd } from '../lib/format';
import { Badge, Button, Card, CardHeader, ErrorBox, Loading, Page, PageHeader } from '../components/ui';
import { SeverityBadge, StatusBadge, StatusIcon } from '../components/status';
import { StatTile, UptimeStrip } from '../components/charts';

type BannerState = 'ok' | 'recovered' | 'incident' | 'degraded' | 'down' | 'unknown';

/** Starea afișată ține cont și de incidentele deschise, nu doar de ultimele verificări. */
function bannerState(overall: StatusOverviewDTO['overall'], incidents: IncidentDTO[]): BannerState {
  if (overall === 'down' || overall === 'unknown') return overall;
  if (incidents.some((i) => i.status !== 'mitigated')) return 'incident';
  if (overall === 'degraded') return 'degraded';
  return incidents.length ? 'recovered' : 'ok';
}

function OverallBanner({ state, checkedAt }: { state: BannerState; checkedAt: number | null }) {
  const map = ({
    ok: { Icon: CheckCircle2, tone: 'good', title: 'Totul funcționează normal', text: 'Site-urile răspund, nu sunt incidente deschise.' },
    recovered: { Icon: CheckCircle2, tone: 'good', title: 'Site-urile funcționează din nou', text: 'DAX a remediat problema; incidentul se închide automat după ce revenirea e confirmată.' },
    incident: { Icon: Siren, tone: 'critical', title: 'Incident în curs', text: 'DAX investighează; detaliile sunt mai jos.' },
    degraded: { Icon: AlertTriangle, tone: 'warning', title: 'Funcționează, cu probleme', text: 'Unele verificări raportează probleme. Detaliile sunt mai jos.' },
    down: { Icon: XCircle, tone: 'critical', title: 'Un site nu funcționează', text: 'DAX investighează automat; vezi incidentul de mai jos.' },
    unknown: { Icon: CircleDashed, tone: 'neutral', title: 'Se fac primele verificări', text: 'Primele rezultate apar în câteva secunde.' },
  } as const)[state];
  const tone = {
    good: { card: 'border-good/25 from-good-soft', tile: 'bg-good text-white shadow-[0_8px_20px_-8px_rgb(12_163_12/0.6)]' },
    warning: { card: 'border-warning/35 from-warning-soft', tile: 'bg-warning text-on-warning shadow-[0_8px_20px_-8px_rgb(250_178_25/0.6)]' },
    critical: { card: 'border-critical/25 from-critical-soft', tile: 'bg-critical text-white shadow-[0_8px_20px_-8px_rgb(208_59_59/0.6)]' },
    neutral: { card: 'border-line/80 from-surface-2', tile: 'bg-surface-3 text-ink-2' },
  }[map.tone];
  return (
    <div className={clsx('card-shadow mb-6 flex items-center gap-4 rounded-3xl border bg-linear-to-br to-surface p-5 sm:p-6', tone.card)} role="status">
      <span className={clsx('flex size-12 shrink-0 items-center justify-center rounded-2xl', tone.tile)} aria-hidden>
        <map.Icon className="size-6" />
      </span>
      <div className="min-w-0">
        <div className="font-display text-[20px] leading-tight font-semibold sm:text-[22px]">{map.title}</div>
        <div className="mt-1 text-[15px] text-ink-2">{map.text}</div>
        {checkedAt && <div className="mt-1.5 text-[13px] text-ink-3">Ultima verificare: {timeAgo(checkedAt)}</div>}
      </div>
    </div>
  );
}

function SiteCard({ m }: { m: MonitorDTO }) {
  return (
    <Link href={`/monitor/${m.id}`} className="pressable block rounded-3xl">
      <Card className="h-full p-5 transition-colors hover:border-line-strong">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-display text-[17px] font-semibold">{m.name}</div>
            <div className="truncate text-[13.5px] text-ink-3">{m.target}</div>
          </div>
          <StatusBadge status={m.status} />
        </div>
        <div className="mt-4">
          <UptimeStrip series={m.latencySeries} />
        </div>
        <dl className="mt-4 grid grid-cols-3 gap-2 rounded-2xl bg-surface-2 p-3 text-center">
          <div>
            <dt className="text-[12px] text-ink-3">Răspuns</dt>
            <dd className="tabular mt-0.5 font-display text-[17px] font-semibold text-ink">{ms(m.lastLatencyMs)}</dd>
          </div>
          <div>
            <dt className="text-[12px] text-ink-3">Uptime 24 h</dt>
            <dd className="tabular mt-0.5 font-display text-[17px] font-semibold text-ink">{pct(m.uptime24h)}</dd>
          </div>
          <div>
            <dt className="text-[12px] text-ink-3">Uptime 30 zile</dt>
            <dd className="tabular mt-0.5 font-display text-[17px] font-semibold text-ink">{pct(m.uptime30d)}</dd>
          </div>
        </dl>
        {m.status !== 'up' && m.lastMessage && <p className="mt-3 text-[14px] text-ink-2">{m.lastMessage}</p>}
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
    <Card className="mb-6 border-accent/20 bg-linear-to-br from-accent-soft to-surface">
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
      <OverallBanner state={bannerState(data.overall, data.openIncidents)} checkedAt={Math.max(0, ...sites.map((m) => m.lastCheckAt ?? 0)) || null} />
      <Onboarding integrations={data.integrations} demo={!!session?.demoMode} />
      {session?.demoMode && <DemoScenario />}

      {data.openIncidents.length > 0 && (
        <div className="mb-6 space-y-3">
          {data.openIncidents.map((i) => (
            <Link
              key={i.id}
              href={`/incidente/${i.id}`}
              className={clsx('pressable card-shadow flex items-center gap-3.5 rounded-3xl border px-4 py-3.5', i.status === 'mitigated' ? 'border-warning/40 bg-warning-soft' : 'border-critical/30 bg-critical-soft')}
            >
              <span className={clsx('flex size-10 shrink-0 items-center justify-center rounded-xl', i.status === 'mitigated' ? 'bg-warning/25 text-warning-ink' : 'bg-critical/15 text-critical-ink')} aria-hidden>
                <Siren className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 font-display text-[16px] font-semibold">{i.title}</div>
                <div className="text-[14px] text-ink-2">
                  {i.status === 'investigating' ? 'DAX investighează' : i.status === 'mitigated' ? 'Atenuat — se confirmă revenirea' : 'Deschis'} · {timeAgo(i.openedAt)}
                </div>
              </div>
              <SeverityBadge severity={i.severity} />
            </Link>
          ))}
        </div>
      )}

      <div className="enter-stagger mb-6 grid gap-4 md:grid-cols-2">
        {sites.map((m) => (
          <SiteCard key={m.id} m={m} />
        ))}
      </div>

      <div className="enter-stagger mb-6 grid gap-3 sm:grid-cols-3 sm:gap-4">
        <StatTile icon={<Siren />} label="Incidente deschise" value={data.openIncidents.length} sub={data.recentIncidents.length ? `${data.recentIncidents.length} în ultima perioadă` : 'niciun incident recent'} />
        <StatTile
          icon={<ShieldCheck />}
          label="Probleme de securitate"
          value={data.findingsBySeverity.critical + data.findingsBySeverity.high + data.findingsBySeverity.medium}
          sub={`${data.findingsBySeverity.critical} critice · ${data.findingsBySeverity.high} ridicate`}
          tone={data.findingsBySeverity.critical ? 'critical' : undefined}
        />
        <StatTile icon={<Coins />} label="Cost AI luna aceasta" value={usd(data.usage.monthCostUsd)} sub={`din bugetul de ${usd(data.usage.monthBudgetUsd)} · ${data.usage.monthRequests} cereri`} tone={data.usage.budgetExceeded ? 'critical' : undefined} />
      </div>

      <Card>
        <CardHeader title="Toate verificările" subtitle="Se rulează automat; poți porni oricare acum." action={<Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} onClick={() => refetch()}>Actualizează</Button>} />
        <ul className="divide-y divide-line/70 px-3 pb-2">
          {others.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-2 py-2.5">
              <StatusIcon status={m.status} className="sm:hidden" />
              <span className="hidden shrink-0 sm:block">
                <StatusBadge status={m.status} className="w-[108px] justify-center" />
              </span>
              <Link href={`/monitor/${m.id}`} className="flex min-h-11 min-w-0 flex-1 flex-col justify-center rounded-lg">
                <div className="line-clamp-2 text-[15px] leading-snug font-medium">{m.name}</div>
                <div className="truncate text-[13.5px] text-ink-3">{m.lastMessage ?? 'Încă neverificat'}</div>
              </Link>
              <span className="hidden shrink-0 text-[13px] text-ink-3 sm:block">{timeAgo(m.lastCheckAt)}</span>
              <button
                onClick={() => runNow(m.id)}
                disabled={runningId === m.id}
                className="pressable flex size-11 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-accent-fg disabled:animate-pulse"
                aria-label={`Rulează acum: ${m.name}`}
                title="Rulează acum"
              >
                <Play className="size-[18px]" />
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
