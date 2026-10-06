import type { AgentContext, ToolCallDTO } from '@datix/shared';
import type { Services } from '../services';
import type { LlmMessage, LlmToolCall, LlmToolSpec } from '../llm/types';
import { LlmError } from '../llm/types';
import { decide, type PolicyExtras } from './policy';
import { systemPrompt } from './prompts';
import { getTool, toolsFor } from './tools';
import { toJsonSchema, ToolFailure, type AnyTool } from './tools/types';
import { fenceUntrusted, redactSensitive } from './redact';
import { newId } from '../util/ids';
import { errorMessage, safeJsonParse, truncate } from '../util/text';
import type { ToolRowMeta } from './conversations';

export interface RunOptions {
  conversationId: string;
  context: AgentContext;
  trigger: string;
  model?: string;
}

export interface RunRow {
  id: string;
  conversation_id: string;
  context: AgentContext;
  status: 'running' | 'waiting_approval' | 'done' | 'error' | 'cancelled';
  trigger: string | null;
  model: string | null;
  started_at: number;
  finished_at: number | null;
  steps: number;
  cost_usd: number;
  error: string | null;
}

export interface RunOutcome {
  runId: string;
  status: RunRow['status'];
  error?: string;
  finalText: string;
  outcomes: Record<string, unknown>;
  costUsd: number;
}

const MAX_TOOL_RESULT_CHARS = 14_000;

function toolTimeout(name: string): number {
  if (/pagespeed|run_updates|security_audit|wp_check_vulnerabilities|security_scan/.test(name)) return 200_000;
  return 90_000;
}

export class BusyError extends Error {}

/** Motorul agentului: bucla model → unelte → model, cu aprobări, persistență și evenimente live. */
export class AgentRunner {
  private readonly active = new Map<string, AbortController>();
  private readonly outcomes = new Map<string, Record<string, unknown>>();

  constructor(private readonly s: Services) {}

  isRunning(conversationId: string): boolean {
    return this.active.has(conversationId);
  }

  cancel(conversationId: string): boolean {
    const c = this.active.get(conversationId);
    if (!c) return false;
    c.abort();
    return true;
  }

  setOutcome(runId: string, key: string, value: unknown): void {
    const o = this.outcomes.get(runId) ?? {};
    o[key] = value;
    this.outcomes.set(runId, o);
  }

  getRun(runId: string): RunRow | null {
    return (this.s.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId) as RunRow | undefined) ?? null;
  }

  lastRunFor(conversationId: string): RunRow | null {
    return (this.s.db.prepare('SELECT * FROM agent_runs WHERE conversation_id = ? ORDER BY started_at DESC LIMIT 1').get(conversationId) as RunRow | undefined) ?? null;
  }

  private updateRun(id: string, patch: Partial<RunRow>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.s.db.prepare(`UPDATE agent_runs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => (patch as Record<string, unknown>)[k]), id);
  }

  /** Mesaj nou de la proprietar într-o conversație: pornește rularea în fundal. */
  startOwnerMessage(conversationId: string, text: string): { runId: string; userMessageId: string } {
    if (this.isRunning(conversationId)) throw new BusyError('Agentul încă lucrează în această conversație. Așteaptă sau oprește rularea.');
    const cancelled = this.s.approvals.cancelPendingForConversation(conversationId, 'Anulat: proprietarul a trimis un mesaj nou.');
    if (cancelled) this.closePendingToolCalls(conversationId, 'Proprietarul a trimis un mesaj nou; acțiunea nu a fost executată.');
    const userMessageId = this.s.conversations.append({ conversationId, role: 'user', content: text });
    const conv = this.s.conversations.get(conversationId);
    if (conv && conv.title === 'Conversație nouă') {
      const title = text.replace(/\s+/g, ' ').trim().slice(0, 60) + (text.length > 60 ? '…' : '');
      this.s.conversations.rename(conversationId, title);
      this.s.bus.emitChat(conversationId, { type: 'title', conversationId, title });
    }
    const runId = this.createRun({ conversationId, context: 'owner', trigger: 'chat' });
    void this.execute(runId).catch((err) => this.s.log.error({ err }, 'Rulare agent eșuată'));
    return { runId, userMessageId };
  }

  /** Rulare completă, așteptată (folosită de incidente și tichete). */
  async run(opts: RunOptions): Promise<RunOutcome> {
    if (this.isRunning(opts.conversationId)) throw new BusyError('Conversația are deja o rulare activă.');
    const runId = this.createRun(opts);
    return this.execute(runId);
  }

  async resume(runId: string): Promise<RunOutcome> {
    const run = this.getRun(runId);
    if (!run) throw new Error('Rulare inexistentă.');
    if (run.status !== 'waiting_approval') return this.outcomeOf(run, '');
    if (this.isRunning(run.conversation_id)) throw new BusyError('Conversația are deja o rulare activă.');
    this.updateRun(runId, { status: 'running' });
    return this.execute(runId);
  }

  private createRun(opts: RunOptions): string {
    const id = newId('run_');
    const s = this.s.settings.get();
    const model = opts.model ?? (opts.context === 'incident' ? s.llm.incidentModel : s.llm.model);
    this.s.db
      .prepare('INSERT INTO agent_runs (id, conversation_id, context, status, trigger, model, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, opts.conversationId, opts.context, 'running', opts.trigger, model, Date.now());
    return id;
  }

  private outcomeOf(run: RunRow, finalText: string): RunOutcome {
    return {
      runId: run.id,
      status: run.status,
      error: run.error ?? undefined,
      finalText,
      outcomes: this.outcomes.get(run.id) ?? {},
      costUsd: run.cost_usd,
    };
  }

  /** Închide apelurile de unelte rămase fără rezultat (ex. aprobări anulate). */
  private closePendingToolCalls(conversationId: string, reason: string): void {
    for (const call of this.s.conversations.pendingToolCalls(conversationId)) {
      this.s.conversations.append({
        conversationId,
        role: 'tool',
        toolCallId: call.id,
        toolName: call.function.name,
        content: JSON.stringify({ status: 'not_executed', reason }),
        meta: { status: 'rejected', preview: reason } satisfies ToolRowMeta,
      });
    }
  }

  private async execute(runId: string): Promise<RunOutcome> {
    const run = this.getRun(runId)!;
    const conversationId = run.conversation_id;
    const controller = new AbortController();
    this.active.set(conversationId, controller);
    const bus = this.s.bus;
    let finalText = '';
    let cost = run.cost_usd;
    let steps = run.steps;
    const firstMessageId = newId('m_');
    bus.emitChat(conversationId, { type: 'run_started', runId, conversationId, messageId: firstMessageId });

    const finish = (status: Exclude<RunRow['status'], 'running'>, error?: string): RunOutcome => {
      this.updateRun(runId, { status, finished_at: status === 'waiting_approval' ? null : Date.now(), steps, cost_usd: cost, error: error ?? null });
      this.active.delete(conversationId);
      bus.emitChat(conversationId, { type: 'run_finished', runId, status, ...(error ? { error } : {}) });
      return { runId, status, error, finalText, outcomes: this.outcomes.get(runId) ?? {}, costUsd: cost };
    };

    try {
      const settings = this.s.settings.get();
      const tools = toolsFor(run.context, this.s.integrations);
      const toolSpecs: LlmToolSpec[] = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: toJsonSchema(t.schema) },
      }));
      const maxSteps = settings.llm.maxStepsPerRun;
      let messageId = firstMessageId;

      for (;;) {
        if (controller.signal.aborted) {
          this.closePendingToolCalls(conversationId, 'Rulare oprită de proprietar.');
          return finish('cancelled');
        }

        // 1) apeluri de unelte rămase fără rezultat (ex. după o aprobare)
        const pending = this.s.conversations.pendingToolCalls(conversationId);
        if (pending.length) {
          const waiting = await this.processToolCalls(runId, run.context, conversationId, messageId, pending, tools, controller.signal);
          if (waiting) return finish('waiting_approval');
          messageId = newId('m_');
        }

        if (steps >= maxSteps) {
          const note = `Am atins limita de ${maxSteps} pași pentru această sarcină. Spune-mi dacă vrei să continui.`;
          this.s.conversations.append({ conversationId, role: 'system_note', content: note });
          finalText = finalText || note;
          return finish('done');
        }

        // 2) apel către model
        const history = this.s.conversations.toLlmMessages(conversationId);
        const messages: LlmMessage[] = [{ role: 'system', content: systemPrompt(this.s, run.context) }, ...history];
        let thinkingShown = false;
        let textStarted = false;
        const result = await this.s.llm.stream(
          {
            model: run.model ?? settings.llm.model,
            messages,
            tools: toolSpecs,
            thinking: settings.llm.thinking,
            reasoningEffort: settings.llm.reasoningEffort,
            maxTokens: 16_000,
          },
          (e) => {
            if (e.type === 'reasoning_delta' && !thinkingShown && !textStarted) {
              thinkingShown = true;
              bus.emitChat(conversationId, { type: 'thinking', messageId, active: true });
            } else if (e.type === 'text_delta') {
              if (thinkingShown && !textStarted) bus.emitChat(conversationId, { type: 'thinking', messageId, active: false });
              textStarted = true;
              bus.emitChat(conversationId, { type: 'text_delta', messageId, delta: e.text });
            }
          },
          { context: run.context, runId },
          controller.signal,
        );
        if (thinkingShown && !textStarted) bus.emitChat(conversationId, { type: 'thinking', messageId, active: false });
        steps++;
        cost += result.costUsd;

        const toolCalls = result.toolCalls;
        this.s.conversations.append({
          id: messageId,
          conversationId,
          role: 'assistant',
          content: result.content,
          reasoning: result.reasoning,
          toolCalls,
          meta: { model: result.model, finishReason: result.finishReason },
        });
        if (result.content.trim()) finalText = result.content;
        bus.emitChat(conversationId, { type: 'message_done', messageId });
        this.updateRun(runId, { steps, cost_usd: cost });

        if (!toolCalls.length) {
          if (result.finishReason === 'length') {
            this.s.conversations.append({ conversationId, role: 'system_note', content: 'Răspunsul a fost tăiat (limita de lungime).' });
          }
          return finish('done');
        }
        const waiting = await this.processToolCalls(runId, run.context, conversationId, messageId, toolCalls, tools, controller.signal);
        if (waiting) return finish('waiting_approval');
        messageId = newId('m_');
      }
    } catch (err) {
      const msg = err instanceof LlmError ? err.message : errorMessage(err);
      if (controller.signal.aborted) {
        this.closePendingToolCalls(conversationId, 'Rulare oprită de proprietar.');
        return finish('cancelled');
      }
      this.s.log.warn({ err, runId }, 'Rularea agentului s-a oprit cu eroare');
      this.closePendingToolCalls(conversationId, `Rulare oprită din cauza unei erori: ${msg}`);
      this.s.conversations.append({ conversationId, role: 'system_note', content: `⚠️ ${msg}` });
      return finish('error', msg);
    } finally {
      if (this.active.get(conversationId) === controller) this.active.delete(conversationId);
    }
  }

  /**
   * Execută (sau trimite spre aprobare) apelurile de unelte. Întoarce true dacă rularea
   * trebuie să aștepte aprobarea proprietarului.
   */
  private async processToolCalls(
    runId: string,
    context: AgentContext,
    conversationId: string,
    messageId: string,
    calls: LlmToolCall[],
    available: AnyTool[],
    signal: AbortSignal,
  ): Promise<boolean> {
    const settings = this.s.settings.get();
    const extras = this.policyExtras(runId);
    const availableNames = new Set(available.map((t) => t.name));
    let waiting = false;

    const runnable: Array<{ call: LlmToolCall; tool: AnyTool; args: unknown; approvalId: string | null }> = [];

    for (const call of calls) {
      const tool = getTool(call.function.name);
      const emitCall = (status: ToolCallDTO['status'], approvalId: string | null, args: Record<string, unknown>) =>
        this.s.bus.emitChat(conversationId, {
          type: 'tool_call',
          messageId,
          call: { id: call.id, name: call.function.name, label: tool?.label ?? call.function.name, args, status, resultPreview: null, approvalId },
        });

      if (!tool || !availableNames.has(tool.name)) {
        this.saveToolResult(conversationId, messageId, call, { error: `Unealta „${call.function.name}” nu există sau nu e disponibilă acum.` }, 'error', null, tool);
        continue;
      }
      const rawArgs = safeJsonParse<Record<string, unknown> | null>(call.function.arguments || '{}', null);
      if (!rawArgs) {
        this.saveToolResult(conversationId, messageId, call, { error: 'Argumentele nu sunt JSON valid. Reîncearcă cu argumente corecte.' }, 'error', null, tool);
        continue;
      }
      const parsed = tool.schema.safeParse(rawArgs);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(argumente)'}: ${i.message}`).join('; ');
        this.saveToolResult(conversationId, messageId, call, { error: `Argumente invalide: ${issues}` }, 'error', null, tool);
        continue;
      }

      const decision = decide(tool, context, settings, extras);
      if (decision.action === 'deny') {
        this.saveToolResult(conversationId, messageId, call, { error: `Nepermis: ${decision.reason}` }, 'error', null, tool);
        continue;
      }
      if (decision.action === 'approval') {
        const existing = this.s.approvals.forToolCall(call.id);
        if (existing && existing.status === 'approved') {
          runnable.push({ call, tool, args: parsed.data, approvalId: existing.id });
          continue;
        }
        if (existing && (existing.status === 'rejected' || existing.status === 'expired')) {
          const why = existing.status === 'rejected' ? 'Proprietarul a respins acțiunea.' : 'Aprobarea a expirat (24 h fără răspuns).';
          this.saveToolResult(conversationId, messageId, call, { status: 'not_executed', reason: why, note: existing.result }, 'rejected', existing.id, tool);
          continue;
        }
        if (existing && existing.status === 'pending') {
          waiting = waiting || decision.blocking;
          continue;
        }
        const summary = tool.summarize ? tool.summarize(parsed.data as never) : `${tool.label}: ${JSON.stringify(parsed.data)}`;
        const approval = this.s.approvals.create({
          runId,
          conversationId,
          messageId,
          toolCallId: call.id,
          toolName: tool.name,
          args: parsed.data as Record<string, unknown>,
          risk: tool.risk,
          summary,
          requiresStepUp: decision.stepUp,
          context,
        });
        emitCall('pending_approval', approval.id, parsed.data as Record<string, unknown>);
        this.s.bus.emitChat(conversationId, { type: 'approval_required', approval });
        if (decision.blocking) {
          waiting = true;
        } else {
          this.saveToolResult(
            conversationId,
            messageId,
            call,
            { status: 'sent_for_approval', approvalId: approval.id, note: 'Acțiunea a fost trimisă proprietarului spre aprobare și NU a fost executată încă. Continuă fără ea.' },
            'done',
            approval.id,
            tool,
          );
        }
        continue;
      }
      runnable.push({ call, tool, args: parsed.data, approvalId: null });
    }

    // uneltele de citire rulează în paralel; cele care modifică ceva, pe rând
    const reads = runnable.filter((r) => r.tool.risk === 'read');
    const writes = runnable.filter((r) => r.tool.risk !== 'read');
    const exec = async (r: (typeof runnable)[number]) => {
      if (signal.aborted) return;
      this.s.bus.emitChat(conversationId, {
        type: 'tool_call',
        messageId,
        call: { id: r.call.id, name: r.tool.name, label: r.tool.label, args: r.args as Record<string, unknown>, status: 'running', resultPreview: null, approvalId: r.approvalId },
      });
      try {
        const result = await withTimeout(
          r.tool.execute(r.args as never, { services: this.s, context, runId, conversationId, signal }),
          toolTimeout(r.tool.name),
          `Unealta ${r.tool.name} a depășit timpul maxim.`,
        );
        if (r.tool.risk !== 'read') {
          this.s.audit.log({
            actor: 'agent',
            context,
            action: `tool.${r.tool.name}`,
            target: null,
            details: r.tool.summarize ? r.tool.summarize(r.args as never) : r.args,
            result: r.approvalId ? 'executat (aprobat de proprietar)' : 'executat',
          });
        }
        if (r.approvalId) this.s.approvals.finish(r.approvalId, 'executed', truncate(redactSensitive(JSON.stringify(result ?? {})), 1500));
        this.saveToolResult(conversationId, messageId, r.call, result ?? { ok: true }, 'done', r.approvalId, r.tool);
      } catch (err) {
        const msg = err instanceof ToolFailure ? err.message : errorMessage(err);
        if (r.approvalId) this.s.approvals.finish(r.approvalId, 'failed', msg);
        if (r.tool.risk !== 'read') this.s.audit.log({ actor: 'agent', context, action: `tool.${r.tool.name}`, details: r.args, result: `eșuat: ${msg}` });
        this.saveToolResult(conversationId, messageId, r.call, { error: msg }, 'error', r.approvalId, r.tool);
      }
    };
    await Promise.all(reads.map(exec));
    for (const w of writes) await exec(w);
    return waiting;
  }

  /** Misiunile programate pot primi voie să facă singure modificări reversibile. */
  private policyExtras(runId: string): PolicyExtras {
    const trigger = this.getRun(runId)?.trigger ?? '';
    if (trigger.startsWith('mission:')) return { missionAllowsChanges: this.s.missions.allowsChanges(trigger.slice('mission:'.length)) };
    return {};
  }

  private saveToolResult(
    conversationId: string,
    messageId: string,
    call: LlmToolCall,
    result: unknown,
    status: ToolRowMeta['status'],
    approvalId: string | null,
    tool: AnyTool | undefined,
  ): void {
    let text = typeof result === 'string' ? result : JSON.stringify(result);
    text = redactSensitive(text);
    text = truncate(text, MAX_TOOL_RESULT_CHARS, '\n…[rezultat trunchiat]');
    if (tool?.untrusted && status === 'done') text = fenceUntrusted(tool.name, text);
    const preview = previewOf(result, status);
    this.s.conversations.append({
      conversationId,
      role: 'tool',
      toolCallId: call.id,
      toolName: call.function.name,
      content: text,
      meta: { status, preview, approvalId } satisfies ToolRowMeta,
    });
    this.s.bus.emitChat(conversationId, {
      type: 'tool_result',
      messageId,
      callId: call.id,
      status: status === 'error' ? 'error' : status === 'rejected' ? 'rejected' : 'done',
      resultPreview: preview,
    });
  }
}

function previewOf(result: unknown, status: ToolRowMeta['status']): string | null {
  if (result == null) return null;
  if (typeof result === 'object' && result && 'error' in result) return truncate(String((result as { error: unknown }).error), 300);
  if (status === 'rejected' && typeof result === 'object' && result && 'reason' in result) return String((result as { reason: unknown }).reason);
  const text = redactSensitive(typeof result === 'string' ? result : JSON.stringify(result));
  return truncate(text.replace(/\s+/g, ' '), 300, '…');
}

async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ToolFailure(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
