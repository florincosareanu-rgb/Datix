import clsx from 'clsx';

/** Orbul DAX — identitatea vizuală a agentului (gradient violet → indigo → cyan). */
export function DaxOrb({ size = 28, glow, active, className }: { size?: number; glow?: boolean; active?: boolean; className?: string }) {
  return <span aria-hidden className={clsx('dax-orb inline-block', glow && 'dax-orb-glow', active && 'dax-orb-active', className)} style={{ width: size, height: size }} />;
}

/** Marca DAX: orb + numele, în fontul de titluri. */
export function DaxMark({ size = 32, subtitle, className }: { size?: number; subtitle?: React.ReactNode; className?: string }) {
  return (
    <div className={clsx('flex items-center gap-2.5', className)}>
      <DaxOrb size={size} />
      <div className="min-w-0 leading-tight">
        <div className="font-display text-[19px] font-semibold tracking-tight">DAX</div>
        {subtitle && <div className="truncate text-xs text-ink-3">{subtitle}</div>}
      </div>
    </div>
  );
}
