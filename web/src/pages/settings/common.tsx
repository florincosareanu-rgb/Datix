import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckCircle2, CircleDashed, KeyRound, PlugZap, Trash2, XCircle } from 'lucide-react';
import type { AppSettings, IntegrationKey, SettingsResponseDTO } from '@datix/shared';
import { api, errorText } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { timeAgo } from '../../lib/format';
import { Button, Card, CardHeader, Input } from '../../components/ui';

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsResponseDTO>('/api/settings') });
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends Array<unknown> ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function useSaveSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (patch: DeepPartial<AppSettings>) => api.patch<SettingsResponseDTO>('/api/settings', patch),
    onSuccess: (d) => {
      qc.setQueryData(['settings'], d);
      qc.invalidateQueries({ queryKey: ['status'] });
      toast('Setările au fost salvate.', 'good');
    },
    onError: (err) => toast(errorText(err), 'critical'),
  });
}

/**
 * Formular pentru o secțiune din setări: ține o copie locală, arată „Salvează” doar când ceva s-a schimbat.
 */
export function SectionForm<K extends keyof AppSettings>({
  section,
  title,
  subtitle,
  icon,
  children,
}: {
  section: K;
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  children: (value: AppSettings[K], set: (patch: Partial<AppSettings[K]>) => void) => ReactNode;
}) {
  const { data } = useSettings();
  const save = useSaveSettings();
  const remote = data?.settings[section];
  const [draft, setDraft] = useState<AppSettings[K] | null>(null);
  const dirty = !!draft && !!remote && JSON.stringify(draft) !== JSON.stringify(remote);

  useEffect(() => {
    if (remote && !dirty) setDraft(structuredClone(remote));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(remote)]);

  if (!draft) return null;
  return (
    <Card className="mb-5">
      <CardHeader title={title} subtitle={subtitle} icon={icon} />
      <form
        className="px-4 pb-4 sm:px-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ [section]: draft } as DeepPartial<AppSettings>);
        }}
      >
        {children(draft, (patch) => setDraft((d) => (d ? { ...d, ...patch } : d)))}
        <div className={clsx('mt-4 flex justify-end gap-2', !dirty && 'hidden')}>
          <Button type="button" variant="ghost" onClick={() => remote && setDraft(structuredClone(remote))}>
            Renunță
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Salvează
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Câmp pentru o cheie secretă: nu se afișează niciodată, doar starea și ultimele caractere. */
export function SecretField({ secretKey, label, hint, placeholder }: { secretKey: string; label: string; hint?: ReactNode; placeholder?: string }) {
  const { data } = useSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const status = data?.secrets[secretKey];
  const set = useMutation({
    mutationFn: () => api.put<SettingsResponseDTO>(`/api/settings/secrets/${secretKey}`, { value: value.trim() }),
    onSuccess: (d) => {
      qc.setQueryData(['settings'], d);
      setValue('');
      setEditing(false);
      toast('Cheia a fost salvată criptat pe server.', 'good');
    },
    onError: (err) => toast(errorText(err), 'critical'),
  });
  const del = useMutation({
    mutationFn: () => api.del<SettingsResponseDTO>(`/api/settings/secrets/${secretKey}`),
    onSuccess: (d) => {
      qc.setQueryData(['settings'], d);
      toast('Cheia a fost ștearsă.', 'info');
    },
    onError: (err) => toast(errorText(err), 'critical'),
  });
  return (
    <div className="py-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-ink-2">{label}</span>
        {status?.configured ? (
          <span className="inline-flex items-center gap-1 text-xs text-good-ink">
            <KeyRound className="size-3.5" /> setată {status.hint ? `(${status.hint})` : ''}
          </span>
        ) : (
          <span className="text-xs text-ink-3">nesetată</span>
        )}
      </div>
      {status?.configured && !editing ? (
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(true)}>
            Schimbă
          </Button>
          <Button type="button" size="sm" variant="ghost" icon={<Trash2 className="size-4" />} loading={del.isPending} onClick={() => confirm('Ștergi această cheie?') && del.mutate()}>
            Șterge
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder ?? 'Lipește cheia aici'}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (value.trim()) set.mutate();
              }
            }}
          />
          <Button type="button" variant="primary" loading={set.isPending} disabled={!value.trim()} onClick={() => set.mutate()}>
            Salvează
          </Button>
          {editing && (
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
              Renunță
            </Button>
          )}
        </div>
      )}
      {hint && <p className="mt-1.5 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

/** Starea unei integrări + butonul de test. */
export function IntegrationTest({ integration }: { integration: IntegrationKey }) {
  const { data } = useSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const st = data?.integrations.find((i) => i.key === integration);
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>(`/api/integrations/${integration}/test`),
    onSuccess: (r) => {
      toast(r.message, r.ok ? 'good' : 'critical');
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['status'] });
    },
    onError: (err) => toast(errorText(err), 'critical'),
  });
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5">
      {st?.lastTestOk == null ? (
        <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-3">
          <CircleDashed className="size-4" /> Netestat
        </span>
      ) : st.lastTestOk ? (
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px] text-good-ink">
          <CheckCircle2 className="size-4 shrink-0" /> <span className="truncate">Funcționează · {timeAgo(st.lastTestAt)}</span>
        </span>
      ) : (
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px] text-critical-ink">
          <XCircle className="size-4 shrink-0" /> <span className="truncate">Eroare · {timeAgo(st.lastTestAt)}</span>
        </span>
      )}
      <Button type="button" size="sm" variant="secondary" className="ml-auto" icon={<PlugZap className="size-4" />} loading={test.isPending} onClick={() => test.mutate()}>
        Testează conexiunea
      </Button>
      {st?.lastTestMessage && !st.lastTestOk && <p className="w-full text-xs break-words text-critical-ink">{st.lastTestMessage}</p>}
      {st?.lastTestMessage && st.lastTestOk && <p className="w-full text-xs break-words text-ink-3">{st.lastTestMessage}</p>}
    </div>
  );
}

export function NumberInput({ value, onChange, min, max, step, suffix }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string }) {
  return (
    <div className="relative">
      <Input type="number" inputMode="decimal" value={Number.isFinite(value) ? value : ''} min={min} max={max} step={step ?? 1} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} className={suffix ? 'pr-14' : undefined} />
      {suffix && <span className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-sm text-ink-3">{suffix}</span>}
    </div>
  );
}

export function Grid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
}
