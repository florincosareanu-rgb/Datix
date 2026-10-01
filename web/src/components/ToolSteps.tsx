import { useState } from 'react';
import clsx from 'clsx';
import { Check, ChevronDown, Clock, Loader2, Wrench, X } from 'lucide-react';
import type { ToolCallDTO } from '@datix/shared';

function StepIcon({ status }: { status: ToolCallDTO['status'] }) {
  switch (status) {
    case 'running':
      return <Loader2 className="size-3.5 animate-spin text-accent" />;
    case 'done':
      return <Check className="size-3.5 text-good" />;
    case 'error':
      return <X className="size-3.5 text-critical" />;
    case 'rejected':
      return <X className="size-3.5 text-ink-3" />;
    case 'pending_approval':
      return <Clock className="size-3.5 text-warning-ink" />;
  }
}

const STATUS_TEXT: Record<ToolCallDTO['status'], string> = {
  running: 'în lucru',
  done: 'gata',
  error: 'eroare',
  rejected: 'neexecutat',
  pending_approval: 'așteaptă aprobarea ta',
};

/** Pașii agentului (uneltele folosite), compact și extensibil — ca la Claude. */
export function ToolSteps({ calls, live }: { calls: ToolCallDTO[]; live?: boolean }) {
  const running = calls.some((c) => c.status === 'running');
  const [open, setOpen] = useState(false);
  if (!calls.length) return null;
  const errors = calls.filter((c) => c.status === 'error').length;
  const summary = running ? (calls.find((c) => c.status === 'running')?.label ?? 'Lucrez') + '…' : `${calls.length === 1 ? calls[0]!.label : `Am folosit ${calls.length} unelte`}${errors ? ` · ${errors} cu eroare` : ''}`;
  return (
    <div className="mb-2.5">
      <button onClick={() => setOpen((o) => !o)} className="flex max-w-full items-center gap-2 rounded-lg py-1 text-[13px] text-ink-2 hover:text-ink" aria-expanded={open}>
        {running || live ? <Loader2 className={clsx('size-3.5 shrink-0', running ? 'animate-spin text-accent' : 'text-ink-3')} /> : <Wrench className="size-3.5 shrink-0 text-ink-3" />}
        <span className="truncate">{summary}</span>
        <ChevronDown className={clsx('size-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ol className="mt-1 space-y-1 border-l border-line pl-3">
          {calls.map((c) => (
            <li key={c.id} className="text-[13px]">
              <div className="flex items-center gap-2">
                <StepIcon status={c.status} />
                <span className="font-medium text-ink">{c.label}</span>
                <span className="text-ink-3">· {STATUS_TEXT[c.status]}</span>
              </div>
              {Object.keys(c.args).length > 0 && <div className="ml-5.5 truncate font-mono text-[11.5px] text-ink-3">{JSON.stringify(c.args)}</div>}
              {c.resultPreview && <div className={clsx('ml-5.5 line-clamp-3 text-[12px]', c.status === 'error' ? 'text-critical-ink' : 'text-ink-3')}>{c.resultPreview}</div>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
