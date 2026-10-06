import { fetchWithRetry, IntegrationError } from './http';
import { unzip } from '../util/unzip';

// ANAF e-Factura (SPV): autorizare OAuth2 cu certificatul digital (o singură dată, din browser),
// apoi lista mesajelor (facturi trimise / primite / erori) și descărcarea detaliilor.
// Documentație: https://mfinante.gov.ro/static/10/eFactura/prezentare%20api%20efactura.pdf

const SERVICE = 'ANAF e-Factura';
const OAUTH = 'https://logincert.anaf.ro/anaf-oauth2/v1';
const API = 'https://api.anaf.ro';

export interface AnafTokens {
  accessToken: string;
  refreshToken: string;
  /** ms */
  expiresAt: number;
}

export interface AnafMessage {
  id: string;
  createdAt: number;
  cif: string;
  uploadId: string | null;
  type: string;
  details: string;
}

/** „202211011415” (ora României) → timestamp. */
export function parseAnafDate(value: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value.trim());
  if (!m) return Date.now();
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  // ANAF folosește ora României; aproximăm decalajul (UTC+2 iarna, UTC+3 vara)
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offset = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Bucharest', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(guess))
    .find((p) => p.type === 'timeZoneName')?.value;
  const hours = Number(/GMT([+-]\d+)/.exec(offset ?? '')?.[1] ?? 2);
  return guess - hours * 3_600_000;
}

/** Erorile din XML-ul de răspuns ANAF (atributele errorMessage). */
export function parseAnafErrors(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/errorMessage="([^"]*)"/g)) {
    const text = m[1]!
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .trim();
    if (text) out.push(text);
  }
  return out;
}

export function anafCif(cif: string): string {
  return cif.trim().toUpperCase().replace(/^RO/, '');
}

export class AnafClient {
  constructor(
    private readonly accessToken: string,
    private readonly environment: 'prod' | 'test' = 'prod',
  ) {}

  static authorizeUrl(clientId: string, redirectUri: string, state: string): string {
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state, token_content_type: 'jwt' });
    return `${OAUTH}/authorize?${q.toString()}`;
  }

  private static async token(params: Record<string, string>): Promise<AnafTokens> {
    const res = await fetchWithRetry(`${OAUTH}/token`, {
      service: SERVICE,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ ...params, token_content_type: 'jwt' }).toString(),
      timeoutMs: 30_000,
      retries: 1,
    });
    const text = await res.text();
    let data: { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
    try {
      data = JSON.parse(text);
    } catch {
      throw new IntegrationError(SERVICE, `răspuns neașteptat la autorizare (HTTP ${res.status}).`, res.status);
    }
    if (!res.ok || !data.access_token) {
      const why = data.error_description ?? data.error ?? `HTTP ${res.status}`;
      throw new IntegrationError(SERVICE, `autorizarea a eșuat: ${why}. Verifică Client ID, Client Secret și adresa de întoarcere (callback) înregistrată la ANAF.`, res.status);
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? params.refresh_token ?? '',
      expiresAt: Date.now() + (Number(data.expires_in) || 90 * 86_400) * 1000,
    };
  }

  static exchangeCode(o: { clientId: string; clientSecret: string; code: string; redirectUri: string }): Promise<AnafTokens> {
    return AnafClient.token({ grant_type: 'authorization_code', code: o.code, client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: o.redirectUri });
  }

  static refresh(o: { clientId: string; clientSecret: string; refreshToken: string }): Promise<AnafTokens> {
    return AnafClient.token({ grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: o.clientId, client_secret: o.clientSecret });
  }

  private async get(path: string, query: Record<string, string>): Promise<Response> {
    const url = `${API}/${this.environment}/FCTEL/rest/${path}?${new URLSearchParams(query).toString()}`;
    const res = await fetchWithRetry(url, {
      service: SERVICE,
      headers: { Authorization: `Bearer ${this.accessToken}`, Accept: 'application/json' },
      timeoutMs: 45_000,
      retries: 1,
    });
    if (res.status === 401 || res.status === 403) throw new IntegrationError(SERVICE, 'acces refuzat — reconectează ANAF din Setări (tokenul a expirat sau a fost revocat).', res.status);
    if (!res.ok) throw new IntegrationError(SERVICE, `${path}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`, res.status);
    return res;
  }

  /** Mesajele din ultimele `days` zile (1–60) pentru CIF. */
  async listMessages(cif: string, days: number): Promise<AnafMessage[]> {
    const res = await this.get('listaMesajeFactura', { zile: String(Math.max(1, Math.min(60, Math.round(days)))), cif: anafCif(cif) });
    const data = (await res.json()) as { mesaje?: Array<Record<string, string>>; eroare?: string };
    if (!data.mesaje) {
      // „Nu exista mesaje in ultimele N zile” nu e o eroare
      if (data.eroare && !/nu exista mesaje/i.test(data.eroare)) throw new IntegrationError(SERVICE, data.eroare);
      return [];
    }
    return data.mesaje.map((m) => ({
      id: String(m.id ?? ''),
      createdAt: parseAnafDate(String(m.data_creare ?? '')),
      cif: String(m.cif ?? ''),
      uploadId: m.id_solicitare ? String(m.id_solicitare) : null,
      type: String(m.tip ?? ''),
      details: String(m.detalii ?? ''),
    }));
  }

  /** Arhiva unui mesaj; pentru erori întoarce lista de erori din XML. */
  async downloadErrors(id: string): Promise<string[]> {
    const res = await this.get('descarcare', { id });
    const buf = Buffer.from(await res.arrayBuffer());
    const files = unzip(buf, { maxFiles: 10, maxBytes: 5 * 1024 * 1024 });
    const errors: string[] = [];
    for (const f of files) if (/\.xml$/i.test(f.name) && !/semnatura/i.test(f.name)) errors.push(...parseAnafErrors(f.data.toString('utf8')));
    return errors;
  }
}

/** Tipul mesajului ANAF, normalizat. */
export function anafMessageType(tip: string): 'sent' | 'received' | 'error' | 'buyer_message' | 'other' {
  const t = tip.toUpperCase();
  if (t.includes('ERORI')) return 'error';
  if (t.includes('TRIMISA')) return 'sent';
  if (t.includes('PRIMITA')) return 'received';
  if (t.includes('MESAJ CUMPARATOR')) return 'buyer_message';
  return 'other';
}
