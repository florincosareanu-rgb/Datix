import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useRoute, useSearch } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Activity, ArrowUp, BarChart3, ShieldCheck, Square, Ticket } from 'lucide-react';
import type { ApprovalDTO, ChatMessageDTO, ConversationDTO, SessionInfoDTO, ToolCallDTO } from '@datix/shared';
import { api, errorText } from '../lib/api';
import { useServerEvents } from '../lib/events';
import { useToast } from '../lib/toast';
import { Markdown } from '../components/Markdown';
import { ToolSteps } from '../components/ToolSteps';
import { ApprovalCard } from '../components/ApprovalCard';
import { Loading } from '../components/ui';
import { DaxOrb } from '../components/brand';

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

const SUGGESTIONS = [
  { text: 'Cum stau site-urile acum?', hint: 'Disponibilitate, viteză, SSL', icon: Activity },
  { text: 'Verifică securitatea datix.ro și my.datix.ro', hint: 'WordPress, WHMCS, Cloudflare', icon: ShieldCheck },
  { text: 'Ce tichete așteaptă răspuns?', hint: 'Analiză și ciorne de răspuns', icon: Ticket },
  { text: 'Cum merg încasările luna aceasta?', hint: 'Cifre din WHMCS', icon: BarChart3 },
];

function Thinking() {
  return (
    <span className="inline-flex items-center gap-2 py-1 text-[15px] text-ink-2" role="status">
      <span className="flex items-center gap-1" aria-hidden>
        <span className="typing-dot size-1.5 rounded-full bg-accent-fg" />
        <span className="typing-dot size-1.5 rounded-full bg-accent-fg" />
        <span className="typing-dot size-1.5 rounded-full bg-accent-fg" />
      </span>
      DAX gândește
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
      <DaxOrb size={28} active={live} className="mt-0.5" />
      <div className="min-w-0 flex-1 text-[16px]">
        <ToolSteps calls={toolCalls} live={live} />
        {content ? <Markdown text={content} /> : live && thinking ? <Thinking /> : live && !toolCalls.length ? <Thinking /> : null}
        {pending.map((c) => (
          <div key={c.id} className="mt-3">
            <ApprovalCard approval={approvals.get(c.approvalId!)!} onDecided={onApprovalDecided} compact />
          </div>
        ))}
        {error && <p className="mt-2 rounded-xl bg-critical-soft px-3 py-2 text-[14px] text-critical-ink" role="alert">{error}</p>}
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

  // derulare automată (doar dacă utilizatorul e deja jos; ecranul de start rămâne sus, cu salutul vizibil)
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current && (id || optimistic)) el.scrollTop = el.scrollHeight;
  }, [id, messages.length, live?.content, live?.toolCalls.length, optimistic]);

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
          <div className="enter mx-auto flex min-h-full max-w-2xl flex-col px-5 py-6 sm:py-10">
            <div className="my-auto flex flex-col items-center text-center">
              <DaxOrb size={76} glow className="mb-5 sm:mb-7" />
              <h1 className="font-display text-[30px] leading-tight font-semibold tracking-tight sm:text-[38px]">
                {firstName ? (
                  <>
                    Bună, <span className="text-brand">{firstName}</span>
                  </>
                ) : (
                  'Bună!'
                )}
              </h1>
              <p className="mt-3 max-w-md text-[16px] text-ink-2">Sunt DAX. Verific site-urile, securitatea, tichetele și cifrele de business — și repar ce s-a stricat.</p>
              <div className="enter-stagger mt-6 grid w-full gap-3 sm:mt-8 sm:grid-cols-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.text}
                    onClick={() => void send(s.text)}
                    className="pressable card-shadow group flex items-center gap-3.5 rounded-3xl border border-line/80 bg-surface p-3.5 text-left hover:border-accent/30 sm:p-4"
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent-fg transition-colors group-hover:bg-accent group-hover:text-white" aria-hidden>
                      <s.icon className="size-5" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[15px] leading-snug font-medium text-ink">{s.text}</span>
                      <span className="mt-0.5 block text-[13px] text-ink-3">{s.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-7 px-4 py-6 sm:px-6 sm:py-8">
            {conv.isLoading && <Loading />}
            {messages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-[22px] rounded-br-md bg-accent-soft px-4 py-2.5 text-[16px] whitespace-pre-wrap text-ink">{m.content}</div>
                </div>
              ) : m.role === 'system_note' ? (
                <div key={m.id} className="text-center text-[13px] text-ink-3">
                  {m.content}
                </div>
              ) : (
                <AssistantMessage key={m.id} content={m.content} toolCalls={m.toolCalls} approvals={approvals} error={m.error} onApprovalDecided={onApprovalDecided} />
              ),
            )}
            {showOptimistic && (
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-[22px] rounded-br-md bg-accent-soft px-4 py-2.5 text-[16px] whitespace-pre-wrap text-ink">{optimistic}</div>
              </div>
            )}
            {(live || (running && !live) || (sending && !live)) && (
              <AssistantMessage content={live?.content ?? ''} toolCalls={live?.toolCalls ?? []} live thinking={live?.thinking ?? true} approvals={approvals} onApprovalDecided={onApprovalDecided} />
            )}
          </div>
        )}
      </div>

      {/* compunere mesaj: plutitor, din sticlă */}
      <div className="safe-bottom px-3 pb-3 sm:px-6 sm:pb-5">
        <div className="mx-auto max-w-3xl">
          <div className="glass float-shadow flex items-end gap-2 rounded-[28px] border border-line/80 p-2 pl-5 transition-[border-color,box-shadow] duration-200 focus-within:border-accent/50 focus-within:shadow-[0_0_0_4px_rgb(124_58_237/0.12),var(--float-shadow)]">
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
              aria-label="Mesaj pentru DAX"
              placeholder={running ? 'DAX lucrează… poți scrie următorul mesaj' : 'Scrie-i lui DAX…'}
              className="max-h-[220px] min-h-[44px] flex-1 resize-none bg-transparent py-2.5 leading-6 outline-none placeholder:text-ink-3"
            />
            {running ? (
              <button onClick={stop} className="pressable flex size-11 shrink-0 items-center justify-center rounded-full bg-ink text-page" aria-label="Oprește">
                <Square className="size-4" fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={() => void send()}
                disabled={!text.trim() || sending}
                className="pressable flex size-11 shrink-0 items-center justify-center rounded-full bg-brand text-white shadow-[0_8px_20px_-8px_rgb(124_58_237/0.8)] disabled:bg-none disabled:bg-surface-3 disabled:text-ink-3 disabled:shadow-none"
                aria-label="Trimite"
              >
                <ArrowUp className="size-5" />
              </button>
            )}
          </div>
          <p className="mt-2 hidden text-center text-[12px] text-ink-3 sm:block">DAX poate greși — acțiunile riscante îți cer întotdeauna aprobarea.</p>
        </div>
      </div>
    </div>
  );
}
