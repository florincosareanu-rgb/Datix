import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Archive, ScrollText } from 'lucide-react';
import type { AuditEntryDTO } from '@datix/shared';
import { api } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { Badge, Button, Card, CardHeader, Segmented } from '../../components/ui';

const ACTOR: Record<AuditEntryDTO['actor'], { label: string; tone: 'accent' | 'neutral' | 'warning' }> = {
  owner: { label: 'Tu', tone: 'accent' },
  agent: { label: 'Agent', tone: 'warning' },
  system: { label: 'Sistem', tone: 'neutral' },
};

interface FileBackup {
  id: string;
  target: string;
  path: string;
  sizeBytes: number;
  reason: string | null;
  createdAt: number;
}

function Audit() {
  const [actor, setActor] = useState<'all' | AuditEntryDTO['actor']>('all');
  const q = useInfiniteQuery({
    queryKey: ['audit', actor],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.get<AuditEntryDTO[]>(`/api/audit?limit=100${pageParam ? `&before=${pageParam}` : ''}${actor !== 'all' ? `&actor=${actor}` : ''}`),
    getNextPageParam: (last) => (last.length === 100 ? last[last.length - 1]!.id : undefined),
  });
  const rows = q.data?.pages.flat() ?? [];
  return (
    <Card className="mb-5">
      <CardHeader title="Jurnal de activitate" subtitle="Tot ce faci tu și tot ce face agentul, înregistrat. Nu se poate modifica din aplicație." icon={<ScrollText className="size-4" />} />
      <div className="px-4 pb-2 sm:px-5">
        <Segmented
          size="sm"
          value={actor}
          onChange={setActor}
          options={[
            { value: 'all', label: 'Toate' },
            { value: 'agent', label: 'Agent' },
            { value: 'owner', label: 'Tu' },
            { value: 'system', label: 'Sistem' },
          ]}
        />
      </div>
      <ul className="px-2 pb-2">
        {rows.map((e) => (
          <li key={e.id} className="rounded-xl px-2 py-2 hover:bg-surface-2/50">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={ACTOR[e.actor].tone}>{ACTOR[e.actor].label}</Badge>
              <span className="font-mono text-[12.5px]">{e.action}</span>
              {e.target && <span className="truncate text-ink-2">{e.target}</span>}
              {e.result && e.result !== 'ok' && <Badge tone="critical">{e.result}</Badge>}
              <span className="ml-auto text-xs text-ink-3">{dateTime(e.at)}</span>
            </div>
            {e.details && <p className="mt-0.5 line-clamp-2 text-xs break-all text-ink-3">{e.details}</p>}
          </li>
        ))}
      </ul>
      {q.hasNextPage && (
        <div className="px-4 pb-4 sm:px-5">
          <Button size="sm" variant="secondary" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
            Încarcă mai multe
          </Button>
        </div>
      )}
    </Card>
  );
}

function Backups() {
  const { data } = useQuery({ queryKey: ['file-backups'], queryFn: () => api.get<FileBackup[]>('/api/file-backups') });
  return (
    <Card>
      <CardHeader
        title="Copii de siguranță ale fișierelor"
        subtitle="Înainte să modifice un fișier pe hosting, agentul îi salvează o copie aici. Îi poți cere în chat să o restaureze."
        icon={<Archive className="size-4" />}
      />
      {data && !data.length ? (
        <p className="px-4 pb-4 text-sm text-ink-3 sm:px-5">Agentul nu a modificat încă niciun fișier.</p>
      ) : (
        <ul className="px-2 pb-2">
          {data?.map((b) => (
            <li key={b.id} className="rounded-xl px-2 py-2">
              <div className="truncate font-mono text-[12.5px]">{b.path}</div>
              <div className="text-xs text-ink-3">
                {dateTime(b.createdAt)} · {(b.sizeBytes / 1024).toFixed(1).replace('.', ',')} KB{b.reason ? ` · ${b.reason}` : ''} · ID {b.id}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function JournalTab() {
  return (
    <>
      <Audit />
      <Backups />
    </>
  );
}
