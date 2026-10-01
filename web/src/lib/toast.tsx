import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { CheckCircle2, Info, XCircle } from 'lucide-react';

type Tone = 'info' | 'good' | 'critical';
interface Toast {
  id: number;
  tone: Tone;
  text: string;
}

const Ctx = createContext<(text: string, tone?: Tone) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Tone = 'info') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-2), { id, tone, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === 'critical' ? 7000 : 4000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 px-4 pt-[calc(env(safe-area-inset-top)+12px)]">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className={clsx(
              'pointer-events-auto flex max-w-md items-start gap-2 rounded-2xl border px-4 py-3 text-sm shadow-lg',
              t.tone === 'good' && 'border-good/30 bg-surface',
              t.tone === 'critical' && 'border-critical/30 bg-surface',
              t.tone === 'info' && 'border-line bg-surface',
            )}
          >
            {t.tone === 'good' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-good" /> : t.tone === 'critical' ? <XCircle className="mt-0.5 size-4 shrink-0 text-critical" /> : <Info className="mt-0.5 size-4 shrink-0 text-accent-fg" />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  return useContext(Ctx);
}
