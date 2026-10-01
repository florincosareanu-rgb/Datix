import { useState } from 'react';
import { useRoute } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pause, Play, RefreshCw } from 'lucide-react';
import { MONITOR_STATUS_LABEL, type CheckResultDTO, type MonitorDTO } from '@datix/shared';
import { api, errorText } from '../lib/api';
import { useToast } from '../lib/toast';
import { dateTime, ms, pct, timeAgo } from '../lib/format';
import { Button, Card, CardHeader, ErrorBox, Loading, Page, PageHeader, Segmented } from '../components/ui';
import { StatusBadge } from '../components/status';
import { LatencyChart, StatTile } from '../components/charts';

interface MonitorResponse {
  monitor: MonitorDTO;
  history: CheckResultDTO[];
  lastDetails: unknown;
}

export function MonitorDetailPage() {
  const [, params] = useRoute('/monitor/:id');
  const id = params?.id ?? '';
  const [hours, setHours] = useState<'24' | '168' | '720'>('24');
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['monitor', id, hours],
    queryFn: () => api.get<MonitorResponse>(`/api/monitors/${id}?hours=${hours}`),
  });
  const run = useMutation({
    mutationFn: () => api.post<CheckResultDTO>(`/api/monitors/${id}/run`),
    onSuccess: (r) => {
      toast(`${MONITOR_STATUS_LABEL[r.status]}: ${r.message ?? ''}`, r.status === 'up' ? 'good' : 'info');
      qc.invalidateQueries({ queryKey: ['monitor', id] });
    },
    onError: (err) => toast(errorText(err), 'critical'),
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.patch(`/api/monitors/${id}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['monitor', id] }),
  });

  if (isLoading) return <Loading />;
  if (error || !data)
    return (
      <Page>
        <ErrorBox error={error} onRetry={() => refetch()} />
      </Page>
    );
  const m = data.monitor;
  const isSite = m.kind === 'http';
  const points = data.history.map((h) => ({ at: h.at, ms: h.latencyMs, status: h.status }));
  return (
    <Page wide>
      <PageHeader
        title={m.name}
        subtitle={m.target}
        actions={
          <>
            <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" />} loading={run.isPending} onClick={() => run.mutate()}>
              Verifică acum
            </Button>
            <Button size="sm" variant="ghost" icon={m.enabled ? <Pause className="size-4" /> : <Play className="size-4" />} onClick={() => toggle.mutate(!m.enabled)}>
              {m.enabled ? 'Pune pe pauză' : 'Reia'}
            </Button>
          </>
        }
      />
      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatTile label="Stare" value={<StatusBadge status={m.status} className="text-sm" />} sub={`verificat ${timeAgo(m.lastCheckAt)}`} />
        {isSite ? (
          <>
            <StatTile label="Uptime 24 h" value={pct(m.uptime24h)} />
            <StatTile label="Uptime 7 zile" value={pct(m.uptime7d)} />
            <StatTile label="Uptime 30 zile" value={pct(m.uptime30d)} />
          </>
        ) : (
          <StatTile label="Interval" value={m.intervalSec >= 3600 ? `${Math.round(m.intervalSec / 3600)} h` : `${Math.round(m.intervalSec / 60)} min`} />
        )}
      </div>
      {isSite && (
        <Card className="mb-5">
          <CardHeader
            title="Timp de răspuns"
            subtitle="Fiecare punct e o verificare; semnele roșii de jos marchează căderile."
            action={
              <Segmented
                size="sm"
                value={hours}
                onChange={setHours}
                options={[
                  { value: '24', label: '24 h' },
                  { value: '168', label: '7 zile' },
                  { value: '720', label: '30 zile' },
                ]}
              />
            }
          />
          <div className="px-3 pb-4 sm:px-4">
            <LatencyChart points={points} />
          </div>
        </Card>
      )}
      <Card className="mb-5">
        <CardHeader title="Ultimul rezultat" />
        <div className="px-4 pb-4 sm:px-5">
          <p className="text-sm">{m.lastMessage ?? '—'}</p>
          {data.lastDetails != null && (
            <details className="mt-3">
              <summary className="cursor-pointer text-[13px] text-ink-3">Detalii tehnice</summary>
              <pre className="scrollbar-thin mt-2 max-h-80 overflow-auto rounded-xl bg-surface-2 p-3 text-[11.5px] leading-relaxed">{JSON.stringify(data.lastDetails, null, 2)}</pre>
            </details>
          )}
        </div>
      </Card>
      <Card>
        <CardHeader title="Istoric" subtitle="Cele mai recente verificări (tabel)" />
        <div className="scrollbar-thin overflow-x-auto px-2 pb-3">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-ink-3">
              <tr>
                <th className="px-2 py-1.5 font-medium">Când</th>
                <th className="px-2 py-1.5 font-medium">Stare</th>
                <th className="px-2 py-1.5 font-medium">Răspuns</th>
                <th className="px-2 py-1.5 font-medium">Mesaj</th>
              </tr>
            </thead>
            <tbody>
              {[...data.history]
                .reverse()
                .slice(0, 60)
                .map((h) => (
                  <tr key={h.at} className="border-t border-line">
                    <td className="tabular px-2 py-1.5 whitespace-nowrap text-ink-2">{dateTime(h.at)}</td>
                    <td className="px-2 py-1.5">
                      <StatusBadge status={h.status} />
                    </td>
                    <td className="tabular px-2 py-1.5 whitespace-nowrap">{ms(h.latencyMs)}</td>
                    <td className="max-w-md truncate px-2 py-1.5 text-ink-2">{h.message}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>
    </Page>
  );
}
