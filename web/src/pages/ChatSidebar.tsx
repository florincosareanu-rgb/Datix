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
          className="pressable flex h-11 items-center justify-center gap-2 rounded-full bg-ink px-4 text-[15px] font-medium text-page hover:opacity-90"
        >
          <MessageSquarePlus className="size-[18px]" aria-hidden /> Conversație nouă
        </Link>
        <div className="mt-3 flex gap-1 rounded-full bg-surface-2 p-1 text-[13px]">
          {(
            [
              ['chat', 'Chat'],
              ['incident', 'Incidente'],
              ['ticket', 'Tichete'],
            ] as Array<[Filter, string]>
          ).map(([v, label]) => (
            <button key={v} onClick={() => setFilter(v)} className={clsx('pressable h-8 flex-1 rounded-full font-medium pointer-coarse:h-11', filter === v ? 'bg-surface text-ink shadow-[0_1px_3px_rgb(14_17_32/0.12)]' : 'text-ink-2 hover:text-ink')}>
              {label}
            </button>
          ))}
        </div>
        <div className="relative mt-2">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Caută în conversații"
            aria-label="Caută în conversații"
            className="h-10 w-full rounded-full border border-transparent bg-surface-2 pointer-coarse:h-11 pr-3 pl-10 outline-none transition-colors focus:border-accent focus:bg-surface focus:ring-4 focus:ring-accent/15"
          />
        </div>
      </div>
      <ul className="scrollbar-thin mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {data?.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-ink-3">{filter === 'chat' ? 'Nicio conversație încă.' : 'Nimic aici încă.'}</li>}
        {data?.map((c) => (
          <li key={c.id} className="group relative">
            <Link
              href={`/chat/${c.id}`}
              onClick={onNavigate}
              className={clsx('flex min-h-11 items-center gap-2.5 rounded-xl px-3 py-2 text-[14.5px] transition-colors', params?.id === c.id ? 'bg-accent-soft font-medium text-accent-fg' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}
            >
              {c.kind === 'incident' ? <Siren className="size-3.5 shrink-0 text-ink-3" /> : c.kind === 'ticket' ? <Ticket className="size-3.5 shrink-0 text-ink-3" /> : c.pinned ? <Pin className="size-3.5 shrink-0 text-ink-3" /> : null}
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
              <span className="shrink-0 text-[12px] text-ink-3 group-hover:hidden">{timeAgo(c.updatedAt).replace('acum ', '')}</span>
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
