import { Link } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDrive, RefreshCw } from 'lucide-react';
import type { BusinessDTO, MonitorDTO } from '@datix/shared';
import { api, errorText } from '../lib/api';
import { useToast } from '../lib/toast';
import { compact, dateOnly, money, timeAgo } from '../lib/format';
import { Button, Card, CardHeader, ErrorBox, Loading, Notice, Page, PageHeader } from '../components/ui';
import { ColumnChart, Meter, StatTile } from '../components/charts';

interface DaUsage {
  diskMb: number | null;
  diskLimitMb: number | null;
  diskPct: number | null;
  bandwidthMb: number | null;
  bandwidthLimitMb: number | null;
  bandwidthPct: number | null;
  inodes: number | null;
  inodeLimit: number | null;
  inodePct: number | null;
  emailAccounts: number | null;
  databases: number | null;
  domains: number | null;
  package: string | null;
  php: string | null;
  suspended: boolean;
}

const mb = (v: number | null) => (v == null ? '—' : v >= 1024 ? `${(v / 1024).toFixed(1).replace('.', ',')} GB` : `${Math.round(v)} MB`);

function HostingResources() {
  const { data } = useQuery({
    queryKey: ['monitor', 'da-usage', 'details'],
    queryFn: () => api.get<{ monitor: MonitorDTO; lastDetails: DaUsage | null }>('/api/monitors/da-usage?hours=1'),
    retry: false,
  });
  const u = data?.lastDetails;
  if (!u) return null;
  return (
    <Card className="mb-5">
      <CardHeader
        title="Resurse hosting"
        subtitle={`Contul DirectAdmin${u.package ? ` · pachet ${u.package}` : ''}${u.php ? ` · PHP ${u.php}` : ''} · actualizat ${timeAgo(data?.monitor.lastCheckAt)}`}
        icon={<HardDrive className="size-4" />}
      />
      <div className="grid gap-4 px-4 pb-4 sm:grid-cols-3 sm:px-5">
        <Meter label="Spațiu pe disc" valuePct={u.diskPct} detail={`${mb(u.diskMb)} din ${u.diskLimitMb ? mb(u.diskLimitMb) : 'nelimitat'}`} />
        <Meter label="Trafic lunar" valuePct={u.bandwidthPct} detail={`${mb(u.bandwidthMb)} din ${u.bandwidthLimitMb ? mb(u.bandwidthLimitMb) : 'nelimitat'}`} />
        <Meter label="Fișiere (inodes)" valuePct={u.inodePct} detail={`${compact(u.inodes)} din ${u.inodeLimit ? compact(u.inodeLimit) : 'nelimitat'}`} />
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line px-4 py-3 text-[13px] text-ink-2 sm:px-5">
        <span>Domenii: {u.domains ?? '—'}</span>
        <span>Conturi e-mail: {u.emailAccounts ?? '—'}</span>
        <span>Baze de date: {u.databases ?? '—'}</span>
        {u.suspended && <span className="font-medium text-critical-ink">Contul este SUSPENDAT</span>}
      </div>
    </Card>
  );
}

export function BusinessPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['business'], queryFn: () => api.get<BusinessDTO>('/api/business') });
  const refresh = useMutation({
    mutationFn: () => api.post<BusinessDTO>('/api/business/refresh'),
    onSuccess: (d) => {
      qc.setQueryData(['business'], d);
      toast('Cifrele au fost actualizate din WHMCS.', 'good');
    },
    onError: (err) => toast(errorText(err), 'critical'),
  });

  if (isLoading) return <Loading />;
  if (error || !data)
    return (
      <Page>
        <ErrorBox error={error} onRetry={() => refetch()} />
      </Page>
    );

  const s = data.latest;
  const cur = (n: number | null | undefined) => money(n, s?.currencyPrefix ?? '', s?.currencySuffix ?? '');
  const days = data.timeline.map((t) => {
    const d = new Date(`${t.date}T12:00:00`);
    return { ...t, label: `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`, title: dateOnly(d.getTime()) };
  });
  const total30 = days.reduce((sum, d) => sum + d.income, 0);
  const orders30 = days.reduce((sum, d) => sum + d.newOrders, 0);

  return (
    <Page wide>
      <PageHeader
        title="Business"
        subtitle={s ? `Cifre din WHMCS · actualizat ${timeAgo(s.at)}` : 'Cifre din WHMCS'}
        actions={
          <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" />} loading={refresh.isPending} onClick={() => refresh.mutate()} disabled={!data.available}>
            Actualizează
          </Button>
        }
      />

      {!data.available && (
        <div className="mb-5">
          <Notice tone="info">
            {data.message ?? 'Conectează WHMCS ca să vezi încasările, comenzile și facturile.'}{' '}
            <Link href="/setari/integrari" className="underline">
              Conectează WHMCS
            </Link>
          </Notice>
        </div>
      )}

      {s && (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Încasări azi" value={cur(s.incomeToday)} />
            <StatTile label="Încasări luna aceasta" value={cur(s.incomeThisMonth)} />
            <StatTile label="Încasări anul acesta" value={cur(s.incomeThisYear)} />
            <StatTile label="Servicii active" value={compact(s.activeServices)} />
            <StatTile label="Comenzi în așteptare" value={s.ordersPending ?? '—'} sub={`${s.ordersToday ?? 0} azi · ${s.ordersThisMonth ?? 0} luna aceasta`} tone={s.ordersPending ? 'warning' : undefined} />
            <StatTile label="Facturi neplătite" value={s.unpaidInvoices ?? '—'} sub={s.unpaidTotal != null ? `total ${cur(s.unpaidTotal)}` : undefined} />
            <StatTile label="Facturi restante" value={s.overdueInvoices ?? '—'} tone={s.overdueInvoices ? 'critical' : undefined} sub={s.overdueInvoices ? 'au trecut de scadență' : 'nicio factură restantă'} />
            <StatTile label="Tichete ce așteaptă răspuns" value={s.ticketsAwaitingReply ?? '—'} sub={`${s.ticketsOpen ?? 0} deschise în total`} tone={s.ticketsAwaitingReply ? 'warning' : undefined} />
          </div>
          {(s.cancellationsPending || s.domainsExpiringSoon) ? (
            <div className="mb-5 grid gap-3 sm:grid-cols-2">
              {s.cancellationsPending ? <Notice tone="warning">{s.cancellationsPending} cereri de anulare așteaptă decizia ta.</Notice> : null}
              {s.domainsExpiringSoon ? <Notice tone="warning">{s.domainsExpiringSoon} domenii ale clienților expiră în curând.</Notice> : null}
            </div>
          ) : null}
        </>
      )}

      {days.length > 0 && (
        <div className="mb-5 grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="Încasări pe zi" subtitle={`Ultimele ${days.length} zile · total ${cur(total30)}`} />
            <div className="px-3 pb-4 sm:px-4">
              <ColumnChart data={days.map((d) => ({ label: d.label, value: d.income, title: d.title }))} format={(v) => cur(v)} />
            </div>
          </Card>
          <Card>
            <CardHeader title="Comenzi noi pe zi" subtitle={`Ultimele ${days.length} zile · total ${orders30}`} />
            <div className="px-3 pb-4 sm:px-4">
              <ColumnChart data={days.map((d) => ({ label: d.label, value: d.newOrders, title: d.title }))} format={(v) => String(Math.round(v))} />
            </div>
          </Card>
        </div>
      )}

      {days.length > 0 && (
        <Card className="mb-5">
          <details>
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium sm:px-5">Tabel cu datele zilnice</summary>
            <div className="scrollbar-thin overflow-x-auto px-2 pb-3">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-ink-3">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Ziua</th>
                    <th className="px-2 py-1.5 text-right font-medium">Încasări</th>
                    <th className="px-2 py-1.5 text-right font-medium">Comenzi</th>
                    <th className="px-2 py-1.5 text-right font-medium">Tichete noi</th>
                  </tr>
                </thead>
                <tbody>
                  {[...days].reverse().map((d) => (
                    <tr key={d.date} className="border-t border-line">
                      <td className="px-2 py-1.5">{d.title}</td>
                      <td className="tabular px-2 py-1.5 text-right">{cur(d.income)}</td>
                      <td className="tabular px-2 py-1.5 text-right">{d.newOrders}</td>
                      <td className="tabular px-2 py-1.5 text-right">{d.newTickets}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </Card>
      )}

      <HostingResources />
    </Page>
  );
}
