import { gzipSync } from 'node:zlib';
import type { AnafApi, GscApi, MailboxApi } from '../integrations/types';
import type { Services } from '../services';
import type { AnafMessage } from '../integrations/anaf';
import type { GscRow } from '../integrations/gsc';
import { demoState } from './state';

// Simulări pentru modul demo: căsuța de monitorizare, ANAF e-Factura și Google Search Console.

const DAY = 86_400_000;
const fmtDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

// =============================================================================== căsuța (IMAP)

const DMARC_XML = (begin: number, end: number) => `<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <report_metadata>
    <org_name>google.com</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>${Math.floor(begin / 1000)}0042</report_id>
    <date_range><begin>${Math.floor(begin / 1000)}</begin><end>${Math.floor(end / 1000)}</end></date_range>
  </report_metadata>
  <policy_published><domain>datix.ro</domain><adkim>r</adkim><aspf>r</aspf><p>quarantine</p><sp>quarantine</sp><pct>100</pct></policy_published>
  <record>
    <row><source_ip>203.0.113.20</source_ip><count>412</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row>
    <identifiers><header_from>datix.ro</header_from></identifiers>
    <auth_results><dkim><domain>datix.ro</domain><result>pass</result></dkim><spf><domain>datix.ro</domain><result>pass</result></spf></auth_results>
  </record>
  <record>
    <row><source_ip>209.85.220.41</source_ip><count>6</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>fail</spf></policy_evaluated></row>
    <identifiers><header_from>datix.ro</header_from></identifiers>
    <auth_results><dkim><domain>datix.ro</domain><result>pass</result></dkim><spf><domain>gmail.com</domain><result>pass</result></spf></auth_results>
  </record>
  <record>
    <row><source_ip>185.220.101.33</source_ip><count>3</count><policy_evaluated><disposition>quarantine</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated></row>
    <identifiers><header_from>datix.ro</header_from></identifiers>
    <auth_results><spf><domain>datix.ro</domain><result>fail</result></spf></auth_results>
  </record>
</feedback>`;

export class DemoMailbox implements MailboxApi {
  async test() {
    return `Conectat la dax-monitor@datix.ro (demo): ${demoState.mailboxInbox.length} mesaje în Inbox.`;
  }

  async findBySubject(token: string) {
    const m = demoState.mailboxInbox.find((x) => x.subject.includes(token) && x.at <= Date.now());
    return m ? { uid: 1, receivedAt: m.at, authResults: 'mx.datix.ro; spf=pass smtp.mailfrom=datix.ro; dkim=pass header.d=datix.ro; dmarc=pass' } : null;
  }

  async deleteBySubject(prefix: string) {
    const before = demoState.mailboxInbox.length;
    demoState.mailboxInbox = demoState.mailboxInbox.filter((m) => !m.subject.includes(prefix));
    return before - demoState.mailboxInbox.length;
  }

  async takeDmarcReports() {
    if (demoState.dmarcDelivered) return [];
    demoState.dmarcDelivered = true;
    const end = Date.now() - DAY / 2;
    return [
      {
        uid: 10,
        subject: 'Report Domain: datix.ro Submitter: google.com Report-ID: 42',
        attachments: [{ filename: 'google.com!datix.ro.xml.gz', contentType: 'application/gzip', content: gzipSync(DMARC_XML(end - DAY, end)) }],
      },
    ];
  }
}

// =============================================================================== ANAF e-Factura

export function demoAnaf(_accessToken: string): AnafApi {
  const now = Date.now();
  const messages: AnafMessage[] = [
    ...[0.2, 0.9, 1.4, 2.6, 3.1, 4.8].map((d, i) => ({
      id: `30018${i}2210`,
      createdAt: now - d * DAY,
      cif: '41234567',
      uploadId: `50011${i}0362`,
      type: 'FACTURA TRIMISA',
      details: `Factura cu id_incarcare=50011${i}0362 emisa de cif_emitent=41234567 pentru cif_beneficiar=${18000000 + i * 37}`,
    })),
    {
      id: '3001877001',
      createdAt: now - 1.7 * DAY,
      cif: '41234567',
      uploadId: '5001198812',
      type: 'ERORI FACTURA',
      details: 'Erori de validare identificate la factura primita cu id_incarcare=5001198812',
    },
    {
      id: '3001877102',
      createdAt: now - 2.2 * DAY,
      cif: '41234567',
      uploadId: '5001199020',
      type: 'FACTURA PRIMITA',
      details: 'Factura cu id_incarcare=5001199020 emisa de cif_emitent=36610520 pentru cif_beneficiar=41234567',
    },
  ];
  return {
    async listMessages(_cif: string, days: number) {
      return messages.filter((m) => m.createdAt >= now - days * DAY);
    },
    async downloadErrors(id: string) {
      if (id !== '3001877001') return [];
      return [
        'E: validari globale  eroare: [BR-RO-111]-Daca Codul tarii vanzatorului (BT-40) este "RO", atunci Subdiviziunea tarii vanzatorului (BT-39) trebuie sa fie codificata folosind lista de coduri ISO 3166-2:RO (ex. "RO-B" pentru Municipiul Bucuresti).',
        'E: validari globale  eroare: [BR-CO-15]-Valoarea totala a facturii cu TVA (BT-112) = Valoarea totala a facturii fara TVA (BT-109) + Valoarea totala a TVA a facturii (BT-110).',
      ];
    },
  };
}

// =============================================================================== Google Search Console

const QUERIES: Array<[string, number, number, number]> = [
  // interogare, clicuri/săpt., afișări/săpt., poziție
  ['datix', 64, 120, 1.1],
  ['hosting wordpress romania', 22, 940, 7.4],
  ['gazduire web ieftina', 14, 1210, 9.8],
  ['hosting cu ssl gratuit', 9, 610, 11.2],
  ['configurare email iphone', 7, 880, 6.1],
  ['domeniu .ro ieftin', 6, 1450, 14.6],
  ['hosting directadmin', 5, 260, 5.3],
  ['mentenanta wordpress', 4, 390, 8.9],
  ['transfer site la alt hosting', 3, 520, 12.4],
  ['eroare 500 wordpress', 2, 760, 16.9],
];

const PAGES: Array<[string, number, number, number]> = [
  ['https://datix.ro/', 70, 1300, 3.2],
  ['https://datix.ro/gazduire-web/', 31, 2400, 8.1],
  ['https://datix.ro/blog/configurare-email-iphone/', 9, 1020, 6.3],
  ['https://datix.ro/domenii/', 6, 1600, 13.9],
  ['https://datix.ro/mentenanta-wordpress/', 5, 600, 9.4],
  ['https://datix.ro/contact/', 4, 180, 4.2],
];

function rows(table: Array<[string, number, number, number]>, recent: boolean): GscRow[] {
  return table.map(([key, clicks, impressions, position], i) => {
    // perioada anterioară: unele interogări urcă, altele coboară
    const f = recent ? 1 : [0.82, 1.35, 0.9, 1.1, 0.6, 1.2, 0.95, 0.7, 1.4, 0.85][i % 10]!;
    const c = Math.round(clicks * f);
    const im = Math.round(impressions * (recent ? 1 : 0.92));
    return { keys: [key], clicks: c, impressions: im, ctr: im ? c / im : 0, position: recent ? position : position + (f > 1 ? -1.3 : 1.1) };
  });
}

export class DemoGsc implements GscApi {
  readonly serviceEmail = 'dax-seo@dax-datix.iam.gserviceaccount.com';

  async sites() {
    return [{ siteUrl: 'sc-domain:datix.ro', permissionLevel: 'siteRestrictedUser' }];
  }

  async query(_site: string, body: { startDate: string; endDate: string; dimensions: string[] }) {
    const recent = Date.parse(body.endDate) > Date.now() - 6 * DAY;
    const dim = body.dimensions[0];
    if (dim === 'date') {
      const out: GscRow[] = [];
      for (let t = Date.parse(body.startDate); t <= Date.parse(body.endDate); t += DAY) {
        const d = new Date(t);
        const weekday = d.getUTCDay();
        const base = weekday === 0 || weekday === 6 ? 11 : 21;
        const clicks = base + ((d.getUTCDate() * 7) % 9);
        const impressions = clicks * 34 + ((d.getUTCDate() * 13) % 120);
        out.push({ keys: [fmtDay(t)], clicks, impressions, ctr: clicks / impressions, position: 8.4 - ((d.getUTCDate() % 5) * 0.2) });
      }
      return out;
    }
    if (dim === 'page') return rows(PAGES, recent);
    if (!dim) {
      const all = rows(QUERIES, recent);
      const clicks = all.reduce((a, r) => a + r.clicks, 0);
      const impressions = all.reduce((a, r) => a + r.impressions, 0);
      return [{ keys: [], clicks, impressions, ctr: clicks / impressions, position: recent ? 8.2 : 8.9 }];
    }
    return rows(QUERIES, recent);
  }

  async sitemaps() {
    return [
      { path: 'https://datix.ro/sitemap_index.xml', lastSubmitted: new Date(Date.now() - 40 * DAY).toISOString(), lastDownloaded: new Date(Date.now() - 2 * DAY).toISOString(), isPending: false, errors: 0, warnings: 1, submitted: 64, indexed: 51 },
    ];
  }

  async inspect(_site: string, url: string) {
    const blog = url.includes('/blog/');
    return {
      url,
      verdict: blog ? 'NEUTRAL' : 'PASS',
      coverageState: blog ? 'Crawled - currently not indexed' : 'Submitted and indexed',
      indexingState: 'INDEXING_ALLOWED',
      lastCrawlTime: new Date(Date.now() - (blog ? 9 : 2) * DAY).toISOString(),
      robotsTxtState: 'ALLOWED',
      googleCanonical: url,
    };
  }
}

// =============================================================================== pornire demo

/** În modul demo, completează imediat ecranele noi (încasări, clienți, SEO, backup, e-mail). */
export function demoWarmup(s: Services): void {
  const run = (name: string, fn: () => Promise<unknown>) => fn().catch((err) => s.log.warn({ err: String(err) }, `Pregătirea demo „${name}” a eșuat`));
  setTimeout(() => {
    void run('încasări', () => s.collections.scan('manual'));
    void run('clienți în risc', () => s.churn.analyze('manual'));
    void run('SEO', () => s.seo.generate('manual'));
    void run('backup', () => s.backups.run('manual'));
    void run('e-mail', () => s.email.runTest('manual'));
  }, 3000).unref();
}
