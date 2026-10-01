import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Fingerprint, KeyRound } from 'lucide-react';
import { api, errorText } from '../lib/api';
import { loginWithPasskey, passkeysSupported } from '../lib/webauthn';
import { Button, Field, Input, Notice } from '../components/ui';

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
    <div className="safe-top safe-bottom flex min-h-full items-center justify-center bg-page px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <img src="/icons/favicon.svg" alt="" className="mb-4 size-16 rounded-2xl shadow-sm" />
          <h1 className="text-2xl font-semibold tracking-tight">Datix AI</h1>
          <p className="mt-1 text-sm text-ink-2">Agentul de operațiuni pentru datix.ro și my.datix.ro</p>
        </div>
        <div className="rounded-3xl border border-line bg-surface p-5 shadow-sm">
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
