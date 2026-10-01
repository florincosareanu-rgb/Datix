import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Fingerprint, KeyRound } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorText, setStepUpHandler } from './api';
import { passkeysSupported, stepUpWithPasskey } from './webauthn';
import { Button, Field, Input, Modal } from '../components/ui';
import type { SessionInfoDTO } from '@datix/shared';

const Ctx = createContext<() => Promise<boolean>>(async () => false);

/**
 * Confirmarea acțiunilor sensibile: Face ID (passkey) sau cod din aplicația de autentificare.
 * Se deschide automat când serverul răspunde „step_up_required”.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const session = qc.getQueryData<SessionInfoDTO>(['session']);
  const hasPasskey = !!session?.hasPasskey && passkeysSupported();

  const request = useCallback(() => {
    return new Promise<boolean>((resolve) => {
      resolver.current?.(false);
      resolver.current = resolve;
      setCode('');
      setError(null);
      setOpen(true);
    });
  }, []);

  useEffect(() => {
    setStepUpHandler(request);
    return () => setStepUpHandler(null);
  }, [request]);

  const finish = (ok: boolean) => {
    setOpen(false);
    resolver.current?.(ok);
    resolver.current = null;
    if (ok) qc.invalidateQueries({ queryKey: ['session'] });
  };

  const withPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      await stepUpWithPasskey();
      finish(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const withCode = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/stepup/totp', { code });
      finish(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Ctx.Provider value={request}>
      {children}
      <Modal open={open} onClose={() => finish(false)} title="Confirmă că ești tu" size="sm">
        <p className="mb-4 text-sm text-ink-2">Acțiunea e sensibilă, așa că îți cerem o confirmare rapidă.</p>
        {hasPasskey && (
          <Button variant="primary" size="lg" className="mb-4 w-full" onClick={withPasskey} loading={busy} icon={<Fingerprint className="size-5" />}>
            Confirmă cu Face ID
          </Button>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void withCode();
          }}
          className="space-y-3"
        >
          <Field label={hasPasskey ? 'Sau cu codul din aplicația de autentificare' : 'Codul din aplicația de autentificare'} hint="6 cifre, sau un cod de recuperare">
            <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
          </Field>
          {error && <p className="text-sm text-critical-ink">{error}</p>}
          <Button type="submit" variant={hasPasskey ? 'secondary' : 'primary'} className="w-full" disabled={code.trim().length < 6} loading={busy && !hasPasskey} icon={<KeyRound className="size-4" />}>
            Confirmă cu codul
          </Button>
        </form>
      </Modal>
    </Ctx.Provider>
  );
}

export function useStepUp() {
  return useContext(Ctx);
}
