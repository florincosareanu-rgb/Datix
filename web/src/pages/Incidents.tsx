import { useState } from 'react';
import { Link, useRoute } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, Bot, CheckCircle2, MessageSquare, Search, Siren } from 'lucide-react';
import { INCIDENT_STATUS_LABEL, type IncidentDTO, type IncidentEventDTO, type IncidentStatus } from '@datix/shared';
import { api, errorText } from '../lib/api';
import { useToast } from '../lib/toast';
import { dateTime, duration, timeAgo } from '../lib/format';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorBox, Field, Loading, Modal, Page, PageHeader, Segmented, Textarea } from '../components/ui';
import { SeverityBadge, severityBar } from '../components/status';
import { Markdown } from '../components/Markdown';

const STATUS_TONE: Record<IncidentStatus, 'critical' | 'warning' | 'good' | 'accent'> = {
  open: 'critical',
  investigating: 'accent',
  mitigated: 'warning',
  resolved: 'good',
};

export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{INCIDENT_STATUS_LABEL[status]}</Badge>;
}

function IncidentRow({ i }: { i: IncidentDTO }) {
  const active = i.status !== 'resolved';
  return (
    <Link href={`/incidente/${i.id}`} className="flex items-stretch gap-3 border-t border-line px-4 py-3 first:border-t-0 hover:bg-surface-2/50 sm:px-5">
      <span className={clsx('w-1 shrink-0 rounded-full', severityBar[i.severity])} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{i.title}</span>
          <IncidentStatusBadge status={i.status} />
        </div>
        <div className="mt-0.5 text-[13px] text-ink-3">
          {dateTime(i.openedAt)} · {active ? `durează de ${timeAgo(i.openedAt).replace('acum ', '')}` : `a durat ${duration(i.durationSec)}`}
        </div>
        {i.summary && <p className="mt-1 line-clamp-2 text-[13px] text-ink-2">{i.summary}</p>}
      </div>
      <div className="shrink-0">
        <SeverityBadge severity={i.severity} />
      </div>
    </Link>
  );
}

export function IncidentsPage() {
  const [filter, setFilter] = useState<'active' | 'all'>('all');
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['incidents', filter],
    queryFn: () => api.get<IncidentDTO[]>(`/api/incidents?status=${filter}`),
  });
  return (
    <Page>
      <PageHeader
        title="Incidente"
        subtitle="Căderi și probleme detectate automat, cu investigația agentului și raportul post-incident."
        actions={
          <Segmented
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'Toate' },
              { value: 'active', label: 'Active' },
            ]}
          />
        }
      />
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} onRetry={() => refetch()} />
      ) : !data?.length ? (
        <Card>
          <EmptyState icon={<CheckCircle2 className="size-8 text-good" />} title={filter === 'active' ? 'Niciun incident activ' : 'Niciun incident până acum'}>
            Când un site cade sau răspunde cu erori, incidentul apare aici, iar agentul începe imediat investigația.
          </EmptyState>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {data.map((i) => (
            <IncidentRow key={i.id} i={i} />
          ))}
        </Card>
      )}
    </Page>
  );
}

// tipurile de evenimente scrise de server (monitoring/incidents.ts)
const EVENT_STYLE: Record<string, string> = {
  detected: 'bg-critical',
  check: 'bg-line-strong',
  status: 'bg-accent',
  agent_report: 'bg-accent',
  agent_done: 'bg-accent',
  waiting_approval: 'bg-warning',
  agent_error: 'bg-serious',
  resolved: 'bg-good',
};

export function IncidentDetailPage() {
  const [, params] = useRoute('/incidente/:id');
  const id = params?.id ?? '';
  const qc = useQueryClient();
  const toast = useToast();
  const [resolveOpen, setResolveOpen] = useState(false);
  const [note, setNote] = useState('');
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['incident', id],
    queryFn: () => api.get<{ incident: IncidentDTO; events: IncidentEventDTO[] }>(`/api/incidents/${id}`),
    refetchInterval: (q) => (q.state.data?.incident.status === 'resolved' ? false : 10_000),
  });
  const investigate = useMutation({
    mutationFn: () => api.post(`/api/incidents/${id}/investigate`),
    onSuccess: () => {
      toast('Agentul a pornit investigația.', 'good');
      qc.invalidateQueries({ queryKey: ['incident', id] });
    },
    onError: (err) => toast(errorText(err), 'critical'),
  });
  const resolve = useMutation({
    mutationFn: () => api.post(`/api/incidents/${id}/resolve`, note.trim() ? { note: note.trim() } : {}),
    onSuccess: () => {
      setResolveOpen(false);
      toast('Incident marcat ca rezolvat.', 'good');
      qc.invalidateQueries({ queryKey: ['incident', id] });
      qc.invalidateQueries({ queryKey: ['incidents'] });
      qc.invalidateQueries({ queryKey: ['status'] });
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
  const { incident: i, events } = data;
  const active = i.status !== 'resolved';
  return (
    <Page>
      <Link href="/incidente" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink">
        <ArrowLeft className="size-4" /> Incidente
      </Link>
      <PageHeader
        title={i.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={i.severity} />
            <IncidentStatusBadge status={i.status} />
            <span>
              deschis {dateTime(i.openedAt)}
              {i.resolvedAt ? ` · rezolvat ${dateTime(i.resolvedAt)} · ${duration(i.durationSec)}` : ''}
            </span>
          </span>
        }
        actions={
          <>
            {i.conversationId && (
              <Link href={`/chat/${i.conversationId}`}>
                <Button size="sm" variant="secondary" icon={<MessageSquare className="size-4" />}>
                  Investigația agentului
                </Button>
              </Link>
            )}
            {active && (
              <>
                <Button size="sm" variant="secondary" icon={<Search className="size-4" />} loading={investigate.isPending} onClick={() => investigate.mutate()}>
                  Investighează din nou
                </Button>
                <Button size="sm" variant="primary" icon={<CheckCircle2 className="size-4" />} onClick={() => setResolveOpen(true)}>
                  Marchează rezolvat
                </Button>
              </>
            )}
          </>
        }
      />

      {(i.summary || i.rootCause) && (
        <Card className="mb-5">
          <CardHeader title="Ce s-a întâmplat" icon={<Bot className="size-4" />} />
          <div className="space-y-3 px-4 pb-4 text-sm sm:px-5">
            {i.summary && <p>{i.summary}</p>}
            {i.rootCause && (
              <div>
                <div className="text-[13px] font-medium text-ink-2">Cauza</div>
                <p>{i.rootCause}</p>
              </div>
            )}
          </div>
        </Card>
      )}

      <Card className="mb-5">
        <CardHeader title="Cronologie" subtitle="Tot ce au făcut monitorizarea și agentul, în ordine." icon={<Siren className="size-4" />} />
        <ol className="px-4 pb-4 sm:px-5">
          {events.map((e, idx) => (
            <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
              {idx < events.length - 1 && <span className="absolute top-3 left-[5px] h-full w-px bg-line" aria-hidden />}
              <span className={clsx('relative mt-1.5 size-[11px] shrink-0 rounded-full ring-4 ring-surface', EVENT_STYLE[e.kind] ?? 'bg-ink-3')} aria-hidden />
              <div className="min-w-0">
                <div className="text-xs text-ink-3">{dateTime(e.at)}</div>
                <div className="text-sm whitespace-pre-wrap">{e.message}</div>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      {i.postmortem && (
        <Card>
          <CardHeader title="Raport post-incident" subtitle="Scris de agent după rezolvare." />
          <div className="prose-chat px-4 pb-5 sm:px-5">
            <Markdown text={i.postmortem} />
          </div>
        </Card>
      )}

      <Modal
        open={resolveOpen}
        onClose={() => setResolveOpen(false)}
        title="Marchează incidentul ca rezolvat"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setResolveOpen(false)}>
              Renunță
            </Button>
            <Button variant="primary" loading={resolve.isPending} onClick={() => resolve.mutate()}>
              Rezolvat
            </Button>
          </>
        }
      >
        <Field label="Notă (opțional)" hint="Apare în cronologie și în raportul post-incident.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: am repornit manual PHP din DirectAdmin." maxLength={500} />
        </Field>
      </Modal>
    </Page>
  );
}
