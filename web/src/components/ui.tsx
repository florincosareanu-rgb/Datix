import { forwardRef, useEffect, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import clsx from 'clsx';
import { ChevronDown, Loader2, X } from 'lucide-react';

// ------------------------------------------------------------------------------ butoane

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';

const variants: Record<Variant, string> = {
  primary:
    'bg-accent text-accent-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.18),0_8px_20px_-8px_rgb(124_58_237/0.7)] hover:bg-accent-hover disabled:opacity-50 disabled:shadow-none',
  secondary: 'bg-surface text-ink ring-1 ring-line hover:bg-surface-2 hover:ring-line-strong disabled:opacity-50',
  subtle: 'bg-surface-2 text-ink hover:bg-surface-3 disabled:opacity-50',
  ghost: 'text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-40',
  danger: 'bg-critical text-white shadow-[0_8px_20px_-8px_rgb(208_59_59/0.6)] hover:brightness-95 disabled:opacity-50',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx(
        'pressable inline-flex items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap select-none disabled:cursor-not-allowed',
        size === 'sm' && 'h-10 px-4 text-[14px] pointer-coarse:h-11',
        size === 'md' && 'h-11 px-5 text-[15px]',
        size === 'lg' && 'h-13 px-6 text-[16px]',
        variants[variant],
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export function IconButton({ label, className, children, type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={clsx('pressable inline-flex size-11 items-center justify-center rounded-full text-ink-2 hover:bg-surface-2 hover:text-ink', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

// ------------------------------------------------------------------------------ containere

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx('card-shadow rounded-3xl border border-line/80 bg-surface', className)} {...rest}>
      {children}
    </div>
  );
}

/** Pictogramă într-un „squircle” colorat discret (antet de card, liste). */
export function IconTile({ children, tone = 'accent', className }: { children: ReactNode; tone?: 'accent' | 'neutral' | 'good' | 'warning' | 'critical'; className?: string }) {
  const styles = {
    accent: 'bg-accent-soft text-accent-fg',
    neutral: 'bg-surface-2 text-ink-2',
    good: 'bg-good-soft text-good-ink',
    warning: 'bg-warning-soft text-warning-ink',
    critical: 'bg-critical-soft text-critical-ink',
  }[tone];
  return (
    <span aria-hidden className={clsx('inline-flex size-9 shrink-0 items-center justify-center rounded-xl [&_svg]:size-[18px]', styles, className)}>
      {children}
    </span>
  );
}

export function CardHeader({ title, subtitle, action, icon }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
      <div className="flex min-w-0 items-start gap-3">
        {icon && <IconTile>{icon}</IconTile>}
        <div className="min-w-0 pt-0.5">
          <h3 className="font-display text-[17px] leading-tight font-semibold">{title}</h3>
          {subtitle && <p className="mt-1 text-[14px] leading-snug text-ink-2">{subtitle}</p>}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-display text-[30px] leading-[1.1] font-semibold tracking-tight sm:text-[34px]">{title}</h1>
        {subtitle && <div className="mt-2 max-w-2xl text-[15px] text-ink-2">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={clsx('enter mx-auto w-full px-4 pt-5 pb-8 sm:px-6 sm:pt-8 lg:px-10', wide ? 'max-w-6xl' : 'max-w-4xl')}>{children}</div>;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon && <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-surface-2 text-ink-3 [&_svg]:size-7">{icon}</div>}
      <p className="font-display text-[17px] font-semibold">{title}</p>
      {children && <div className="mt-1.5 max-w-md text-[15px] text-ink-2">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-5 animate-spin text-ink-3', className)} aria-hidden />;
}

export function Loading({ label = 'Se încarcă…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 py-16 text-[15px] text-ink-3" role="status">
      <Spinner /> {label}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-2xl border border-critical/25 bg-critical-soft px-4 py-3.5 text-[15px] text-critical-ink" role="alert">
      {message}
      {onRetry && (
        <button className="ml-2 font-medium underline underline-offset-2" onClick={onRetry}>
          Reîncearcă
        </button>
      )}
    </div>
  );
}

export function Notice({ tone = 'info', children, icon }: { tone?: 'info' | 'good' | 'warning' | 'critical'; children: ReactNode; icon?: ReactNode }) {
  const styles = {
    info: 'border-accent/20 bg-accent-soft/70 text-ink',
    good: 'border-good/25 bg-good-soft text-ink',
    warning: 'border-warning/35 bg-warning-soft text-ink',
    critical: 'border-critical/25 bg-critical-soft text-ink',
  }[tone];
  return (
    <div className={clsx('flex gap-3 rounded-2xl border px-4 py-3.5 text-[15px] leading-relaxed', styles)}>
      {icon && <div className="mt-0.5 shrink-0">{icon}</div>}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// ------------------------------------------------------------------------------ formulare

export function Field({ label, hint, children, error }: { label: ReactNode; hint?: ReactNode; children: ReactNode; error?: string | null }) {
  return (
    <label className="block">
      <span className="mb-2 block text-[14px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && !error && <span className="mt-1.5 block text-[13px] leading-snug text-ink-3">{hint}</span>}
      {error && <span className="mt-1.5 block text-[13px] text-critical-ink">{error}</span>}
    </label>
  );
}

const inputClass =
  'w-full rounded-2xl border border-transparent bg-surface-2 px-4 text-ink placeholder:text-ink-3 outline-none transition-[background-color,border-color,box-shadow] duration-200 hover:bg-surface-3/70 focus:border-accent focus:bg-surface focus:ring-4 focus:ring-accent/15 disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={clsx(inputClass, 'h-12', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={clsx(inputClass, 'min-h-28 resize-y py-3 leading-relaxed', className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select className={clsx(inputClass, 'h-12 appearance-none pr-10', className)} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
    </div>
  );
}

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-[15px] font-medium">{label}</span>
        {description && <span className="mt-0.5 block text-[14px] leading-snug text-ink-2">{description}</span>}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative mt-0.5 inline-flex h-[31px] w-[51px] shrink-0 items-center rounded-full transition-colors duration-200 before:absolute before:-inset-2 disabled:opacity-50',
          checked ? 'bg-accent' : 'bg-surface-3',
        )}
      >
        <span
          className={clsx(
            'inline-block size-[27px] rounded-full bg-white shadow-[0_2px_6px_rgb(0_0_0/0.18)] transition-transform duration-200 ease-[var(--ease-out)]',
            checked ? 'translate-x-[22px]' : 'translate-x-[2px]',
          )}
        />
      </button>
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, size = 'md' }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode; icon?: ReactNode }>; size?: 'sm' | 'md' }) {
  return (
    <div role="radiogroup" className="inline-grid w-full auto-cols-fr grid-flow-col rounded-full bg-surface-2 p-1 sm:w-auto">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'pressable flex min-w-0 items-center justify-center gap-1.5 rounded-full font-medium [&_svg]:shrink-0 max-[420px]:[&_svg]:hidden',
            size === 'sm' ? 'h-9 px-3 text-[14px] sm:px-3.5' : 'h-10 px-3 text-[15px] sm:px-4',
            'pointer-coarse:h-11',
            value === o.value ? 'bg-surface text-ink shadow-[0_1px_3px_rgb(14_17_32/0.12),0_0_0_1px_var(--glass-line)]' : 'text-ink-2 hover:text-ink',
          )}
        >
          {o.icon}
          <span className="truncate">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** File ca „pastile” derulabile (merg bine și pe telefon, și cu multe secțiuni). */
export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: Array<{ value: T; label: string; badge?: number }> }) {
  return (
    <div className="scrollbar-none -mx-4 mb-6 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0" role="tablist">
      {tabs.map((t) => {
        const active = value === t.value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.value)}
            className={clsx(
              'pressable flex h-10 shrink-0 items-center gap-2 rounded-full px-4 text-[14px] font-medium pointer-coarse:h-11',
              active ? 'bg-ink text-page' : 'bg-surface text-ink-2 ring-1 ring-line hover:text-ink hover:ring-line-strong',
            )}
          >
            {t.label}
            {t.badge ? (
              <span className={clsx('min-w-5 rounded-full px-1.5 text-center text-[11px] leading-5 font-semibold', active ? 'bg-page text-ink' : 'bg-critical text-white')}>{t.badge}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------------------ fereastră modală / foaie

export function Modal({ open, onClose, title, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-[rgb(10_11_18/0.45)] backdrop-blur-[3px]" onClick={onClose} />
      <div
        className={clsx(
          'enter safe-bottom relative flex max-h-[92dvh] w-full flex-col rounded-t-[28px] border border-line bg-surface float-shadow sm:rounded-[28px]',
          size === 'sm' && 'sm:max-w-sm',
          size === 'md' && 'sm:max-w-lg',
          size === 'lg' && 'sm:max-w-2xl',
        )}
      >
        <div className="mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-line-strong sm:hidden" aria-hidden />
        <div className="flex items-center justify-between gap-3 px-6 pt-3 pb-2 sm:pt-5">
          <h2 className="font-display text-[19px] font-semibold">{title}</h2>
          <IconButton label="Închide" onClick={onClose} className="-mr-2">
            <X className="size-5" />
          </IconButton>
        </div>
        <div className="scrollbar-thin overflow-y-auto px-6 pb-6">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-6 py-4">{footer}</div>}
      </div>
    </div>
  );
}

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'good' | 'warning' | 'serious' | 'critical'; className?: string }) {
  const styles = {
    neutral: 'bg-surface-2 text-ink-2 ring-line',
    accent: 'bg-accent-soft text-accent-fg ring-accent/15',
    good: 'bg-good-soft text-good-ink ring-good/20',
    warning: 'bg-warning-soft text-warning-ink ring-warning/30',
    serious: 'bg-serious-soft text-serious-ink ring-serious/25',
    critical: 'bg-critical-soft text-critical-ink ring-critical/20',
  }[tone];
  return <span className={clsx('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12.5px] font-medium whitespace-nowrap ring-1 ring-inset', styles, className)}>{children}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-2">{children}</kbd>;
}
