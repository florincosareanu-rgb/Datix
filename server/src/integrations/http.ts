// Ajutor comun pentru apeluri HTTP către API-uri externe (timeout, reîncercări, erori clare).

export class IntegrationError extends Error {
  constructor(
    public readonly service: string,
    message: string,
    public readonly status: number | null = null,
    public readonly retryable = false,
  ) {
    super(`${service}: ${message}`);
  }
}

export interface FetchJsonOptions {
  service: string;
  method?: string;
  headers?: Record<string, string>;
  body?: RequestInit['body'];
  timeoutMs?: number;
  retries?: number;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchWithRetry(url: string, opts: FetchJsonOptions): Promise<Response> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: opts.headers,
        body: opts.body ?? undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        redirect: 'follow',
      });
      if (RETRYABLE.has(res.status) && attempt < retries) {
        const ra = Number(res.headers.get('retry-after'));
        await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? Math.min(ra, 10) * 1000 : 800 * (attempt + 1)));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
    }
  }
  const e = lastErr as Error;
  const msg = e?.name === 'TimeoutError' ? 'nu a răspuns în timp util' : `conexiune eșuată (${e?.message ?? 'eroare necunoscută'})`;
  throw new IntegrationError(opts.service, msg, null, true);
}

export async function readJson<T>(res: Response, service: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new IntegrationError(service, `răspuns invalid (HTTP ${res.status}): ${text.slice(0, 200)}`, res.status);
  }
}
