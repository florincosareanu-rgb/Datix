import type { ChatMessageDTO, ConversationDTO, ToolCallDTO } from '@datix/shared';
import type { DB } from '../db';
import type { LlmMessage, LlmToolCall } from '../llm/types';
import { newId } from '../util/ids';
import { safeJsonParse } from '../util/text';

export interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'system_note';
  content: string | null;
  reasoning: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  meta: string | null;
  created_at: number;
}

export interface ToolRowMeta {
  status: 'done' | 'error' | 'rejected';
  preview: string | null;
  approvalId?: string | null;
}

interface ConversationRow {
  id: string;
  title: string;
  kind: ConversationDTO['kind'];
  ref_id: string | null;
  created_at: number;
  updated_at: number;
  pinned: number;
  archived: number;
}

const toConversationDTO = (r: ConversationRow): ConversationDTO => ({
  id: r.id,
  title: r.title,
  kind: r.kind,
  refId: r.ref_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  pinned: r.pinned === 1,
});

export class ConversationStore {
  constructor(private readonly db: DB) {}

  create(kind: ConversationDTO['kind'] = 'chat', title = 'Conversație nouă', refId: string | null = null): string {
    const id = newId('c_');
    const now = Date.now();
    this.db.prepare('INSERT INTO conversations (id, title, kind, ref_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, title.slice(0, 120), kind, refId, now, now);
    return id;
  }

  get(id: string): ConversationDTO | null {
    const r = this.db.prepare('SELECT * FROM conversations WHERE id = ? AND archived = 0').get(id) as ConversationRow | undefined;
    return r ? toConversationDTO(r) : null;
  }

  list(opts: { kind?: string; limit?: number; search?: string } = {}): ConversationDTO[] {
    const where = ['archived = 0'];
    const params: unknown[] = [];
    if (opts.kind) {
      where.push('kind = ?');
      params.push(opts.kind);
    }
    if (opts.search) {
      where.push('title LIKE ?');
      params.push(`%${opts.search}%`);
    }
    const rows = this.db
      .prepare(`SELECT * FROM conversations WHERE ${where.join(' AND ')} ORDER BY pinned DESC, updated_at DESC LIMIT ?`)
      .all(...params, Math.min(opts.limit ?? 100, 500)) as ConversationRow[];
    return rows.map(toConversationDTO);
  }

  rename(id: string, title: string): void {
    this.db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title.trim().slice(0, 120) || 'Conversație', id);
  }

  setPinned(id: string, pinned: boolean): void {
    this.db.prepare('UPDATE conversations SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
  }

  archive(id: string): void {
    this.db.prepare('UPDATE conversations SET archived = 1 WHERE id = ?').run(id);
  }

  touch(id: string): void {
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  append(msg: {
    id?: string;
    conversationId: string;
    role: MessageRow['role'];
    content?: string | null;
    reasoning?: string | null;
    toolCalls?: LlmToolCall[] | null;
    toolCallId?: string | null;
    toolName?: string | null;
    meta?: unknown;
  }): string {
    const id = msg.id ?? newId('m_');
    const seq = ((this.db.prepare('SELECT MAX(seq) s FROM messages WHERE conversation_id = ?').get(msg.conversationId) as { s: number | null }).s ?? 0) + 1;
    this.db
      .prepare(
        'INSERT INTO messages (id, conversation_id, seq, role, content, reasoning, tool_calls, tool_call_id, tool_name, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        msg.conversationId,
        seq,
        msg.role,
        msg.content ?? null,
        msg.reasoning ?? null,
        msg.toolCalls?.length ? JSON.stringify(msg.toolCalls) : null,
        msg.toolCallId ?? null,
        msg.toolName ?? null,
        msg.meta === undefined ? null : JSON.stringify(msg.meta),
        Date.now(),
      );
    this.touch(msg.conversationId);
    return id;
  }

  rows(conversationId: string): MessageRow[] {
    return this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq').all(conversationId) as MessageRow[];
  }

  messageCount(conversationId: string): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND role IN ('user','assistant')").get(conversationId) as { n: number }).n;
  }

  hasToolResult(conversationId: string, toolCallId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND role = 'tool' AND tool_call_id = ?").get(conversationId, toolCallId);
  }

  /** Apelurile de unelte din ultimul mesaj al asistentului care nu au încă rezultat. */
  pendingToolCalls(conversationId: string): LlmToolCall[] {
    const rows = this.rows(conversationId);
    const lastAssistant = [...rows].reverse().find((r) => r.role === 'assistant');
    if (!lastAssistant?.tool_calls) return [];
    const calls = safeJsonParse<LlmToolCall[]>(lastAssistant.tool_calls, []);
    const done = new Set(rows.filter((r) => r.role === 'tool' && r.seq > lastAssistant.seq).map((r) => r.tool_call_id));
    return calls.filter((c) => !done.has(c.id));
  }

  /** Istoricul în formatul cerut de modelul AI. */
  toLlmMessages(conversationId: string): LlmMessage[] {
    const out: LlmMessage[] = [];
    for (const r of this.rows(conversationId)) {
      if (r.role === 'user') out.push({ role: 'user', content: r.content ?? '' });
      else if (r.role === 'assistant') {
        const calls = safeJsonParse<LlmToolCall[]>(r.tool_calls, []);
        out.push({ role: 'assistant', content: r.content ?? '', reasoning_content: r.reasoning ?? '', ...(calls.length ? { tool_calls: calls } : {}) });
      } else if (r.role === 'tool') out.push({ role: 'tool', tool_call_id: r.tool_call_id ?? '', content: r.content ?? '' });
    }
    return out;
  }

  /** Mesajele pentru interfață (apelurile de unelte sunt atașate mesajului asistentului). */
  toDTO(conversationId: string, labelFor: (toolName: string) => string, approvalFor: (toolCallId: string) => { id: string; status: string } | null): ChatMessageDTO[] {
    const rows = this.rows(conversationId);
    const toolResults = new Map<string, { meta: ToolRowMeta }>();
    for (const r of rows) {
      if (r.role === 'tool' && r.tool_call_id) toolResults.set(r.tool_call_id, { meta: safeJsonParse<ToolRowMeta>(r.meta, { status: 'done', preview: null }) });
    }
    const out: ChatMessageDTO[] = [];
    for (const r of rows) {
      if (r.role === 'user') out.push({ id: r.id, role: 'user', content: r.content ?? '', toolCalls: [], createdAt: r.created_at });
      else if (r.role === 'system_note') out.push({ id: r.id, role: 'system_note', content: r.content ?? '', toolCalls: [], createdAt: r.created_at });
      else if (r.role === 'assistant') {
        const meta = safeJsonParse<{ error?: string }>(r.meta, {});
        const calls = safeJsonParse<LlmToolCall[]>(r.tool_calls, []);
        const toolCalls: ToolCallDTO[] = calls.map((c) => {
          const res = toolResults.get(c.id);
          const approval = approvalFor(c.id);
          let status: ToolCallDTO['status'] = 'running';
          if (res) status = res.meta.status === 'error' ? 'error' : res.meta.status === 'rejected' ? 'rejected' : 'done';
          else if (approval && approval.status === 'pending') status = 'pending_approval';
          else if (approval && approval.status === 'rejected') status = 'rejected';
          return {
            id: c.id,
            name: c.function.name,
            label: labelFor(c.function.name),
            args: safeJsonParse<Record<string, unknown>>(c.function.arguments, {}),
            status,
            resultPreview: res?.meta.preview ?? null,
            approvalId: approval?.id ?? res?.meta.approvalId ?? null,
          };
        });
        // contopim mesajele consecutive ale asistentului (pași ai aceleiași rulări) într-un singur balon
        const prev = out[out.length - 1];
        if (prev && prev.role === 'assistant') {
          prev.content = [prev.content, r.content ?? ''].filter((x) => x.trim()).join('\n\n');
          prev.toolCalls.push(...toolCalls);
          if (meta.error) prev.error = meta.error;
        } else {
          out.push({ id: r.id, role: 'assistant', content: r.content ?? '', toolCalls, createdAt: r.created_at, error: meta.error ?? null });
        }
      }
    }
    return out;
  }
}
