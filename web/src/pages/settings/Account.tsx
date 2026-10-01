import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Fingerprint, KeyRound, LifeBuoy, Laptop, Plus, Trash2 } from 'lucide-react';
import { api, errorText } from '../../lib/api';
import { deviceName, passkeysSupported, registerPasskey } from '../../lib/webauthn';
import { useToast } from '../../lib/toast';
import { dateTime, timeAgo } from '../../lib/format';
import { Badge, Button, Card, CardHeader, Field, Input, Modal, Notice } from '../../components/ui';

interface Passkey {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  backedUp: boolean;
}

interface SessionRow {
  id: string;
  current: boolean;
  createdAt: number;
  lastSeenAt: number;
  ip: string | null;
  userAgent: string | null;
  method: string;
}

function describeAgent(ua: string | null): string {
  if (!ua) return 'Dispozitiv necunoscut';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Dispozitiv';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${os} · ${browser}` : os;
}

const METHOD_LABEL: Record<string, string> = { passkey: 'Face ID', password: 'parolă + 2FA', setup: 'configurare' };

function Passkeys() {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { data } = useQuery({ queryKey: ['passkeys'], queryFn: () => api.get<Passkey[]>('/api/auth/passkeys') });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/auth/passkeys/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['passkeys'] });
      qc.invalidateQueries({ queryKey: ['session'] });
      toast('Passkey șters.', 'info');
    },
    onError: (err) => toast(errorText(err), 'critical'),
  });
  const add = async () => {
    setBusy(true);
    try {
      await registerPasskey(deviceName());
      qc.invalidateQueries({ queryKey: ['passkeys'] });
      qc.invalidateQueries({ queryKey: ['session'] });
      toast('Face ID activat pe acest dispozitiv.', 'good');
    } catch (err) {
      toast(errorText(err), 'critical');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="mb-5">
      <CardHeader
        title="Face ID / passkey-uri"
        subtitle="Pentru autentificare și pentru aprobarea acțiunilor riscante."
        icon={<Fingerprint className="size-4" />}
        action={
          passkeysSupported() ? (
            <Button size="sm" variant="primary" icon={<Plus className="size-4" />} loading={busy} onClick={add}>
              Adaugă acest dispozitiv
            </Button>
          ) : undefined
        }
      />
      <ul className="px-2 pb-2">
        {data?.map((p) => (
          <li key={p.id} className="flex items-center gap-3 rounded-xl px-2 py-2.5">
            <Fingerprint className="size-5 shrink-0 text-ink-3" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{p.name}</div>
              <div className="text-xs text-ink-3">
                adăugat {dateTime(p.createdAt)} · folosit {p.lastUsedAt ? timeAgo(p.lastUsedAt) : 'niciodată'}
                {p.backedUp ? ' · sincronizat în iCloud' : ''}
              </div>
            </div>
            <button className="rounded-lg p-2 text-ink-3 hover:bg-surface-3 hover:text-critical-ink" aria-label="Șterge" onClick={() => confirm(`Ștergi passkey-ul „${p.name}”?`) && del.mutate(p.id)}>
              <Trash2 className="size-4" />
            </button>
          </li>
        ))}
        {data && !data.length && <li className="px-2 pb-2 text-sm text-ink-3">Niciun passkey. Adaugă unul de pe iPhone pentru autentificare cu Face ID.</li>}
      </ul>
    </Card>
  );
}

function Sessions() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['sessions'], queryFn: () => api.get<SessionRow[]>('/api/auth/sessions') });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/api/auth/sessions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
    onError: (err) => toast(errorText(err), 'critical'),
  });
  const revokeOthers = useMutation({
    mutationFn: () => api.post<{ revoked: number }>('/api/auth/sessions/revoke-others'),
    onSuccess: (r) => {
      toast(`${r.revoked} sesiuni închise.`, 'good');
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (err) => toast(errorText(err), 'critical'),
  });
  return (
    <Card className="mb-5">
      <CardHeader
        title="Dispozitive conectate"
        icon={<Laptop className="size-4" />}
        action={
          (data?.length ?? 0) > 1 ? (
            <Button size="sm" variant="secondary" loading={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>
              Deconectează celelalte
            </Button>
          ) : undefined
        }
      />
      <ul className="px-2 pb-2">
        {data?.map((s) => (
          <li key={s.id} className="flex items-center gap-3 rounded-xl px-2 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                {describeAgent(s.userAgent)} {s.current && <Badge tone="good">acesta</Badge>}
              </div>
              <div className="text-xs text-ink-3">
                {s.ip ?? 'IP necunoscut'} · {METHOD_LABEL[s.method] ?? s.method} · activ {timeAgo(s.lastSeenAt)}
              </div>
            </div>
            {!s.current && (
              <Button size="sm" variant="ghost" onClick={() => revoke.mutate(s.id)}>
                Deconectează
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PasswordChange() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const change = useMutation({
    mutationFn: () => api.post('/api/auth/password/change', { current, next }),
    onSuccess: () => {
      toast('Parola a fost schimbată.', 'good');
      setCurrent('');
      setNext('');
      setNext2('');
    },
    onError: (err) => toast(errorText(err), 'critical'),
  });
  return (
    <Card className="mb-5">
      <CardHeader title="Parola" icon={<KeyRound className="size-4" />} />
      <form
        className="space-y-4 px-4 pb-4 sm:px-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (next !== next2) return toast('Parolele noi nu coincid.', 'critical');
          change.mutate();
        }}
      >
        <Field label="Parola actuală">
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Parola nouă" hint="Minim 12 caractere.">
            <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required minLength={12} />
          </Field>
          <Field label="Repetă parola nouă">
            <Input type="password" value={next2} onChange={(e) => setNext2(e.target.value)} autoComplete="new-password" required />
          </Field>
        </div>
        <Button type="submit" variant="secondary" loading={change.isPending}>
          Schimbă parola
        </Button>
      </form>
    </Card>
  );
}

function RecoveryCodes() {
  const toast = useToast();
  const [codes, setCodes] = useState<string[] | null>(null);
  const regen = useMutation({
    mutationFn: () => api.post<{ codes: string[] }>('/api/auth/recovery-codes'),
    onSuccess: (r) => setCodes(r.codes),
    onError: (err) => toast(errorText(err), 'critical'),
  });
  return (
    <Card className="mb-5">
      <CardHeader title="Coduri de recuperare" subtitle="Pentru cazul în care pierzi telefonul. Fiecare cod merge o singură dată." icon={<LifeBuoy className="size-4" />} />
      <div className="px-4 pb-4 sm:px-5">
        <Button variant="secondary" loading={regen.isPending} onClick={() => confirm('Codurile vechi nu vor mai funcționa. Generezi coduri noi?') && regen.mutate()}>
          Generează coduri noi
        </Button>
      </div>
      <Modal
        open={!!codes}
        onClose={() => setCodes(null)}
        title="Codurile noi de recuperare"
        size="sm"
        footer={
          <>
            <Button variant="secondary" icon={<Copy className="size-4" />} onClick={() => void navigator.clipboard?.writeText(codes?.join('\n') ?? '')}>
              Copiază
            </Button>
            <Button variant="primary" onClick={() => setCodes(null)}>
              Le-am salvat
            </Button>
          </>
        }
      >
        <Notice tone="warning">Salvează-le acum (de ex. în aplicația Parole). Nu le vei mai putea vedea.</Notice>
        <div className="mt-3 grid grid-cols-2 gap-2 rounded-2xl bg-surface-2 p-4 font-mono text-sm">
          {codes?.map((c) => (
            <div key={c}>{c}</div>
          ))}
        </div>
      </Modal>
    </Card>
  );
}

export function AccountTab() {
  return (
    <>
      <Passkeys />
      <Sessions />
      <PasswordChange />
      <RecoveryCodes />
    </>
  );
}
