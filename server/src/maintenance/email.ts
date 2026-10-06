import { gunzipSync } from 'node:zlib';
import type { DmarcSourceDTO, DmarcSummaryDTO, EmailOverviewDTO, EmailTestDTO } from '@datix/shared';
import type { Services } from '../services';
import type { FindingInput } from '../monitoring/findings';
import { newId, randomToken } from '../util/ids';
import { errorMessage, safeJsonParse } from '../util/text';
import { DAY, HOUR, MINUTE, sleep } from '../util/time';
import { unzip } from '../util/unzip';

// Livrarea e-mailurilor: un test zilnic real (WHMCS trimite un e-mail clientului de test, DAX îl caută
// în căsuța de monitorizare), erorile de trimitere din jurnalul WHMCS și rapoartele DMARC (cine trimite
// e-mailuri în numele domeniului și dacă trec SPF/DKIM).

export const TEST_PREFIX = 'DAX-TEST-';

interface TestRow {
  id: string;
  token: string;
  sent_at: number;
  received_at: number | null;
  status: EmailTestDTO['status'];
  latency_sec: number | null;
  error: string | null;
}

export interface DmarcReport {
  org: string;
  reportId: string;
  domain: string | null;
  begin: number;
  end: number;
  records: Array<{ ip: string; count: number; disposition: string; dkim: string; spf: string }>;
}

const tag = (xml: string, name: string) => new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`, 'i').exec(xml)?.[1]?.trim() ?? null;

/** Raport DMARC agregat (XML, RFC 7489) → date utile. */
export function parseDmarc(xml: string): DmarcReport | null {
  if (!/<feedback/i.test(xml)) return null;
  const meta = tag(xml, 'report_metadata') ?? '';
  const range = tag(meta, 'date_range') ?? '';
  const policy = tag(xml, 'policy_published') ?? '';
  const records: DmarcReport['records'] = [];
  for (const block of xml.match(/<record>[\s\S]*?<\/record>/gi) ?? []) {
    const row = tag(block, 'row') ?? '';
    const evald = tag(row, 'policy_evaluated') ?? '';
    records.push({
      ip: tag(row, 'source_ip') ?? '?',
      count: Number(tag(row, 'count') ?? 0) || 0,
      disposition: tag(evald, 'disposition') ?? 'none',
      dkim: tag(evald, 'dkim') ?? 'fail',
      spf: tag(evald, 'spf') ?? 'fail',
    });
  }
  return {
    org: tag(meta, 'org_name') ?? 'necunoscut',
    reportId: tag(meta, 'report_id') ?? String(Date.now()),
    domain: tag(policy, 'domain'),
    begin: (Number(tag(range, 'begin')) || 0) * 1000,
    end: (Number(tag(range, 'end')) || 0) * 1000,
    records,
  };
}

/** Atașamentul unui raport DMARC (.zip, .gz sau .xml) → textul XML. */
export function dmarcXml(filename: string, content: Buffer): string[] {
  const name = filename.toLowerCase();
  if (name.endsWith('.zip') || content.subarray(0, 2).toString('latin1') === 'PK') {
    return unzip(content, { maxFiles: 5, maxBytes: 20 * 1024 * 1024 })
      .filter((f) => f.name.toLowerCase().endsWith('.xml'))
      .map((f) => f.data.toString('utf8'));
  }
  if (name.endsWith('.gz') || (content[0] === 0x1f && content[1] === 0x8b)) return [gunzipSync(content, { maxOutputLength: 20 * 1024 * 1024 }).toString('utf8')];
  return [content.toString('utf8')];
}

/** Un mesaj trece DMARC dacă trece aliniat fie DKIM, fie SPF. */
const passes = (r: { dkim: string; spf: string }) => r.dkim === 'pass' || r.spf === 'pass';

const toDTO = (r: TestRow): EmailTestDTO => ({ id: r.id, sentAt: r.sent_at, receivedAt: r.received_at, status: r.status, latencySec: r.latency_sec, error: r.error });

export class EmailError extends Error {}

export class EmailMonitor {
  private testing: Promise<EmailTestDTO> | null = null;

  constructor(private readonly s: Services) {}

  private domain(): string {
    const url = this.s.settings.get().sites.wordpressUrl || this.s.settings.get().sites.whmcsUrl;
    try {
      return new URL(url).hostname.replace(/^www\./, '').split('.').slice(-2).join('.');
    } catch {
      return '';
    }
  }

  // ------------------------------------------------------------ pregătire

  /** Creează căsuța dax-monitor@domeniu în DirectAdmin și o salvează în setări (parola rămâne doar criptată la DAX). */
  async setupMailbox(): Promise<{ mailbox: string }> {
    const da = this.s.integrations.directadmin();
    if (!da) throw new EmailError('Conectează DirectAdmin ca DAX să poată crea căsuța.');
    const domain = this.domain();
    if (!domain) throw new EmailError('Setează adresa site-ului (Setări → Site-uri).');
    const user = 'dax-monitor';
    const password = `${randomToken(12)}Aa1!`;
    await da.createEmailAccount(domain, user, password, 250);
    this.s.secrets.set('mailbox.password', password);
    const mailbox = `${user}@${domain}`;
    const current = this.s.settings.get().email;
    this.s.settings.update({ email: { mailbox, imapHost: current.imapHost || `mail.${domain}`, enabled: true } });
    this.s.audit.log({ actor: 'owner', action: 'email.mailbox_created', target: mailbox });
    return { mailbox };
  }

  /** Creează în WHMCS clientul de test (cu adresa căsuței), fără e-mail de bun venit. */
  async setupWhmcsClient(): Promise<{ clientId: number }> {
    const w = this.s.integrations.whmcs();
    if (!w) throw new EmailError('Conectează WHMCS.');
    const mailbox = this.s.settings.get().email.mailbox;
    if (!mailbox) throw new EmailError('Configurează întâi căsuța de monitorizare.');
    let clientId = await w.findClientByEmail(mailbox);
    clientId ??= await w.addClient({ firstname: 'DAX', lastname: 'Monitor (test e-mail)', companyname: 'Test intern DAX', email: mailbox, password: `${randomToken(16)}Aa1!` });
    this.s.settings.update({ email: { whmcsTestClientId: clientId } });
    this.s.audit.log({ actor: 'owner', action: 'email.test_client', target: String(clientId), details: mailbox });
    return { clientId };
  }

  // ------------------------------------------------------------ testul de livrare

  lastTests(limit = 14): EmailTestDTO[] {
    return (this.s.db.prepare('SELECT * FROM email_tests ORDER BY sent_at DESC LIMIT ?').all(limit) as TestRow[]).map(toDTO);
  }

  runTest(trigger: 'schedule' | 'manual' | 'agent'): Promise<EmailTestDTO> {
    this.testing ??= this.doTest(trigger).finally(() => {
      this.testing = null;
      this.s.bus.emit({ type: 'maintenance_changed', area: 'email' });
    });
    return this.testing;
  }

  private async doTest(_trigger: string): Promise<EmailTestDTO> {
    const w = this.s.integrations.whmcs();
    const mailbox = this.s.integrations.mailbox();
    const clientId = this.s.settings.get().email.whmcsTestClientId;
    if (!w || !mailbox || !clientId) throw new EmailError('Testul are nevoie de WHMCS, de căsuța de monitorizare și de clientul de test (Mentenanță → E-mail → Pregătește testul).');
    const token = `${TEST_PREFIX}${randomToken(5).toUpperCase()}`;
    const id = newId('et_');
    const sentAt = Date.now();
    this.s.db.prepare("INSERT INTO email_tests (id, token, sent_at, status) VALUES (?, ?, ?, 'waiting')").run(id, token, sentAt);
    this.s.bus.emit({ type: 'maintenance_changed', area: 'email' });
    const set = (status: EmailTestDTO['status'], patch: { received?: number | null; error?: string | null } = {}) => {
      const latency = patch.received ? Math.round((patch.received - sentAt) / 1000) : null;
      this.s.db.prepare('UPDATE email_tests SET status = ?, received_at = ?, latency_sec = ?, error = ? WHERE id = ?').run(status, patch.received ?? null, latency, patch.error ?? null, id);
      this.s.db.prepare('DELETE FROM email_tests WHERE sent_at < ?').run(Date.now() - 120 * DAY);
      return toDTO(this.s.db.prepare('SELECT * FROM email_tests WHERE id = ?').get(id) as TestRow);
    };

    try {
      await w.sendEmail({ clientId, subject: `${token} — test de livrare`, message: 'Mesaj automat trimis de DAX prin WHMCS, ca să verifice că e-mailurile către clienți pleacă și ajung. Poate fi ignorat.' });
    } catch (err) {
      const r = set('error', { error: `WHMCS nu a trimis e-mailul: ${errorMessage(err)}` });
      this.report(r);
      return r;
    }

    const demo = this.s.config.demoMode;
    const deadline = sentAt + (demo ? 8000 : 10 * MINUTE);
    let found: Awaited<ReturnType<typeof mailbox.findBySubject>> = null;
    let lastError: string | null = null;
    while (Date.now() < deadline) {
      await sleep(demo ? 250 : 20_000);
      try {
        found = await mailbox.findBySubject(token);
        lastError = null;
      } catch (err) {
        lastError = errorMessage(err);
      }
      if (found) break;
    }
    await mailbox.deleteBySubject(TEST_PREFIX).catch(() => undefined);
    const result = found
      ? set(found.receivedAt - sentAt > 5 * MINUTE ? 'late' : 'ok', { received: found.receivedAt })
      : set(lastError ? 'error' : 'missing', { error: lastError ? `Nu pot citi căsuța: ${lastError}` : 'E-mailul de test nu a ajuns în 10 minute.' });
    this.report(result);
    return result;
  }

  private report(test: EmailTestDTO): void {
    const findings: FindingInput[] = [];
    if (test.status === 'missing' || test.status === 'error') {
      findings.push({
        key: 'delivery',
        severity: 'high',
        title: test.status === 'missing' ? 'E-mailurile trimise din WHMCS nu ajung' : 'Testul de livrare a e-mailurilor a eșuat',
        details: test.error ?? undefined,
        recommendation: 'Verifică setările de e-mail din WHMCS (Setup → General Settings → Mail: SMTP), jurnalul de e-mailuri și dacă serverul e pe liste negre. Facturile și resetările de parolă depind de asta.',
      });
    } else if (test.status === 'late') {
      findings.push({ key: 'delivery', severity: 'medium', title: `E-mailurile din WHMCS ajung greu (${Math.round((test.latencySec ?? 0) / 60)} minute)`, recommendation: 'Coada de e-mail a serverului e aglomerată sau serverul SMTP răspunde greu.' });
    }
    // sursă separată: testul de livrare nu se amestecă cu verificările periodice (DMARC, jurnalul WHMCS)
    this.s.findings.report('email_delivery', findings);
  }

  // ------------------------------------------------------------ DMARC

  /** Citește rapoartele DMARC noi din căsuță și le salvează. */
  async processDmarc(): Promise<number> {
    const mailbox = this.s.integrations.mailbox();
    if (!mailbox || !this.s.settings.get().email.dmarc) return 0;
    const messages = await mailbox.takeDmarcReports(50);
    let saved = 0;
    for (const m of messages) {
      for (const a of m.attachments) {
        let xmls: string[] = [];
        try {
          xmls = dmarcXml(a.filename, a.content);
        } catch {
          continue;
        }
        for (const xml of xmls) {
          const r = parseDmarc(xml);
          if (!r) continue;
          const total = r.records.reduce((n, x) => n + x.count, 0);
          const passed = r.records.filter(passes).reduce((n, x) => n + x.count, 0);
          this.s.db
            .prepare('INSERT OR IGNORE INTO dmarc_reports (id, org, report_id, domain, date_begin, date_end, total, passed, failed, records, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(`${r.org}:${r.reportId}`, r.org, r.reportId, r.domain, r.begin, r.end, total, passed, total - passed, JSON.stringify(r.records), Date.now());
          saved++;
        }
      }
    }
    this.s.db.prepare('DELETE FROM dmarc_reports WHERE date_end < ?').run(Date.now() - 400 * DAY);
    return saved;
  }

  dmarcSummary(days = 30): DmarcSummaryDTO | null {
    const rows = this.s.db.prepare('SELECT org, date_begin, date_end, total, passed, failed, records FROM dmarc_reports WHERE date_end > ? ORDER BY date_end').all(Date.now() - days * DAY) as Array<{
      org: string;
      date_begin: number;
      date_end: number;
      total: number;
      passed: number;
      failed: number;
      records: string;
    }>;
    if (!rows.length) return null;
    const sources = new Map<string, DmarcSourceDTO>();
    for (const r of rows) {
      for (const rec of safeJsonParse<DmarcReport['records']>(r.records, [])) {
        const s = sources.get(rec.ip) ?? { ip: rec.ip, count: 0, passed: 0, failed: 0, spf: rec.spf, dkim: rec.dkim, disposition: rec.disposition };
        s.count += rec.count;
        if (passes(rec)) s.passed += rec.count;
        else {
          s.failed += rec.count;
          s.spf = rec.spf;
          s.dkim = rec.dkim;
          s.disposition = rec.disposition;
        }
        sources.set(rec.ip, s);
      }
    }
    return {
      periodStart: Math.min(...rows.map((r) => r.date_begin)),
      periodEnd: Math.max(...rows.map((r) => r.date_end)),
      reports: rows.length,
      messages: rows.reduce((n, r) => n + r.total, 0),
      passed: rows.reduce((n, r) => n + r.passed, 0),
      failed: rows.reduce((n, r) => n + r.failed, 0),
      reporters: [...new Set(rows.map((r) => r.org))],
      sources: [...sources.values()].sort((a, b) => b.failed - a.failed || b.count - a.count).slice(0, 30),
    };
  }

  // ------------------------------------------------------------ verificarea periodică

  /** Monitorul „livrarea e-mailurilor”: rapoarte DMARC, erori WHMCS, ultimul test. */
  async check(): Promise<{ status: 'up' | 'degraded' | 'down' | 'unknown'; message: string; details: unknown }> {
    const findings: FindingInput[] = [];
    let failures = 0;
    const w = this.s.integrations.whmcs();
    if (w) {
      const log = await w.getActivityLog({ limitnum: 250 }).catch(() => []);
      const since = Date.now() - DAY;
      const bad = log.filter((e) => /email sending failed|failed to send|smtp error|could not instantiate mail|mailer error/i.test(e.description) && new Date(e.date.replace(' ', 'T')).getTime() > since);
      failures = bad.length;
      if (bad.length) {
        findings.push({
          key: 'whmcs_failures',
          severity: bad.length >= 5 ? 'high' : 'medium',
          title: `${bad.length} e-mailuri WHMCS nu au putut fi trimise în ultimele 24 h`,
          details: bad[0]!.description.slice(0, 300),
          recommendation: 'Verifică setările SMTP din WHMCS (Setup → General Settings → Mail) și jurnalul System Logs → Email Message Log.',
        });
      }
    }
    let dmarcNew = 0;
    try {
      dmarcNew = await this.processDmarc();
    } catch (err) {
      this.s.log.warn({ err: errorMessage(err) }, 'Citirea rapoartelor DMARC a eșuat');
    }
    const summary = this.dmarcSummary(14);
    const spoof = summary?.sources.filter((x) => x.failed >= 1 && x.passed === 0) ?? [];
    if (spoof.length) {
      const total = spoof.reduce((n, x) => n + x.failed, 0);
      findings.push({
        key: 'dmarc_unauthorized',
        severity: total >= 50 ? 'high' : 'medium',
        title: `${total} e-mailuri trimise în numele domeniului de pe servere neautorizate (14 zile)`,
        details: spoof.slice(0, 5).map((x) => `${x.ip} (${x.failed})`).join(', '),
        recommendation: 'Dacă nu recunoști serverele, cineva încearcă să trimită e-mailuri false în numele tău: o politică DMARC „quarantine” sau „reject” le blochează. Dacă le recunoști (ex. un serviciu de newsletter), adaugă-le în SPF/DKIM.',
      });
    }
    const domain = this.domain();
    let record: string | null = null;
    if (domain) {
      try {
        record = (await this.s.integrations.net.emailAuth(domain, this.s.settings.get().monitoring.dnsResolvers)).dmarc;
      } catch {
        record = null;
      }
      const mailbox = this.s.settings.get().email.mailbox;
      if (this.s.settings.get().email.dmarc && mailbox && (!record || !record.toLowerCase().includes(mailbox.toLowerCase()))) {
        findings.push({
          key: 'dmarc_rua',
          severity: 'info',
          title: record ? 'Rapoartele DMARC nu vin în căsuța DAX' : 'Domeniul nu are politică DMARC',
          details: record ?? `_dmarc.${domain} lipsește`,
          recommendation: `Adaugă (sau modifică) înregistrarea TXT _dmarc.${domain}: „v=DMARC1; p=${record ? (/p=([a-z]+)/i.exec(record)?.[1] ?? 'none') : 'none'}; rua=mailto:${mailbox}”. DAX o poate face în Cloudflare, cu aprobarea ta.`,
        });
      }
    }
    this.s.findings.report('email', findings);
    const last = this.lastTests(1)[0] ?? null;
    const status = last?.status === 'missing' || last?.status === 'error' ? 'down' : failures || spoof.length || last?.status === 'late' ? 'degraded' : last || summary ? 'up' : 'unknown';
    const parts = [
      last ? `ultimul test: ${last.status === 'ok' ? `livrat în ${last.latencySec ?? '?'} s` : last.status === 'late' ? `livrat cu întârziere (${Math.round((last.latencySec ?? 0) / 60)} min)` : last.status === 'waiting' ? 'în curs' : 'NU a ajuns'}` : 'niciun test încă',
      summary ? `DMARC 14 zile: ${summary.messages} mesaje, ${summary.failed} respinse` : null,
      failures ? `${failures} erori de trimitere în WHMCS` : null,
      dmarcNew ? `${dmarcNew} rapoarte noi` : null,
    ].filter(Boolean);
    return { status, message: parts.join('; ') + '.', details: { last, dmarc: summary, failures, record } };
  }

  async overview(): Promise<EmailOverviewDTO> {
    const st = this.s.settings.get().email;
    const configured = this.s.integrations.isConfigured('mailbox');
    let record: string | null = null;
    const domain = this.domain();
    if (domain) record = await this.s.integrations.net.emailAuth(domain, this.s.settings.get().monitoring.dnsResolvers).then((r) => r.dmarc).catch(() => null);
    const failures = (this.s.db.prepare("SELECT COUNT(*) n FROM findings WHERE source = 'email' AND key = 'email:whmcs_failures' AND status = 'open'").get() as { n: number }).n;
    return {
      configured,
      message: configured ? null : 'Configurează căsuța de monitorizare (o creez eu în DirectAdmin dintr-o atingere).',
      mailbox: st.mailbox,
      whmcsTestReady: !!st.whmcsTestClientId && this.s.integrations.isConfigured('whmcs'),
      tests: this.lastTests(),
      dmarcRecord: record,
      dmarc: this.dmarcSummary(30),
      whmcsFailures24h: failures,
    };
  }

  /** E-mailul de test e programat zilnic; între timp, verificarea durează puțin. */
  shouldTestNow(): boolean {
    const last = this.lastTests(1)[0];
    return !last || Date.now() - last.sentAt > 20 * HOUR;
  }
}
