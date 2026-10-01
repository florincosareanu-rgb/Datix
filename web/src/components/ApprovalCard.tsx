import { useState } from 'react';
import clsx from 'clsx';
import { Fingerprint, ShieldAlert } from 'lucide-react';
import { APPROVAL_STATUS_LABEL, RISK_LABEL, type ApprovalDTO } from '@datix/shared';
import { api, errorText } from '../lib/api';
import { useToast } from '../lib/toast';
import { Badge, Button } from './ui';
import { timeAgo } from '../lib/format';

/** Cardul de aprobare: agentul cere OK-ul tău pentru o acțiune riscantă. */
export function ApprovalCard({ approval, onDecided, compact }: { approval: ApprovalDTO; onDecided?: (a: ApprovalDTO) => void; compact?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const pending = approval.status === 'pending';

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(decision);
    try {
      const updated = await api.post<ApprovalDTO>(`/api/approvals/${approval.id}/decide`, { decision });
      toast(decision === 'approve' ? 'Aprobat — agentul continuă.' : 'Respins.', decision === 'approve' ? 'good' : 'info');
      onDecided?.(updated);
    } catch (err) {
      toast(errorText(err), 'critical');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={clsx('rounded-2xl border p-3.5', pending ? 'border-warning/50 bg-warning-soft/60' : 'border-line bg-surface-2/60')}>
      <div className="flex flex-wrap items-center gap-2">
        <ShieldAlert className="size-4 text-warning-ink" />
        <span className="text-sm font-semibold">{pending ? 'Agentul cere aprobarea ta' : approval.toolLabel}</span>
        <Badge tone={approval.risk === 'irreversible' ? 'critical' : approval.risk === 'customer_message' ? 'accent' : 'warning'}>{RISK_LABEL[approval.risk]}</Badge>
        {!pending && <Badge tone={approval.status === 'executed' || approval.status === 'approved' ? 'good' : 'neutral'}>{APPROVAL_STATUS_LABEL[approval.status]}</Badge>}
        {!compact && <span className="ml-auto text-xs text-ink-3">{timeAgo(approval.createdAt)}</span>}
      </div>
      <p className="mt-2 text-sm whitespace-pre-wrap text-ink">{approval.summary}</p>
      {approval.result && !pending && <p className="mt-1.5 line-clamp-3 text-xs text-ink-3">{approval.result}</p>}
      {pending && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" size="sm" loading={busy === 'approve'} disabled={!!busy} onClick={() => decide('approve')} icon={approval.requiresStepUp ? <Fingerprint className="size-4" /> : undefined}>
            {approval.requiresStepUp ? 'Aprobă cu Face ID' : 'Aprobă'}
          </Button>
          <Button variant="secondary" size="sm" loading={busy === 'reject'} disabled={!!busy} onClick={() => decide('reject')}>
            Respinge
          </Button>
        </div>
      )}
    </div>
  );
}
