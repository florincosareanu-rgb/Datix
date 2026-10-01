import type { AgentContext, ApprovalDTO, ApprovalStatus, RiskLevel } from '@datix/shared';
import type { Services } from '../services';
import { newId } from '../util/ids';
import { errorMessage, safeJsonParse, truncate } from '../util/text';
import { getTool, toolLabel } from './tools';
import { HOUR } from '../util/time';
import { redactSensitive } from './redact';

interface ApprovalRow {
  id: string;
  run_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
  tool_call_id: string | null;
  tool_name: string;
  args: string;
  risk: RiskLevel;
  summary: string;
  status: ApprovalStatus;
  requires_step_up: number;
  context: AgentContext;
  created_at: number;
  decided_at: number | null;
  result: string | null;
}

export class ApprovalError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code: string | null = null,
  ) {
    super(message);
  }
}

const toDTO = (r: ApprovalRow): ApprovalDTO => ({
  id: r.id,
  runId: r.run_id,
  conversationId: r.conversation_id,
  toolName: r.tool_name,
  toolLabel: toolLabel(r.tool_name),
  args: safeJsonParse<Record<string, unknown>>(r.args, {}),
  risk: r.risk,
  summary: r.summary,
  status: r.status,
  requiresStepUp: r.requires_step_up === 1,
  context: r.context,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  result: r.result,
});

/** Aprobările cerute de agent pentru acțiunile riscante. */
export class ApprovalService {
  constructor(private readonly s: Services) {}

  private row(id: string): ApprovalRow | null {
    return (this.s.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined) ?? null;
  }

  get(id: string): ApprovalDTO | null {
    const r = this.row(id);
    return r ? toDTO(r) : null;
  }

  list(opts: { status?: ApprovalStatus; limit?: number } = {}): ApprovalDTO[] {
    const rows = opts.status
      ? (this.s.db.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(opts.status, opts.limit ?? 50) as ApprovalRow[])
      : (this.s.db.prepare('SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?').all(opts.limit ?? 50) as ApprovalRow[]);
    return rows.map(toDTO);
  }

  pendingCount(): number {
    return (this.s.db.prepare("SELECT COUNT(*) n FROM approvals WHERE status = 'pending'").get() as { n: number }).n;
  }

  forToolCall(toolCallId: string): ApprovalDTO | null {
    const r = this.s.db.prepare('SELECT * FROM approvals WHERE tool_call_id = ? ORDER BY created_at DESC LIMIT 1').get(toolCallId) as ApprovalRow | undefined;
    return r ? toDTO(r) : null;
  }

  pendingForConversation(conversationId: string): ApprovalDTO[] {
    return (this.s.db.prepare("SELECT * FROM approvals WHERE conversation_id = ? AND status = 'pending'").all(conversationId) as ApprovalRow[]).map(toDTO);
  }

  create(input: {
    runId: string | null;
    conversationId: string | null;
    messageId: string | null;
    toolCallId: string | null;
    toolName: string;
    args: Record<string, unknown>;
    risk: RiskLevel;
    summary: string;
    requiresStepUp: boolean;
    context: AgentContext;
  }): ApprovalDTO {
    const id = newId('ap_');
    this.s.db
      .prepare(
        `INSERT INTO approvals (id, run_id, conversation_id, message_id, tool_call_id, tool_name, args, risk, summary, status, requires_step_up, context, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.conversationId,
        input.messageId,
        input.toolCallId,
        input.toolName,
        JSON.stringify(input.args),
        input.risk,
        input.summary.slice(0, 4000),
        input.requiresStepUp ? 1 : 0,
        input.context,
        Date.now(),
      );
    const dto = this.get(id)!;
    this.s.bus.emit({ type: 'approval', approval: dto });
    if (input.context !== 'owner') {
      void this.s.notifier.notify({
        kind: 'approval',
        title: 'Agentul cere aprobarea ta',
        body: truncate(input.summary, 180),
        priority: input.risk === 'irreversible' ? 'high' : 'normal',
        url: `/aprobari?id=${id}`,
        dedupeKey: `approval:${id}`,
      });
    }
    return dto;
  }

  /**
   * Decizia proprietarului. Pentru acțiunile marcate „requiresStepUp”, sesiunea trebuie să fie
   * confirmată recent cu Face ID / cod 2FA.
   */
  async decide(id: string, decision: 'approve' | 'reject', opts: { stepUpValid: boolean; ip: string | null; note?: string }): Promise<ApprovalDTO> {
    const r = this.row(id);
    if (!r) throw new ApprovalError('Aprobarea nu există.', 404);
    if (r.status !== 'pending') throw new ApprovalError(`Aprobarea a fost deja procesată (${r.status}).`, 409);
    if (decision === 'approve' && r.requires_step_up === 1 && !opts.stepUpValid) {
      throw new ApprovalError('Confirmă cu Face ID sau cu codul 2FA pentru a aproba această acțiune.', 403, 'step_up_required');
    }
    const status: ApprovalStatus = decision === 'approve' ? 'approved' : 'rejected';
    this.s.db.prepare('UPDATE approvals SET status = ?, decided_at = ?, result = ? WHERE id = ?').run(status, Date.now(), opts.note ?? null, id);
    this.s.audit.log({
      actor: 'owner',
      context: r.context,
      action: decision === 'approve' ? 'approval.approved' : 'approval.rejected',
      target: r.tool_name,
      details: r.summary,
      ip: opts.ip,
    });
    const updated = this.get(id)!;
    this.s.bus.emit({ type: 'approval', approval: updated });

    const run = r.run_id ? this.s.agent.getRun(r.run_id) : null;
    if (run && run.status === 'waiting_approval') {
      // rularea blocată așteaptă: o reluăm (în fundal)
      void this.s.agent.resume(run.id).catch((err) => this.s.log.error({ err }, 'Reluarea rulării după aprobare a eșuat'));
    } else if (decision === 'approve') {
      // aprobare non-blocantă (ex. propusă dintr-un tichet): executăm acum
      await this.executeStandalone(updated);
    }
    return this.get(id)!;
  }

  private async executeStandalone(a: ApprovalDTO): Promise<void> {
    const tool = getTool(a.toolName);
    if (!tool) {
      this.finish(a.id, 'failed', 'Unealta nu mai există.');
      return;
    }
    try {
      const args = tool.schema.parse(a.args);
      const result = await tool.execute(args, {
        services: this.s,
        context: 'owner',
        runId: a.runId ?? 'approval',
        conversationId: a.conversationId ?? '',
      });
      const text = truncate(redactSensitive(JSON.stringify(result ?? { ok: true })), 2000);
      this.finish(a.id, 'executed', text);
      this.s.audit.log({ actor: 'agent', context: a.context, action: `tool.${a.toolName}`, details: a.summary, result: 'executat după aprobare' });
      void this.s.notifier.notify({ kind: 'system', title: 'Acțiune executată', body: truncate(a.summary, 160), priority: 'normal', url: `/aprobari?id=${a.id}` });
    } catch (err) {
      this.finish(a.id, 'failed', errorMessage(err));
      void this.s.notifier.notify({ kind: 'system', title: 'Acțiunea aprobată a eșuat', body: truncate(`${a.summary}: ${errorMessage(err)}`, 200), priority: 'high', url: `/aprobari?id=${a.id}` });
    }
  }

  finish(id: string, status: ApprovalStatus, result: string | null): void {
    this.s.db.prepare('UPDATE approvals SET status = ?, result = ? WHERE id = ?').run(status, result, id);
    const dto = this.get(id);
    if (dto) this.s.bus.emit({ type: 'approval', approval: dto });
  }

  /** Aprobările vechi expiră după 24 h; rulările blocate sunt reluate cu rezultatul „expirat”. */
  expireOld(): void {
    const rows = this.s.db.prepare("SELECT * FROM approvals WHERE status = 'pending' AND created_at < ?").all(Date.now() - 24 * HOUR) as ApprovalRow[];
    for (const r of rows) {
      this.s.db.prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ?").run(Date.now(), r.id);
      const run = r.run_id ? this.s.agent.getRun(r.run_id) : null;
      if (run && run.status === 'waiting_approval') void this.s.agent.resume(run.id).catch(() => undefined);
    }
  }

  /** Când proprietarul trimite un mesaj nou, aprobările în așteptare din conversație se anulează. */
  cancelPendingForConversation(conversationId: string, reason: string): number {
    const rows = this.pendingForConversation(conversationId);
    for (const r of rows) {
      this.s.db.prepare("UPDATE approvals SET status = 'rejected', decided_at = ?, result = ? WHERE id = ?").run(Date.now(), reason, r.id);
      const dto = this.get(r.id);
      if (dto) this.s.bus.emit({ type: 'approval', approval: dto });
    }
    return rows.length;
  }
}
