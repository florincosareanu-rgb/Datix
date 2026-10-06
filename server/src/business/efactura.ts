import type { EfacturaMessageDTO, EfacturaOverviewDTO } from '@datix/shared';
import type { Services } from '../services';
import type { AnafApi } from '../integrations/types';
import type { FindingInput } from '../monitoring/findings';
import { AnafClient, anafCif, anafMessageType } from '../integrations/anaf';
import { deleteMeta, getMeta, setMeta } from '../db';
import { randomToken } from '../util/ids';
import { errorMessage, safeJsonParse, truncate } from '../util/text';
import { DAY } from '../util/time';

// e-Factura: DAX citește mesajele din SPV (facturi trimise, primite, respinse) direct de la ANAF, indiferent
// de programul cu care se emit facturile. Autorizarea se face o singură dată, cu certificatul digital.

interface MessageRow {
  id: string;
  cif: string;
  created_at: number;
  type: EfacturaMessageDTO['type'];
  upload_id: string | null;
  details: string | null;
  errors: string | null;
  explanation: string | null;
  seen_at: number;
}

const toDTO = (r: MessageRow): EfacturaMessageDTO => ({
  id: r.id,
  createdAt: r.created_at,
  type: r.type,
  uploadId: r.upload_id,
  details: r.details ?? '',
  errors: safeJsonParse<string[]>(r.errors, []),
  explanation: r.explanation,
});

const META_STATE = 'anaf_oauth_state';
const META_ACCESS_EXPIRES = 'anaf_access_expires';
const META_REFRESH_SINCE = 'anaf_refresh_since';
const META_LAST_CHECK = 'anaf_last_check';
const REFRESH_LIFETIME = 365 * DAY;

export class EfacturaError extends Error {}

export class EfacturaService {
  constructor(private readonly s: Services) {
    s.integrations.setTester('anaf', () => this.test());
  }

  redirectUri(): string {
    return `${this.s.config.appUrl}/api/integrations/anaf/callback`;
  }

  // ------------------------------------------------------------ autorizare

  /** Adresa la care proprietarul se autentifică cu certificatul digital (pe calculatorul cu tokenul). */
  authorizeUrl(): string {
    const e = this.s.settings.get().efactura;
    if (!e.clientId || !this.s.secrets.has('anaf.clientSecret')) throw new EfacturaError('Completează Client ID și Client Secret (aplicația înregistrată în portalul ANAF).');
    const state = randomToken(18);
    setMeta(this.s.db, META_STATE, JSON.stringify({ state, until: Date.now() + 20 * 60_000 }));
    return AnafClient.authorizeUrl(e.clientId, this.redirectUri(), state);
  }

  async handleCallback(code: string, state: string): Promise<void> {
    const saved = safeJsonParse<{ state: string; until: number } | null>(getMeta(this.s.db, META_STATE), null);
    deleteMeta(this.s.db, META_STATE);
    if (!saved || saved.state !== state || saved.until < Date.now()) throw new EfacturaError('Cererea de autorizare a expirat sau nu a pornit din DAX. Încearcă din nou din Setări.');
    const e = this.s.settings.get().efactura;
    const secret = this.s.secrets.get('anaf.clientSecret');
    if (!e.clientId || !secret) throw new EfacturaError('Lipsesc Client ID / Client Secret.');
    const tokens = await AnafClient.exchangeCode({ clientId: e.clientId, clientSecret: secret, code, redirectUri: this.redirectUri() });
    this.saveTokens(tokens.accessToken, tokens.refreshToken, tokens.expiresAt);
    setMeta(this.s.db, META_REFRESH_SINCE, String(Date.now()));
    this.s.settings.update({ efactura: { enabled: true } });
    this.s.audit.log({ actor: 'owner', action: 'efactura.connected', target: anafCif(e.cif) });
  }

  private saveTokens(access: string, refresh: string, expiresAt: number): void {
    this.s.secrets.set('anaf.accessToken', access);
    if (refresh) this.s.secrets.set('anaf.refreshToken', refresh);
    setMeta(this.s.db, META_ACCESS_EXPIRES, String(expiresAt));
  }

  disconnect(): void {
    this.s.secrets.delete('anaf.accessToken');
    this.s.secrets.delete('anaf.refreshToken');
    deleteMeta(this.s.db, META_ACCESS_EXPIRES);
    deleteMeta(this.s.db, META_REFRESH_SINCE);
    this.s.audit.log({ actor: 'owner', action: 'efactura.disconnected' });
  }

  /** Client ANAF cu token valid (reîmprospătat automat cu 7 zile înainte de expirare). */
  private async client(): Promise<AnafApi> {
    if (this.s.integrations.isDemo) return this.s.integrations.anafClient('demo');
    const e = this.s.settings.get().efactura;
    let access = this.s.secrets.get('anaf.accessToken');
    const refresh = this.s.secrets.get('anaf.refreshToken');
    const secret = this.s.secrets.get('anaf.clientSecret');
    if (!refresh || !secret || !e.clientId) throw new EfacturaError('ANAF nu e conectat (Setări → Integrări → e-Factura → Conectează).');
    const expires = Number(getMeta(this.s.db, META_ACCESS_EXPIRES) ?? 0);
    if (!access || expires - Date.now() < 7 * DAY) {
      const t = await AnafClient.refresh({ clientId: e.clientId, clientSecret: secret, refreshToken: refresh });
      this.saveTokens(t.accessToken, t.refreshToken, t.expiresAt);
      if (t.refreshToken && t.refreshToken !== refresh) setMeta(this.s.db, META_REFRESH_SINCE, String(Date.now()));
      access = t.accessToken;
    }
    return this.s.integrations.anafClient(access);
  }

  async test(): Promise<string> {
    const cif = this.s.settings.get().efactura.cif;
    if (!cif) throw new EfacturaError('Completează CIF-ul firmei.');
    const msgs = await (await this.client()).listMessages(cif, 5);
    return `Conectat la SPV pentru CIF ${anafCif(cif)}: ${msgs.length} mesaje în ultimele 5 zile.`;
  }

  // ------------------------------------------------------------ verificare

  /** Explicația pe înțeles a erorilor (AI), dacă bugetul permite. */
  private async explain(errors: string[]): Promise<string | null> {
    if (!errors.length || !this.s.llm.isAvailable() || this.s.llm.budgetExceeded()) return null;
    try {
      const text = await this.s.llm.complete(
        {
          model: this.s.settings.get().llm.model,
          thinking: false,
          maxTokens: 400,
          messages: [
            {
              role: 'system',
              content:
                'Ești consultant e-Factura în România. Explică pe scurt (maxim 4 propoziții, în română), pentru un proprietar de firmă care nu e contabil, ce înseamnă erorile de validare ANAF primite și ce trebuie corectat concret în factură înainte de retrimitere. Fără introduceri.',
            },
            { role: 'user', content: errors.join('\n') },
          ],
        },
        'system',
      );
      return text.trim() ? truncate(text.trim(), 1200, '…') : null;
    } catch {
      return null;
    }
  }

  /** Monitorul e-Factura: mesaje noi, facturi respinse, expirarea autorizării. */
  async check(): Promise<{ status: 'up' | 'degraded' | 'down' | 'unknown'; message: string; details: unknown }> {
    const e = this.s.settings.get().efactura;
    if (!e.cif) return { status: 'unknown', message: 'CIF-ul firmei nu e completat.', details: null };
    const client = await this.client();
    // prima verificare aduce istoricul pe 30 de zile; apoi doar ultimele 3 (ANAF permite până la 60)
    const first = !getMeta(this.s.db, META_LAST_CHECK);
    const messages = await client.listMessages(e.cif, first ? 30 : 3);
    const findings: FindingInput[] = [];
    let newErrors = 0;
    for (const m of messages) {
      if (this.s.db.prepare('SELECT 1 FROM efactura_messages WHERE id = ?').get(m.id)) continue;
      const type = anafMessageType(m.type);
      let errors: string[] = [];
      let explanation: string | null = null;
      if (type === 'error') {
        // erorile mai vechi de 7 zile din istoric sunt doar afișate, nu semnalate (probabil deja rezolvate)
        const recent = m.createdAt > Date.now() - 7 * DAY;
        if (recent) newErrors++;
        try {
          errors = await client.downloadErrors(m.id);
        } catch (err) {
          errors = [`Nu am putut descărca detaliile: ${errorMessage(err)}`];
        }
        explanation = await this.explain(errors);
        if (recent) findings.push({
          key: `event:${m.id}`,
          severity: 'high',
          title: `Factură respinsă de ANAF (index ${m.uploadId ?? m.id})`,
          details: truncate(errors.join(' · ') || m.details, 900, '…'),
          recommendation: explanation ?? 'Corectează factura în programul de facturare și retrimite-o în SPV (termenul legal: 5 zile lucrătoare de la emitere).',
        });
      }
      this.s.db
        .prepare('INSERT OR IGNORE INTO efactura_messages (id, cif, created_at, type, upload_id, details, errors, explanation, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(m.id, anafCif(e.cif), m.createdAt, type, m.uploadId, m.details, JSON.stringify(errors), explanation, Date.now());
    }
    const since = Number(getMeta(this.s.db, META_REFRESH_SINCE) ?? 0);
    if (!this.s.integrations.isDemo && since && Date.now() - since > REFRESH_LIFETIME - 30 * DAY) {
      const daysLeft = Math.max(0, Math.round((since + REFRESH_LIFETIME - Date.now()) / DAY));
      findings.push({ key: 'reauth', severity: daysLeft < 7 ? 'high' : 'medium', title: `Autorizarea ANAF expiră în ${daysLeft} zile`, recommendation: 'Reconectează ANAF din Setări → Integrări → e-Factura (ai nevoie de certificatul digital).' });
    }
    this.s.findings.report('efactura', findings, { notifyFrom: 'high' });
    setMeta(this.s.db, META_LAST_CHECK, String(Date.now()));
    this.s.bus.emit({ type: 'maintenance_changed', area: 'efactura' });
    const c = this.counts(7);
    const openErrors = (this.s.db.prepare("SELECT COUNT(*) n FROM findings WHERE source = 'efactura' AND status = 'open' AND key LIKE 'efactura:event:%'").get() as { n: number }).n;
    return {
      status: openErrors ? 'degraded' : 'up',
      message: `Ultimele 7 zile: ${c.sent} facturi trimise, ${c.errors} respinse, ${c.received} primite${newErrors ? ` · ${newErrors} erori noi` : ''}.`,
      details: c,
    };
  }

  private counts(days: number): EfacturaOverviewDTO['counts7d'] {
    const rows = this.s.db.prepare('SELECT type, COUNT(*) n FROM efactura_messages WHERE created_at > ? GROUP BY type').all(Date.now() - days * DAY) as Array<{ type: string; n: number }>;
    const n = (t: string) => rows.find((r) => r.type === t)?.n ?? 0;
    return { sent: n('sent'), received: n('received'), errors: n('error') };
  }

  overview(): EfacturaOverviewDTO {
    const e = this.s.settings.get().efactura;
    const demo = this.s.integrations.isDemo;
    const connected = demo ? e.enabled : this.s.secrets.has('anaf.refreshToken');
    const since = Number(getMeta(this.s.db, META_REFRESH_SINCE) ?? 0);
    const configured = !!e.cif && (demo || (!!e.clientId && this.s.secrets.has('anaf.clientSecret')));
    return {
      configured,
      connected,
      message: !configured
        ? 'Completează CIF-ul și datele aplicației ANAF (Setări → Integrări → e-Factura).'
        : !connected
          ? 'Apasă „Conectează ANAF” pe calculatorul cu certificatul digital.'
          : null,
      cif: e.cif,
      environment: e.environment,
      redirectUri: this.redirectUri(),
      accessExpiresAt: Number(getMeta(this.s.db, META_ACCESS_EXPIRES) ?? 0) || null,
      refreshExpiresAt: since ? since + REFRESH_LIFETIME : null,
      lastCheckAt: Number(getMeta(this.s.db, META_LAST_CHECK) ?? 0) || null,
      counts7d: this.counts(7),
      messages: (this.s.db.prepare('SELECT * FROM efactura_messages ORDER BY created_at DESC LIMIT 60').all() as MessageRow[]).map(toDTO),
    };
  }
}
