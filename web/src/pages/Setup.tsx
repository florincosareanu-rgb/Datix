import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Fingerprint, KeyRound, ShieldCheck } from 'lucide-react';
import type { SessionInfoDTO } from '@datix/shared';
import { api, errorText } from '../lib/api';
import { deviceName, passkeysSupported, registerPasskey } from '../lib/webauthn';
import { Button, Field, Input, Notice } from '../components/ui';
import { DaxOrb } from '../components/brand';

type Step = 'account' | 'totp' | 'codes' | 'passkey';

function Frame({ step, children }: { step: number; children: React.ReactNode }) {
  return (
    <div className="aurora safe-top safe-bottom flex min-h-full items-center justify-center bg-page px-4 py-8">
      <div className="enter w-full max-w-md">
        <div className="mb-6 flex items-center gap-3">
          <DaxOrb size={44} />
          <div>
            <div className="font-display text-[22px] leading-tight font-semibold tracking-tight">DAX</div>
            <div className="text-[13px] text-ink-3">Configurare inițială · pasul {step} din 4</div>
          </div>
        </div>
        <div className="mb-4 flex gap-1.5" aria-hidden>
          {[1, 2, 3, 4].map((n) => (
            <span key={n} className={'h-1.5 flex-1 rounded-full ' + (n <= step ? 'bg-brand' : 'bg-surface-3')} />
          ))}
        </div>
        <div className="glass float-shadow rounded-[28px] border border-line/80 p-6 sm:p-7">{children}</div>
      </div>
    </div>
  );
}

export function SetupPage({ session }: { session: SessionInfoDTO }) {
  const qc = useQueryClient();
  const params = new URLSearchParams(window.location.search);
  const [step, setStep] = useState<Step>('account');
  const [token, setToken] = useState(params.get('token') ?? '');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [totp, setTotp] = useState<{ qrDataUrl: string; totpSecret: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    window.history.replaceState(null, '', '/');
    void qc.invalidateQueries({ queryKey: ['session'] });
  };

  if (step === 'account') {
    return (
      <Frame step={1}>
        <h1 className="font-display text-[24px] leading-tight font-semibold tracking-tight">Creează contul de administrator</h1>
        <p className="mt-1 mb-5 text-sm text-ink-2">Doar tu vei avea acces la agent. Contul se protejează cu parolă, cod 2FA și Face ID.</p>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (password !== password2) return setError('Parolele nu coincid.');
            void run(async () => {
              const r = await api.post<{ qrDataUrl: string; totpSecret: string }>('/api/setup/start', { token, displayName: name, email, password });
              setTotp(r);
              setStep('totp');
            });
          }}
        >
          {session.setupTokenRequired && (
            <Field label="Cod de instalare" hint="Apare la finalul instalării pe server (și în logurile aplicației).">
              <Input value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" required />
            </Field>
          )}
          <Field label="Numele tău">
            <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required placeholder="Florin" />
          </Field>
          <Field label="E-mail">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required placeholder="contact@datix.ro" />
          </Field>
          <Field label="Parolă" hint="Minim 12 caractere, cu litere mari, mici, cifre sau simboluri.">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={12} />
          </Field>
          <Field label="Repetă parola">
            <Input type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" required />
          </Field>
          {error && <Notice tone="critical">{error}</Notice>}
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
            Continuă
          </Button>
        </form>
      </Frame>
    );
  }

  if (step === 'totp' && totp) {
    return (
      <Frame step={2}>
        <h1 className="font-display text-[24px] leading-tight font-semibold tracking-tight">Activează autentificarea în doi pași</h1>
        <p className="mt-1 text-sm text-ink-2">
          Scanează codul QR cu o aplicație de autentificare (pe iPhone: aplicația <strong>Parole</strong> → Coduri de verificare, sau Google/Microsoft Authenticator).
        </p>
        <div className="my-5 flex justify-center">
          <img src={totp.qrDataUrl} alt="Cod QR pentru autentificare" className="size-48 rounded-xl border border-line bg-white p-2" />
        </div>
        <div className="mb-5 flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-xs">{totp.totpSecret}</code>
          <button
            className="text-ink-3 hover:text-ink"
            onClick={() => {
              void navigator.clipboard?.writeText(totp.totpSecret);
              setCopied(true);
            }}
            aria-label="Copiază cheia"
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </button>
        </div>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await api.post<{ recoveryCodes: string[] }>('/api/setup/totp', { code });
              setCodes(r.recoveryCodes);
              setStep('codes');
            });
          }}
        >
          <Field label="Codul de 6 cifre din aplicație">
            <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" required />
          </Field>
          {error && <Notice tone="critical">{error}</Notice>}
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} icon={<KeyRound className="size-4" />}>
            Verifică codul
          </Button>
        </form>
      </Frame>
    );
  }

  if (step === 'codes') {
    return (
      <Frame step={3}>
        <h1 className="font-display text-[24px] leading-tight font-semibold tracking-tight">Salvează codurile de recuperare</h1>
        <p className="mt-1 text-sm text-ink-2">Dacă pierzi telefonul, te poți autentifica cu unul dintre aceste coduri (fiecare merge o singură dată). Păstrează-le într-un loc sigur.</p>
        <div className="my-5 grid grid-cols-2 gap-2 rounded-2xl bg-surface-2 p-4 font-mono text-sm">
          {codes.map((c) => (
            <div key={c}>{c}</div>
          ))}
        </div>
        <div className="mb-4 flex gap-2">
          <Button variant="secondary" size="sm" icon={<Copy className="size-4" />} onClick={() => void navigator.clipboard?.writeText(codes.join('\n'))}>
            Copiază
          </Button>
        </div>
        <label className="mb-4 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
          Am salvat codurile într-un loc sigur
        </label>
        <Button variant="primary" size="lg" className="w-full" disabled={!saved} onClick={() => setStep('passkey')}>
          Continuă
        </Button>
      </Frame>
    );
  }

  return (
    <Frame step={4}>
      <div className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent-fg">
        <Fingerprint className="size-6" />
      </div>
      <h1 className="font-display text-[24px] leading-tight font-semibold tracking-tight">Activează Face ID</h1>
      <p className="mt-1 text-sm text-ink-2">Te vei autentifica și vei aproba acțiunile riscante ale agentului cu Face ID / Touch ID — rapid și sigur. Poți adăuga și alte dispozitive mai târziu.</p>
      {!passkeysSupported() && (
        <div className="mt-4">
          <Notice tone="warning">Browserul acesta nu suportă passkey-uri. Poți continua și le activezi de pe iPhone, din Setări → Securitate cont.</Notice>
        </div>
      )}
      {error && (
        <div className="mt-4">
          <Notice tone="critical">{error}</Notice>
        </div>
      )}
      <div className="mt-5 space-y-2">
        {passkeysSupported() && (
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            loading={busy}
            icon={<ShieldCheck className="size-5" />}
            onClick={() =>
              void run(async () => {
                await registerPasskey(deviceName());
                finish();
              })
            }
          >
            Activează Face ID pe acest dispozitiv
          </Button>
        )}
        <Button variant="ghost" size="lg" className="w-full" onClick={finish}>
          Mai târziu
        </Button>
      </div>
    </Frame>
  );
}
