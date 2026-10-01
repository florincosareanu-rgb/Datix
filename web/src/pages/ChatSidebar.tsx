import { useState } from 'react';
import { Link, useLocation, useRoute } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { MessageSquarePlus, Pin, Search, Siren, Ticket, Trash2 } from 'lucide-react';
import type { ConversationDTO } from '@datix/shared';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';

type Filter = 'chat' | 'incident' | 'ticket';

export function ConversationList({ onNavigate }: { onNavigate?: () => void }) {
  const [filter, setFilter] = useState<Filter>('chat');
  const [q, setQ] = useState('');
  const [, params] = useRoute('/chat/:id');
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['conversations', filter, q],
    queryFn: () => api.get<ConversationDTO[]>(`/api/conversations?kind=${filter}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/conversations/${id}`),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      if (params?.id === id) navigate('/');
    },
  });
  const pin = useMutation({
    mutationFn: (c: ConversationDTO) => api.patch(`/api/conversations/${c.id}`, { pinned: !c.pinned }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conversations'] }),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3">
        <Link
          href="/"
          onClick={onNavigate}
          className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-2"
        >
          <MessageSquarePlus className="size-4" /> Conversație nouă
        </Link>
        <div className="mt-2 flex gap-1 rounded-xl bg-surface-2 p-1 text-[12.5px]">
          {(
            [
              ['chat', 'Chat'],
              ['incident', 'Incidente'],
              ['ticket', 'Tichete'],
            ] as Array<[Filter, string]>
          ).map(([v, label]) => (
            <button key={v} onClick={() => setFilter(v)} className={clsx('flex-1 rounded-lg py-1 font-medium', filter === v ? 'bg-surface text-ink shadow-sm' : 'text-ink-3')}>
              {label}
            </button>
          ))}
        </div>
        <div className="relative mt-2">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Caută…" className="h-8 w-full rounded-lg border border-line bg-surface pr-2 pl-8 text-[13px] outline-none focus:border-accent" style={{ fontSize: 13 }} />
        </div>
      </div>
      <ul className="scrollbar-thin mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {data?.length === 0 && <li className="px-3 py-6 text-center text-xs text-ink-3">{filter === 'chat' ? 'Nicio conversație încă.' : 'Nimic aici încă.'}</li>}
        {data?.map((c) => (
          <li key={c.id} className="group relative">
            <Link
              href={`/chat/${c.id}`}
              onClick={onNavigate}
              className={clsx('flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13.5px]', params?.id === c.id ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:bg-surface-2/60')}
            >
              {c.kind === 'incident' ? <Siren className="size-3.5 shrink-0 text-ink-3" /> : c.kind === 'ticket' ? <Ticket className="size-3.5 shrink-0 text-ink-3" /> : c.pinned ? <Pin className="size-3.5 shrink-0 text-ink-3" /> : null}
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
              <span className="shrink-0 text-[11px] text-ink-3 group-hover:hidden">{timeAgo(c.updatedAt).replace('acum ', '')}</span>
            </Link>
            <div className="absolute top-1/2 right-1 hidden -translate-y-1/2 gap-0.5 group-hover:flex">
              <button onClick={() => pin.mutate(c)} className="rounded-md p-1 text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={c.pinned ? 'Anulează fixarea' : 'Fixează'}>
                <Pin className="size-3.5" />
              </button>
              <button
                onClick={() => {
                  if (confirm('Ștergi conversația?')) remove.mutate(c.id);
                }}
                className="rounded-md p-1 text-ink-3 hover:bg-surface-3 hover:text-critical"
                aria-label="Șterge"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
