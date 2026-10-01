import { useEffect, useState } from 'react';
import { Link, useRoute } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, ArrowLeft, Bot, ExternalLink, Inbox, MessageSquare, Moon, RefreshCw, Send, Sparkles, Trash2 } from 'lucide-react';
import {
  ESCALATION_REASON_LABEL,
  TICKET_JOB_STATUS_LABEL,
  TICKET_MODE_LABEL,
  type SettingsResponseDTO,
  type TicketDetailDTO,
  type TicketJobDTO,
  type TicketJobStatus,
  type TicketMode,
} from '@datix/shared';
import { api, errorText } from '../lib/api';
import { useToast } from '../lib/toast';
import { dateTime, timeAgo } from '../lib/format';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorBox, Field, Input, Loading, Notice, Page, PageHeader, Segmented, Tabs, Textarea, Toggle } from '../components/ui';
import { Markdown } from '../components/Markdown';

interface TicketSummary {
  mode: TicketMode;
  effectiveMode: TicketMode;
  counts: Partial<Record<TicketJobStatus, number>>;
}

const JOB_TONE: Record<TicketJobStatus, 'neutral' | 'accent' | 'good' | 'warning' | 'serious' | 'critical'> = {
  queued: 'neutral',
  analyzing: 'accent',
  draft_ready: 'accent',
  sent: 'good',
  escalated: 'warning',
  skipped: 'neutral',
  discarded: 'neutral',
  error: 'critical',
};

export function JobStatusBadge({ status }: { status: TicketJobStatus }) {
  return <Badge tone={JOB_TONE[status]}>{TICKET_JOB_STATUS_LABEL[status]}</Badge>;
}

const URGENCY_LABEL: Record<string, string> = { low: 'scăzută', normal: 'normală', high: 'ridicată', critical: 'critică' };

const MODE_HELP: Record<TicketMode, string> = {
  off: 'Agentul nu analizează tichetele. Primești doar notificarea că a venit un tichet nou.',
  draft: 'Agentul citește tichetul, verifică problema (site, DNS, e-mail, serviciu) și îți pregătește un răspuns. Tu îl citești și îl trimiți.',
  auto: 'Agentul răspunde singur la tichetele sigure. Banii, anulările, modificările de cont și reclamațiile ajung mereu la tine.',
};

function ModeCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const summary = useQuery({ queryKey: ['tickets-summary'], queryFn: () => api.get<TicketSummary>('/api/tickets/summary') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsResponseDTO>('/api/settings') });
  const t = settings.data?.settings.tickets;
  const setMode = useMutation({
    mutationFn: (body: { mode: TicketMode; autoOnlyInSchedule?: boolean }) => api.patch<TicketSummary>('/api/tickets/mode', body),
    onSuccess: (r) => {
      qc.setQueryData(['tickets-summary'], r);
      qc.invalidateQueries({ queryKey: ['settings'] });
      toast(`Mod tichete: ${TICKET_MODE_LABEL[r.mode]}.`, 'good');
    },
    onError: (err) => toast(errorText(err), 'critical'),
  });
  if (!summary.data || !t) return <Card className="mb-5 h-40 animate-pulse">{null}</Card>;
  const mode = summary.data.mode;
  const effective = summary.data.effectiveMode;
  return (
    <Card className="mb-5">
      <CardHeader title="Cum răspunde agentul la tichete" subtitle={MODE_HELP[mode]} icon={<Bot className="size-4" />} />
      <div className="space-y-2 px-4 pb-4 sm:px-5">
        <Segmented
          value={mode}
          onChange={(m) => setMode.mutate({ mode: m })}
          options={[
            { value: 'off', label: TICKET_MODE_LABEL.off },
            { value: 'draft', label: TICKET_MODE_LABEL.draft },
            { value: 'auto', label: TICKET_MODE_LABEL.auto },
          ]}
        />
        {mode === 'auto' && (
          <>
            <Toggle
              checked={t.autoOnlyInSchedule}
              onChange={(v) => setMode.mutate({ mode, autoOnlyInSchedule: v })}
              label={
                <span className="flex items-center gap-1.5">
                  <Moon className="size-4" /> Automat doar noaptea și în weekend
                </span>
              }
              description={`Între ${t.schedule.weekdayEnd} și ${t.schedule.weekdayStart}${t.schedule.weekendsAllDay ? ', plus sâmbăta și duminica toată ziua' : ''}. În rest, agentul pregătește ciorne.`}
            />
            {effective !== mode && <Notice tone="info">Acum ești în program, deci agentul face doar ciorne. Răspunsurile automate pornesc la {t.schedule.weekdayEnd}.</Notice>}
          </>
        )}
        <p className="text-xs text-ink-3">
          Semnătura și nota AI se adaugă automat. Escaladare obligatorie: bani, anulări și ștergeri, modificări pe cont, reclamații și aspecte legale.{' '}
          <Link href="/setari/tichete" className="underline">
            Reguli
          </Link>
        </p>
      </div>
    </Card>
  );
}

function JobRow({ j }: { j: TicketJobDTO }) {
  return (
    <Link href={`/tichete/${j.id}`} className="block border-t border-line px-4 py-3 first:border-t-0 hover:bg-surface-2/50 sm:px-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-display text-[16px] font-semibold">{j.subject ?? `Tichetul #${j.tid ?? j.ticketId}`}</span>
            <JobStatusBadge status={j.status} />
          </div>
          <div className="mt-0.5 text-[13px] text-ink-3">
            #{j.tid ?? j.ticketId} · {j.clientName ?? 'client'} {j.department ? `· ${j.department}` : ''} · {timeAgo(j.updatedAt)}
          </div>
          {j.summary && <p className="mt-1 line-clamp-2 text-[13px] text-ink-2">{j.summary}</p>}
          {j.escalationReasons.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {j.escalationReasons.map((r) => (
                <Badge key={r} tone="warning">
                  <AlertTriangle className="size-3" />
                  {ESCALATION_REASON_LABEL[r]}
                </Badge>
              ))}
            </div>
          )}
        </div>
        {j.urgency && j.urgency !== 'normal' && j.urgency !== 'low' && (
          <Badge tone={j.urgency === 'critical' ? 'critical' : 'warning'} className="shrink-0">
            {URGENCY_LABEL[j.urgency] ?? j.urgency}
          </Badge>
        )}
      </div>
    </Link>
  );
}

type Filter = 'attention' | 'all' | 'sent' | 'skipped';

export function TicketsPage() {
  const [filter, setFilter] = useState<Filter>('attention');
  const toast = useToast();
  const qc = useQueryClient();
  const summary = useQuery({ queryKey: ['tickets-summary'], queryFn: () => api.get<TicketSummary>('/api/tickets/summary') });
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['tickets', filter],
    queryFn: () => api.get<TicketJobDTO[]>(`/api/tickets${filter === 'all' ? '' : `?status=${filter}`}`),
  });
  const poll = useMutation({
    mutationFn: () => api.post<{ message: string; queued: number }>('/api/tickets/poll'),
    onSuccess: (r) => {
      toast(r.queued ? `${r.queued} tichete noi în lucru.` : r.message || 'Nimic nou.', 'good');
      qc.invalidateQueries({ queryKey: ['tickets'] });
    },
    onError: (err) => toast(errorText(err), 'critical'),
  });
  const c = summary.data?.counts ?? {};
  const attention = (c.draft_ready ?? 0) + (c.escalated ?? 0) + (c.error ?? 0);
  return (
    <Page>
      <PageHeader
        title="Tichete"
        subtitle="Tichetele de pe my.datix.ro: analiză, ciorne de răspuns și escaladări."
        actions={
          <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" />} loading={poll.isPending} onClick={() => poll.mutate()}>
            Verifică acum
          </Button>
        }
      />
      <ModeCard />
      <Tabs
        value={filter}
        onChange={setFilter}
        tabs={[
          { value: 'attention', label: 'De rezolvat', badge: attention },
          { value: 'all', label: 'Toate' },
          { value: 'sent', label: 'Trimise' },
          { value: 'skipped', label: 'Doar notificate' },
        ]}
      />
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} onRetry={() => refetch()} />
      ) : !data?.length ? (
        <Card>
          <EmptyState icon={<Inbox className="size-8" />} title={filter === 'attention' ? 'Nimic de rezolvat' : 'Niciun tichet'}>
            {filter === 'attention' ? 'Când un client deschide sau răspunde la un tichet, agentul îl analizează și îl pune aici dacă are nevoie de tine.' : null}
          </EmptyState>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {data.map((j) => (
            <JobRow key={j.id} j={j} />
          ))}
        </Card>
      )}
    </Page>
  );
}

// ------------------------------------------------------------------------------ detaliu

export function TicketDetailPage() {
  const [, params] = useRoute('/tichete/:id');
  const id = params?.id ?? '';
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const [guidance, setGuidance] = useState('');
  const [dirty, setDirty] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['ticket', id],
    queryFn: () => api.get<TicketDetailDTO>(`/api/tickets/${id}`),
    refetchInterval: (q) => (q.state.data && ['queued', 'analyzing'].includes(q.state.data.job.status) ? 4000 : false),
  });
  const job = data?.job;

  useEffect(() => {
    if (job && !dirty) setText(job.draft ?? '');
  }, [job?.draft, job, dirty]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['ticket', id] });
    qc.invalidateQueries({ queryKey: ['tickets'] });
    qc.invalidateQueries({ queryKey: ['tickets-summary'] });
    qc.invalidateQueries({ queryKey: ['status'] });
  };
  const send = useMutation({
    mutationFn: () => api.post<TicketJobDTO>(`/api/tickets/${id}/send`, { text }),
    onSuccess: () => {
      toast('Răspunsul a fost trimis clientului.', 'good');
      setDirty(false);
      refresh();
    },
    onError: (err) => toast(errorText(err), 'critical'),
  });
  const regenerate = useMutation({
    mutationFn: () => api.post(`/api/tickets/${id}/regenerate`, { guidance }),
    onSuccess: () => {
      toast('Agentul rescrie răspunsul…', 'info');
      setDirty(false);
      setGuidance('');
      refresh();
    },
    onError: (err) => toast(errorText(err), 'critical'),
  });
  const discard = useMutation({
    mutationFn: () => api.post(`/api/tickets/${id}/discard`),
    onSuccess: () => {
      toast('Ciorna a fost ignorată.', 'info');
      refresh();
    },
    onError: (err) => toast(errorText(err), 'critical'),
  });

  if (isLoading) return <Loading />;
  if (error || !data || !job)
    return (
      <Page>
        <ErrorBox error={error ?? 'Tichetul nu a fost găsit.'} onRetry={() => refetch()} />
      </Page>
    );

  const working = job.status === 'queued' || job.status === 'analyzing';
  const canReply = !working && job.status !== 'sent';
  return (
    <Page>
      <Link href="/tichete" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink">
        <ArrowLeft className="size-4" /> Tichete
      </Link>
      <PageHeader
        title={job.subject ?? `Tichetul #${job.tid ?? job.ticketId}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <JobStatusBadge status={job.status} />
            <span>
              #{job.tid ?? job.ticketId} · {job.clientName ?? 'client'}
              {job.department ? ` · ${job.department}` : ''}
            </span>
          </span>
        }
        actions={
          <>
            {job.conversationId && (
              <Link href={`/chat/${job.conversationId}`}>
                <Button size="sm" variant="secondary" icon={<MessageSquare className="size-4" />}>
                  Analiza agentului
                </Button>
              </Link>
            )}
            {data.whmcsUrl && (
              <a href={data.whmcsUrl} target="_blank" rel="noreferrer">
                <Button size="sm" variant="ghost" icon={<ExternalLink className="size-4" />}>
                  Deschide în WHMCS
                </Button>
              </a>
            )}
          </>
        }
      />

      {job.escalationReasons.length > 0 && (
        <div className="mb-4">
          <Notice tone="warning" icon={<AlertTriangle className="size-4 text-warning-ink" />}>
            <div className="font-medium">Necesită decizia ta</div>
            <ul className="mt-1 list-disc pl-4">
              {job.escalationReasons.map((r) => (
                <li key={r}>{ESCALATION_REASON_LABEL[r]}</li>
              ))}
            </ul>
          </Notice>
        </div>
      )}
      {job.error && (
        <div className="mb-4">
          <Notice tone="critical">{job.error}</Notice>
        </div>
      )}

      {working ? (
        <Card className="mb-5">
          <div className="flex items-center gap-3 px-5 py-5 text-sm text-ink-2">
            <Sparkles className="size-5 animate-pulse text-accent-fg" /> Agentul analizează tichetul și verifică problema…
          </div>
        </Card>
      ) : (
        (job.summary || job.analysis) && (
          <Card className="mb-5">
            <CardHeader
              title="Ce vrea clientul"
              icon={<Bot className="size-4" />}
              action={job.confidence != null ? <Badge tone={job.confidence >= 0.75 ? 'good' : 'warning'}>încredere {Math.round(job.confidence * 100)}%</Badge> : undefined}
            />
            <div className="space-y-3 px-4 pb-4 text-sm sm:px-5">
              {job.summary && <p>{job.summary}</p>}
              <div className="flex flex-wrap gap-1.5">
                {job.category && <Badge>{job.category}</Badge>}
                {job.urgency && <Badge tone={job.urgency === 'critical' ? 'critical' : job.urgency === 'high' ? 'warning' : 'neutral'}>urgență: {URGENCY_LABEL[job.urgency] ?? job.urgency}</Badge>}
                {job.sentiment && <Badge tone={job.sentiment === 'furios' || job.sentiment === 'frustrat' ? 'warning' : 'neutral'}>ton: {job.sentiment}</Badge>}
              </div>
              {job.analysis && (
                <details>
                  <summary className="cursor-pointer text-[13px] text-ink-3">Ce a verificat agentul</summary>
                  <div className="prose-chat mt-2">
                    <Markdown text={job.analysis} />
                  </div>
                </details>
              )}
            </div>
          </Card>
        )
      )}

      <Card className="mb-5">
        <CardHeader title="Conversația cu clientul" subtitle={`${data.thread.length} mesaje`} />
        <div className="space-y-3 px-4 pb-4 sm:px-5">
          {data.thread.map((m) => (
            <div key={m.id} className={clsx('rounded-2xl px-4 py-3', m.isStaff ? 'ml-6 bg-accent-soft' : 'mr-6 bg-surface-2')}>
              <div className="mb-1 flex items-center justify-between gap-2 text-xs text-ink-3">
                <span className="font-medium text-ink-2">{m.isStaff ? `${m.author} (echipa)` : m.author}</span>
                <span>{m.date}</span>
              </div>
              <div className="text-sm whitespace-pre-wrap break-words">{m.message}</div>
            </div>
          ))}
          {!data.thread.length && <p className="text-sm text-ink-3">Mesajele nu au putut fi încărcate din WHMCS.</p>}
        </div>
      </Card>

      {job.status === 'sent' && job.finalMessage && (
        <Card className="mb-5">
          <CardHeader title="Răspuns trimis" subtitle={job.sentAt ? dateTime(job.sentAt) : undefined} />
          <div className="px-4 pb-4 text-sm whitespace-pre-wrap sm:px-5">{job.finalMessage}</div>
        </Card>
      )}

      {canReply && (
        <Card>
          <CardHeader title={job.draft ? 'Răspunsul propus' : 'Răspunde'} subtitle="Poți edita textul. Semnătura „Echipa Datix” și nota AI se adaugă automat la trimitere." />
          <div className="space-y-3 px-4 pb-4 sm:px-5">
            <Textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setDirty(true);
              }}
              className="min-h-56"
              placeholder="Scrie răspunsul pentru client…"
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" icon={<Send className="size-4" />} loading={send.isPending} disabled={text.trim().length < 5} onClick={() => send.mutate()}>
                Trimite clientului
              </Button>
              {job.status !== 'discarded' && (
                <Button variant="ghost" icon={<Trash2 className="size-4" />} loading={discard.isPending} onClick={() => discard.mutate()}>
                  Ignoră
                </Button>
              )}
            </div>
            <div className="border-t border-line pt-3">
              <Field label="Rescrie cu indicații" hint="Ex.: „mai scurt”, „spune-i că am verificat și DNS-ul e corect”, „oferă-i o lună gratuită” (doar dacă tu decizi asta).">
                <div className="flex gap-2">
                  <Input value={guidance} onChange={(e) => setGuidance(e.target.value)} placeholder="Ce să schimbe agentul?" maxLength={2000} />
                  <Button variant="secondary" icon={<Sparkles className="size-4" />} loading={regenerate.isPending} onClick={() => regenerate.mutate()}>
                    Rescrie
                  </Button>
                </div>
              </Field>
            </div>
          </div>
        </Card>
      )}
    </Page>
  );
}
