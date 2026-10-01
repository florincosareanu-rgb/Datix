// Client HTTP pentru API-ul serverului: cookie de sesiune, antet anti-CSRF, erori clare,
// și confirmare automată (Face ID / cod 2FA) când serverul o cere.

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
  ) {
    super(message);
  }
}

type StepUpHandler = () => Promise<boolean>;
let stepUpHandler: StepUpHandler | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setStepUpHandler(h: StepUpHandler | null) {
  stepUpHandler = h;
}

export function setUnauthorizedHandler(h: (() => void) | null) {
  unauthorizedHandler = h;
}

async function raw(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(method !== 'GET' ? { 'X-Datix-CSRF': '1' } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  let res: Response;
  try {
    res = await raw(method, path, body);
  } catch {
    throw new ApiError('Nu mă pot conecta la server. Verifică internetul.', 0, 'network');
  }
  if (res.ok) {
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  let message = `Eroare ${res.status}`;
  let code: string | null = null;
  try {
    const data = (await res.json()) as { error?: string; code?: string | null };
    message = data.error ?? message;
    code = data.code ?? null;
  } catch {
    /* răspuns fără JSON */
  }
  if (res.status === 403 && code === 'step_up_required' && stepUpHandler && !retried) {
    const ok = await stepUpHandler();
    if (ok) return request<T>(method, path, body, true);
    throw new ApiError('Confirmarea a fost anulată.', 403, 'step_up_cancelled');
  }
  if (res.status === 401 && code === 'unauthenticated' && unauthorizedHandler) unauthorizedHandler();
  throw new ApiError(message, res.status, code);
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown = {}) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown = {}) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
  /** Descarcă un fișier (ex. pluginul WordPress), cu confirmare dacă e nevoie. */
  async download(path: string, filename: string, retried = false): Promise<void> {
    const res = await fetch(path, { credentials: 'same-origin' });
    if (res.status === 403 && !retried && stepUpHandler) {
      const data = (await res.json().catch(() => ({}))) as { code?: string };
      if (data.code === 'step_up_required' && (await stepUpHandler())) return api.download(path, filename, true);
    }
    if (!res.ok) throw new ApiError(`Descărcarea a eșuat (${res.status}).`, res.status, null);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
