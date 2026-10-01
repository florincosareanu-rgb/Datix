import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Fingerprint, KeyRound } from 'lucide-react';
import { api, errorText } from '../lib/api';
import { loginWithPasskey, passkeysSupported } from '../lib/webauthn';
import { Button, Field, Input, Notice } from '../components/ui';
import { DaxOrb } from '../components/brand';

export function LoginPage() {
  const qc = useQueryClient();
  const canPasskey = passkeysSupported();
  const [mode, setMode] = useState<'passkey' | 'password'>(canPasskey ? 'passkey' : 'password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const done = () => {
    window.history.replaceState(null, '', '/');
    void qc.invalidateQueries({ queryKey: ['session'] });
  };

  const passkey = async () => {
    setBusy(true);
    setError(null);
    try {
      await loginWithPasskey();
      done();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="aurora flex min-h-full items-center justify-center bg-page px-4 pt-[calc(env(safe-area-inset-top)+40px)] pb-[calc(env(safe-area-inset-bottom)+40px)]">
      <div className="enter w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <DaxOrb size={68} glow className="mb-6" />
          <h1 className="font-display text-[34px] leading-none font-semibold tracking-tight">DAX</h1>
          <p className="mt-2 text-[15px] text-ink-2">Agentul de operațiuni pentru datix.ro și my.datix.ro</p>
        </div>
        <div className="glass float-shadow rounded-[28px] border border-line/80 p-6">
          {mode === 'passkey' ? (
            <div className="space-y-3">
              <Button variant="primary" size="lg" className="w-full" onClick={passkey} loading={busy} icon={<Fingerprint className="size-5" />}>
                Intră cu Face ID
              </Button>
              {error && <Notice tone="critical">{error}</Notice>}
              <Button variant="ghost" className="w-full" onClick={() => setMode('password')}>
                Folosește parola și codul 2FA
              </Button>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError(null);
                try {
                  await api.post('/api/auth/password', { email, password, code });
                  done();
                } catch (err) {
                  setError(errorText(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Field label="E-mail">
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
              </Field>
              <Field label="Parolă">
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
              </Field>
              <Field label="Cod 2FA" hint="Din aplicația de autentificare, sau un cod de recuperare.">
                <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required placeholder="123456" />
              </Field>
              {error && <Notice tone="critical">{error}</Notice>}
              <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} icon={<KeyRound className="size-4" />}>
                Intră
              </Button>
              {canPasskey && (
                <Button type="button" variant="ghost" className="w-full" onClick={() => setMode('passkey')}>
                  Folosește Face ID
                </Button>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
