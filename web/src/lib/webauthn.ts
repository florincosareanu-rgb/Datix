import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnAbortService } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { api } from './api';

export const passkeysSupported = () => browserSupportsWebAuthn();

function friendly(err: unknown): Error {
  const e = err as { name?: string; message?: string };
  if (e?.name === 'NotAllowedError') return new Error('Confirmarea a fost anulată sau a expirat.');
  if (e?.name === 'InvalidStateError') return new Error('Acest dispozitiv are deja un passkey înregistrat.');
  if (e?.name === 'SecurityError') return new Error('Face ID funcționează doar pe adresa oficială a aplicației (HTTPS).');
  return err instanceof Error ? err : new Error(String(err));
}

/** Autentificare cu Face ID / Touch ID / passkey. */
export async function loginWithPasskey(): Promise<void> {
  const { challengeId, options } = await api.post<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>('/api/auth/passkey/options');
  let response;
  try {
    WebAuthnAbortService.cancelCeremony();
    response = await startAuthentication({ optionsJSON: options });
  } catch (err) {
    throw friendly(err);
  }
  await api.post('/api/auth/passkey/verify', { challengeId, response });
}

/** Confirmare pentru o acțiune sensibilă (step-up). */
export async function stepUpWithPasskey(): Promise<void> {
  const { challengeId, options } = await api.post<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>('/api/auth/stepup/options');
  let response;
  try {
    response = await startAuthentication({ optionsJSON: options });
  } catch (err) {
    throw friendly(err);
  }
  await api.post('/api/auth/stepup/verify', { challengeId, response });
}

export async function registerPasskey(name: string): Promise<void> {
  const { challengeId, options } = await api.post<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>('/api/auth/passkeys/options');
  let response;
  try {
    response = await startRegistration({ optionsJSON: options });
  } catch (err) {
    throw friendly(err);
  }
  await api.post('/api/auth/passkeys/verify', { challengeId, response, name });
}

export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Dispozitiv';
}
