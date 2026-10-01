import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useRoute, useSearch } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowUp, Bot, Square } from 'lucide-react';
import type { ApprovalDTO, ChatMessageDTO, ConversationDTO, SessionInfoDTO, ToolCallDTO } from '@datix/shared';
import { api, errorText } from '../lib/api';
import { useServerEvents } from '../lib/events';
import { useToast } from '../lib/toast';
import { Markdown } from '../components/Markdown';
import { ToolSteps } from '../components/ToolSteps';
import { ApprovalCard } from '../components/ApprovalCard';
import { Loading } from '../components/ui';

interface ConversationResponse {
  conversation: ConversationDTO;
  messages: ChatMessageDTO[];
  running: boolean;
  lastRun: { id: string; status: string; error: string | null; costUsd: number } | null;
  pendingApprovals: ApprovalDTO[];
}

interface LiveBubble {
  runId: string;
  ids: string[];
  content: string;
  toolCalls: ToolCallDTO[];
  thinking: boolean;
}

const SUGGESTIONS = ['Cum stau site-urile acum?', 'Verifică securitatea datix.ro și my.datix.ro', 'Ce tichete așteaptă răspuns?', 'Cum merg încasările luna aceasta?'];

function Thinking() {
  return (
    <span className="inline-flex items-center gap-1 text-sm text-ink-3">
      Gândește
      <span className="typing-dot">.</span>
      <span className="typing-dot">.</span>
      <span className="typing-dot">.</span>
    </span>
  );
}

function AssistantMessage({ content, toolCalls, live, thinking, approvals, error, onApprovalDecided }: {
  content: string;
  toolCalls: ToolCallDTO[];
  live?: boolean;
  thinking?: boolean;
  approvals: Map<string, ApprovalDTO>;
  error?: string | null;
  onApprovalDecided: (a: ApprovalDTO) => void;
}) {
  const pending = toolCalls.filter((c) => c.status === 'pending_approval' && c.approvalId && approvals.get(c.approvalId)?.status === 'pending');
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
        <Bot className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <ToolSteps calls={toolCalls} live={live} />
        {content ? <Markdown text={content} /> : live && thinking ? <Thinking /> : live && !toolCalls.length ? <Thinking /> : null}
        {pending.map((c) => (
          <div key={c.id} className="mt-3">
            <ApprovalCard approval={approvals.get(c.approvalId!)!} onDecided={onApprovalDecided} compact />
          </div>
        ))}
        {error && <p className="mt-2 text-sm text-critical-ink">⚠️ {error}</p>}
      </div>
    </div>
  );
}

export function ChatPage() {
  const [, params] = useRoute('/chat/:id');
  const id = params?.id ?? null;
  const [, navigate] = useLocation();
  const search = useSearch();
  const qc = useQueryClient();
  const toast = useToast();
  const session = qc.getQueryData<SessionInfoDTO>(['session']);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [live, setLive] = useState<LiveBubble | null>(null);
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<Map<string, ApprovalDTO>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);

  const conv = useQuery({
    queryKey: ['conversation', id],
    queryFn: () => api.get<ConversationResponse>(`/api/conversations/${id}`),
    enabled: !!id,
  });

  // aprobările cunoscute (din conversație + evenimente live)
  useEffect(() => {
    if (!conv.data) return;
    setApprovals((prev) => {
      const next = new Map(prev);
      for (const a of conv.data.pendingApprovals) next.set(a.id, a);
      return next;
    });
  }, [conv.data]);

  // la schimbarea conversației resetăm starea live
  useEffect(() => {
    setLive(null);
    setOptimistic(null);
    stickToBottom.current = true;
  }, [id]);

  useServerEvents(
    (e) => {
      if (e.type === 'approval') {
        setApprovals((prev) => new Map(prev).set(e.approval.id, e.approval));
        return;
      }
      if (e.type !== 'chat' || e.conversationId !== id) return;
      const ev = e.event;
      switch (ev.type) {
        case 'run_started':
          setLive({ runId: ev.runId, ids: [ev.messageId], content: '', toolCalls: [], thinking: true });
          break;
        case 'thinking':
          setLive((l) => (l ? { ...l, thinking: ev.active } : l));
          break;
        case 'text_delta':
          setLive((l) => {
            if (!l) return l;
            const fresh = !l.ids.includes(ev.messageId);
            return { ...l, ids: fresh ? [...l.ids, ev.messageId] : l.ids, content: (fresh && l.content ? `${l.content}\n\n` : l.content) + ev.delta, thinking: false };
          });
          break;
        case 'tool_call':
          setLive((l) => {
            if (!l) return l;
            const exists = l.toolCalls.some((c) => c.id === ev.call.id);
            return { ...l, toolCalls: exists ? l.toolCalls.map((c) => (c.id === ev.call.id ? { ...c, ...ev.call } : c)) : [...l.toolCalls, ev.call] };
          });
          break;
        case 'tool_result':
          setLive((l) => (l ? { ...l, toolCalls: l.toolCalls.map((c) => (c.id === ev.callId ? { ...c, status: ev.status, resultPreview: ev.resultPreview } : c)) } : l));
          break;
        case 'approval_required':
          setApprovals((prev) => new Map(prev).set(ev.approval.id, ev.approval));
          break;
        case 'run_finished':
          void qc.invalidateQueries({ queryKey: ['conversation', id] }).then(() => {
            setLive(null);
            setOptimistic(null);
          });
          if (ev.status === 'error' && ev.error) toast(ev.error, 'critical');
          break;
        case 'title':
          qc.invalidateQueries({ queryKey: ['conversations'] });
          break;
      }
    },
    [id],
  );

  const running = !!live || !!conv.data?.running;
  const messages = conv.data?.messages ?? [];

  // derulare automată (doar dacă utilizatorul e deja jos)
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, live?.content, live?.toolCalls.length, optimistic]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const autoresize = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  };
  useEffect(autoresize, [text]);

  // mesaj pregătit din alte ecrane (ex. „Cere agentului să rezolve” din Securitate): /?q=...
  useEffect(() => {
    const q = new URLSearchParams(search).get('q');
    if (!q) return;
    setText(q.slice(0, 4000));
    navigate(id ? `/chat/${id}` : '/', { replace: true });
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [search, id, navigate]);

  const send = useCallback(
    async (value?: string) => {
      const message = (value ?? text).trim();
      if (!message || sending) return;
      setSending(true);
      setOptimistic(message);
      setText('');
      stickToBottom.current = true;
      try {
        let convId = id;
        if (!convId) {
          const c = await api.post<ConversationDTO>('/api/conversations', {});
          convId = c.id;
          qc.setQueryData(['conversation', convId], { conversation: c, messages: [], running: false, lastRun: null, pendingApprovals: [] } satisfies ConversationResponse);
          navigate(`/chat/${convId}`);
        }
        await api.post(`/api/conversations/${convId}/messages`, { text: message });
        void qc.invalidateQueries({ queryKey: ['conversation', convId] });
        void qc.invalidateQueries({ queryKey: ['conversations'] });
      } catch (err) {
        setOptimistic(null);
        setText(message);
        toast(errorText(err), 'critical');
      } finally {
        setSending(false);
      }
    },
    [id, navigate, qc, sending, text, toast],
  );

  const stop = async () => {
    if (!id) return;
    await api.post(`/api/conversations/${id}/cancel`).catch(() => undefined);
  };

  const onApprovalDecided = (a: ApprovalDTO) => {
    setApprovals((prev) => new Map(prev).set(a.id, a));
    void qc.invalidateQueries({ queryKey: ['conversation', id] });
  };

  // mesajul optimist dispare când apare în istoric
  const showOptimistic = optimistic && !messages.some((m) => m.role === 'user' && m.content === optimistic && Date.now() - m.createdAt < 120_000);
  const isTouch = useMemo(() => window.matchMedia('(pointer: coarse)').matches, []);
  const empty = !id && !optimistic;
  const firstName = session?.displayName?.split(' ')[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {empty ? (
          <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-5 pb-10 text-center">
            <img src="/icons/favicon.svg" alt="" className="mb-4 size-12 rounded-2xl" />
            <h1 className="text-2xl font-semibold tracking-tight">{firstName ? `Bună, ${firstName}!` : 'Bună!'}</h1>
            <p className="mt-2 text-ink-2">Cu ce te ajut azi? Pot verifica site-urile, securitatea, tichetele sau cifrele de business — și pot repara ce s-a stricat.</p>
            <div className="mt-6 grid w-full gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => void send(s)} className="rounded-2xl border border-line bg-surface px-4 py-3 text-left text-sm text-ink-2 transition-colors hover:border-line-strong hover:text-ink">
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
            {conv.isLoading && <Loading />}
            {messages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-3xl rounded-br-lg bg-surface-2 px-4 py-2.5 whitespace-pre-wrap">{m.content}</div>
                </div>
              ) : m.role === 'system_note' ? (
                <div key={m.id} className="text-center text-xs text-ink-3">
                  {m.content}
                </div>
              ) : (
                <AssistantMessage key={m.id} content={m.content} toolCalls={m.toolCalls} approvals={approvals} error={m.error} onApprovalDecided={onApprovalDecided} />
              ),
            )}
            {showOptimistic && (
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-3xl rounded-br-lg bg-surface-2 px-4 py-2.5 whitespace-pre-wrap">{optimistic}</div>
              </div>
            )}
            {(live || (running && !live) || (sending && !live)) && (
              <AssistantMessage content={live?.content ?? ''} toolCalls={live?.toolCalls ?? []} live thinking={live?.thinking ?? true} approvals={approvals} onApprovalDecided={onApprovalDecided} />
            )}
          </div>
        )}
      </div>

      {/* compunere mesaj */}
      <div className="safe-bottom border-t border-line bg-page/95 backdrop-blur lg:border-0 lg:bg-transparent">
        <div className="mx-auto max-w-3xl px-3 pt-2 pb-3 sm:px-6 sm:pb-5">
          <div className={clsx('flex items-end gap-2 rounded-3xl border bg-surface p-2 pl-4 shadow-sm transition-colors', 'border-line focus-within:border-line-strong')}>
            <textarea
              ref={textareaRef}
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !isTouch && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={running ? 'Agentul lucrează… poți scrie următorul mesaj' : 'Scrie un mesaj pentru agent…'}
              className="max-h-[220px] min-h-[40px] flex-1 resize-none bg-transparent py-2 leading-6 outline-none placeholder:text-ink-3"
            />
            {running ? (
              <button onClick={stop} className="flex size-10 shrink-0 items-center justify-center rounded-full bg-ink text-page" aria-label="Oprește">
                <Square className="size-4" fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={() => void send()}
                disabled={!text.trim() || sending}
                className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-opacity disabled:opacity-30"
                aria-label="Trimite"
              >
                <ArrowUp className="size-5" />
              </button>
            )}
          </div>
          <p className="mt-1.5 hidden text-center text-[11px] text-ink-3 sm:block">Agentul poate greși — acțiunile riscante îți cer întotdeauna aprobarea.</p>
        </div>
      </div>
    </div>
  );
}
