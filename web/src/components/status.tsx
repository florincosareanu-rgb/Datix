import { AlertOctagon, AlertTriangle, CheckCircle2, CircleDashed, Info, OctagonAlert, PauseCircle, ShieldAlert, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { MONITOR_STATUS_LABEL, SEVERITY_LABEL, type MonitorStatus, type Severity } from '@datix/shared';

// Culorile de stare au mereu pictogramă + text (nu doar culoare).

const STATUS_STYLE: Record<MonitorStatus, { cls: string; dot: string; Icon: typeof CheckCircle2 }> = {
  up: { cls: 'bg-good-soft text-good-ink ring-good/20', dot: 'bg-good', Icon: CheckCircle2 },
  degraded: { cls: 'bg-warning-soft text-warning-ink ring-warning/30', dot: 'bg-warning', Icon: AlertTriangle },
  down: { cls: 'bg-critical-soft text-critical-ink ring-critical/20', dot: 'bg-critical', Icon: XCircle },
  unknown: { cls: 'bg-surface-2 text-ink-2 ring-line', dot: 'bg-ink-3', Icon: CircleDashed },
  paused: { cls: 'bg-surface-2 text-ink-2 ring-line', dot: 'bg-ink-3', Icon: PauseCircle },
};

export function StatusBadge({ status, label, className }: { status: MonitorStatus; label?: string; className?: string }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12.5px] font-medium whitespace-nowrap ring-1 ring-inset', s.cls, className)}>
      <s.Icon className="size-3.5" aria-hidden />
      {label ?? MONITOR_STATUS_LABEL[status]}
    </span>
  );
}

/** Starea ca pictogramă rotundă (pe telefon, unde eticheta nu încape); textul rămâne pentru cititoarele de ecran. */
export function StatusIcon({ status, className }: { status: MonitorStatus; className?: string }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={clsx('inline-flex size-9 shrink-0 items-center justify-center rounded-full ring-1 ring-inset', s.cls, className)} title={MONITOR_STATUS_LABEL[status]}>
      <s.Icon className="size-[18px]" aria-hidden />
      <span className="sr-only">{MONITOR_STATUS_LABEL[status]}</span>
    </span>
  );
}

export function StatusDot({ status, className }: { status: MonitorStatus; className?: string }) {
  return <span className={clsx('inline-block size-2.5 shrink-0 rounded-full', STATUS_STYLE[status].dot, className)} aria-hidden />;
}

const SEVERITY_STYLE: Record<Severity, { cls: string; Icon: typeof Info }> = {
  critical: { cls: 'bg-critical-soft text-critical-ink ring-critical/20', Icon: AlertOctagon },
  high: { cls: 'bg-serious-soft text-serious-ink ring-serious/25', Icon: OctagonAlert },
  medium: { cls: 'bg-warning-soft text-warning-ink ring-warning/30', Icon: AlertTriangle },
  low: { cls: 'bg-surface-2 text-ink-2 ring-line', Icon: ShieldAlert },
  info: { cls: 'bg-surface-2 text-ink-2 ring-line', Icon: Info },
};

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  const s = SEVERITY_STYLE[severity];
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12.5px] font-medium whitespace-nowrap ring-1 ring-inset', s.cls, className)}>
      <s.Icon className="size-3.5" aria-hidden />
      {SEVERITY_LABEL[severity]}
    </span>
  );
}

export const severityBar: Record<Severity, string> = {
  critical: 'bg-critical',
  high: 'bg-serious',
  medium: 'bg-warning',
  low: 'bg-line-strong',
  info: 'bg-line',
};
