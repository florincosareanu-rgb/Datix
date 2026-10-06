import type { SeoIdeaDTO, SeoOverviewDTO, SeoReportDTO, SeoRowDTO } from '@datix/shared';
import type { Services } from '../services';
import type { GscRow } from '../integrations/gsc';
import { errorMessage, safeJsonParse } from '../util/text';
import { DAY, zonedDate } from '../util/time';
import { latestInsight, saveInsight } from './insights';

// SEO pentru datix.ro din Google Search Console: comparație săptămână cu săptămână, ce urcă și ce scade,
// oportunități (multe afișări, puține clicuri, aproape de pagina 1), indexare, sitemap-uri și idei de
// articole pornind de la întrebările clienților din tichete.

export class SeoError extends Error {}

const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** Combină perioada curentă cu cea anterioară, pe cheie (interogare sau pagină). */
export function mergeRows(cur: GscRow[], prev: GscRow[]): SeoRowDTO[] {
  const prevMap = new Map(prev.map((r) => [r.keys[0] ?? '', r]));
  const out: SeoRowDTO[] = cur.map((r) => {
    const p = prevMap.get(r.keys[0] ?? '');
    return {
      key: r.keys[0] ?? '',
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: round(r.ctr * 100, 2),
      position: round(r.position),
      clicksPrev: p?.clicks ?? 0,
      impressionsPrev: p?.impressions ?? 0,
      positionPrev: p ? round(p.position) : null,
    };
  });
  // interogări dispărute (aveau clicuri înainte, acum deloc)
  const seen = new Set(out.map((r) => r.key));
  for (const p of prev) {
    const key = p.keys[0] ?? '';
    if (!seen.has(key) && p.clicks >= 2) out.push({ key, clicks: 0, impressions: 0, ctr: 0, position: 0, clicksPrev: p.clicks, impressionsPrev: p.impressions, positionPrev: round(p.position) });
  }
  return out;
}

export class SeoService {
  private running: Promise<SeoReportDTO> | null = null;

  constructor(private readonly s: Services) {
    s.integrations.setTester('gsc', () => this.test());
  }

  private property(): string {
    return this.s.settings.get().seo.property.trim();
  }

  async test(): Promise<string> {
    const gsc = this.s.integrations.gsc();
    if (!gsc) throw new SeoError('Lipește cheia JSON a contului de serviciu Google.');
    const sites = await gsc.sites();
    const prop = this.property();
    if (!sites.length) throw new SeoError(`Contul ${gsc.serviceEmail} nu are acces la nicio proprietate. Adaugă-l ca utilizator în Search Console (Setări → Utilizatori și permisiuni).`);
    if (prop && !sites.some((x) => x.siteUrl === prop)) throw new SeoError(`Proprietatea „${prop}” nu e accesibilă. Disponibile: ${sites.map((x) => x.siteUrl).join(', ')}.`);
    return `Conectat ca ${gsc.serviceEmail}. Proprietăți: ${sites.map((x) => x.siteUrl).join(', ')}.${prop ? '' : ' Alege proprietatea în setări.'}`;
  }

  overview(): SeoOverviewDTO {
    const configured = this.s.integrations.isConfigured('gsc');
    const report = latestInsight<SeoReportDTO>(this.s.db, 'seo')?.data ?? null;
    return {
      configured,
      message: configured ? (report ? null : 'Raportul nu a rulat încă. Apasă „Generează acum”.') : 'Conectează Google Search Console (Setări → Integrări).',
      report,
      running: !!this.running,
    };
  }

  /** Interogare directă (pentru agent). */
  async performance(opts: { days: number; dimension: 'query' | 'page' | 'date' | 'country' | 'device'; limit: number; filter?: string }): Promise<SeoRowDTO[]> {
    const gsc = this.s.integrations.gsc();
    const prop = this.property();
    if (!gsc || !prop) throw new SeoError('Google Search Console nu e conectat.');
    const end = Date.now() - 3 * DAY;
    const start = end - (opts.days - 1) * DAY;
    const filters = opts.filter ? [{ filters: [{ dimension: opts.dimension === 'page' ? 'page' : 'query', operator: 'contains', expression: opts.filter }] }] : undefined;
    const [cur, prev] = await Promise.all([
      gsc.query(prop, { startDate: day(start), endDate: day(end), dimensions: [opts.dimension], rowLimit: opts.limit, dimensionFilterGroups: filters }),
      gsc.query(prop, { startDate: day(start - opts.days * DAY), endDate: day(start - DAY), dimensions: [opts.dimension], rowLimit: opts.limit * 3, dimensionFilterGroups: filters }),
    ]);
    return mergeRows(cur, prev).slice(0, opts.limit);
  }

  async inspectUrl(url: string) {
    const gsc = this.s.integrations.gsc();
    const prop = this.property();
    if (!gsc || !prop) throw new SeoError('Google Search Console nu e conectat.');
    return gsc.inspect(prop, url);
  }

  generate(trigger: 'schedule' | 'manual' | 'agent'): Promise<SeoReportDTO> {
    this.running ??= this.doGenerate(trigger).finally(() => {
      this.running = null;
      this.s.bus.emit({ type: 'maintenance_changed', area: 'seo' });
    });
    return this.running;
  }

  private async doGenerate(trigger: string): Promise<SeoReportDTO> {
    const gsc = this.s.integrations.gsc();
    const prop = this.property();
    if (!gsc || !prop) throw new SeoError('Conectează Google Search Console și alege proprietatea (Setări → Integrări).');
    // datele Search Console vin cu ~2–3 zile întârziere
    const end = Date.now() - 3 * DAY;
    const start = end - 6 * DAY;
    const prevEnd = start - DAY;
    const prevStart = prevEnd - 6 * DAY;
    const period = { start: day(start), end: day(end), prevStart: day(prevStart), prevEnd: day(prevEnd) };
    const q = (s: string, e: string, dimensions: string[], rowLimit = 250) => gsc.query(prop, { startDate: s, endDate: e, dimensions, rowLimit });
    const [totCur, totPrev, daily, qCur, qPrev, pCur, pPrev, sitemaps] = await Promise.all([
      q(period.start, period.end, []),
      q(period.prevStart, period.prevEnd, []),
      q(day(end - 27 * DAY), period.end, ['date'], 40),
      q(period.start, period.end, ['query']),
      q(period.prevStart, period.prevEnd, ['query'], 500),
      q(period.start, period.end, ['page'], 100),
      q(period.prevStart, period.prevEnd, ['page'], 200),
      gsc.sitemaps(prop).catch(() => []),
    ]);
    const t = totCur[0];
    const tp = totPrev[0];
    const queries = mergeRows(qCur, qPrev);
    const pages = mergeRows(pCur, pPrev);
    const delta = (r: SeoRowDTO) => r.clicks - r.clicksPrev;

    const opportunities = queries
      .filter((r) => r.impressions >= 50 && r.position >= 4 && r.position <= 20 && r.ctr < 3)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 10);

    // indexarea paginilor-cheie (prima pagină + cele mai vizitate)
    const st = this.s.settings.get();
    const keyPages = st.seo.keyPages.length ? st.seo.keyPages : [st.sites.wordpressUrl, ...pages.sort((a, b) => b.clicks - a.clicks).slice(0, 4).map((p) => p.key)].filter(Boolean);
    const inspections = [];
    for (const url of [...new Set(keyPages)].slice(0, 8)) {
      try {
        inspections.push(await gsc.inspect(prop, url));
      } catch (err) {
        inspections.push({ url, verdict: null, coverageState: `Eroare: ${errorMessage(err)}`, indexingState: null, lastCrawlTime: null, robotsTxtState: null, googleCanonical: null });
      }
    }

    const report: SeoReportDTO = {
      generatedAt: Date.now(),
      property: prop,
      period,
      totals: {
        clicks: t?.clicks ?? 0,
        impressions: t?.impressions ?? 0,
        ctr: round((t?.ctr ?? 0) * 100, 2),
        position: round(t?.position ?? 0),
        clicksPrev: tp?.clicks ?? 0,
        impressionsPrev: tp?.impressions ?? 0,
        ctrPrev: round((tp?.ctr ?? 0) * 100, 2),
        positionPrev: round(tp?.position ?? 0),
      },
      daily: daily.map((r) => ({ date: r.keys[0] ?? '', clicks: r.clicks, impressions: r.impressions })).sort((a, b) => a.date.localeCompare(b.date)),
      topQueries: [...queries].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, 15),
      risingQueries: queries.filter((r) => delta(r) > 0).sort((a, b) => delta(b) - delta(a)).slice(0, 8),
      fallingQueries: queries.filter((r) => delta(r) < 0 && r.clicksPrev >= 2).sort((a, b) => delta(a) - delta(b)).slice(0, 8),
      opportunities,
      topPages: [...pages].sort((a, b) => b.clicks - a.clicks).slice(0, 10),
      fallingPages: pages.filter((r) => delta(r) < 0 && r.clicksPrev >= 2).sort((a, b) => delta(a) - delta(b)).slice(0, 8),
      sitemaps,
      inspections,
      ideas: [],
    };
    report.ideas = await this.ideas(report);
    saveInsight(this.s.db, 'seo', report, 400);

    if (trigger === 'schedule') {
      const change = report.totals.clicksPrev ? Math.round(((report.totals.clicks - report.totals.clicksPrev) / report.totals.clicksPrev) * 100) : null;
      const notIndexed = inspections.filter((i) => i.verdict && i.verdict !== 'PASS').length;
      void this.s.notifier.notify({
        kind: 'business',
        title: `🔎 SEO săptămâna aceasta: ${report.totals.clicks} clicuri${change != null ? ` (${change >= 0 ? '+' : ''}${change}%)` : ''}`,
        body: [opportunities.length ? `${opportunities.length} oportunități aproape de pagina 1` : null, notIndexed ? `${notIndexed} pagini-cheie neindexate` : null, report.ideas.length ? `${report.ideas.length} idei de articole` : null].filter(Boolean).join(' · ') || 'Detalii în aplicație.',
        priority: 'low',
        url: '/seo',
      });
    }
    return report;
  }

  /** Idei de articole din oportunitățile de căutare și din întrebările frecvente din tichete. */
  private async ideas(report: SeoReportDTO): Promise<SeoIdeaDTO[]> {
    const tickets = this.s.db
      .prepare("SELECT category, summary FROM ticket_jobs WHERE created_at > ? AND summary IS NOT NULL ORDER BY created_at DESC LIMIT 40")
      .all(Date.now() - 60 * DAY) as Array<{ category: string | null; summary: string }>;
    const fallback = (): SeoIdeaDTO[] =>
      report.opportunities.slice(0, 5).map((o) => ({
        title: `Ghid complet: ${o.key}`,
        query: o.key,
        why: `${o.impressions} afișări pe săptămână, poziția medie ${o.position}, dar doar ${o.ctr}% clicuri — un articol dedicat poate aduce site-ul pe pagina 1.`,
        outline: ['Răspunsul scurt, în primul paragraf', 'Pașii explicați pe înțeles', 'Greșeli frecvente', 'Cum vă poate ajuta Datix'],
      }));
    if (!this.s.llm.isAvailable() || this.s.llm.budgetExceeded()) return fallback();
    try {
      const input = {
        site: this.s.settings.get().sites.wordpressUrl,
        oportunitati: report.opportunities.map((o) => ({ cautare: o.key, afisari: o.impressions, pozitie: o.position, ctr: o.ctr })),
        cautari_principale: report.topQueries.slice(0, 10).map((x) => x.key),
        intrebari_din_tichete: tickets.map((x) => `${x.category ?? 'general'}: ${x.summary}`).slice(0, 30),
      };
      const text = await this.s.llm.complete(
        {
          model: this.s.settings.get().llm.model,
          thinking: false,
          maxTokens: 1400,
          messages: [
            {
              role: 'system',
              content:
                'Ești specialist SEO pentru o firmă românească de hosting și web design. Propune 5 articole de blog care pot aduce clienți noi, pornind de la căutările cu potențial și de la întrebările reale ale clienților. Pentru fiecare: titlu atractiv (română), căutarea țintă (sau null), de ce merită (1 propoziție, cu cifre dacă există) și 4–6 secțiuni. Răspunde STRICT cu JSON: [{"title":"","query":"","why":"","outline":[""]}]',
            },
            { role: 'user', content: JSON.stringify(input) },
          ],
        },
        'report',
      );
      const parsed = safeJsonParse<SeoIdeaDTO[]>(/\[[\s\S]*\]/.exec(text)?.[0], []);
      const ideas = parsed
        .filter((i) => i && typeof i.title === 'string')
        .slice(0, 6)
        .map((i) => ({ title: i.title.slice(0, 160), query: i.query ? String(i.query).slice(0, 120) : null, why: String(i.why ?? '').slice(0, 400), outline: (Array.isArray(i.outline) ? i.outline : []).map(String).slice(0, 8) }));
      return ideas.length ? ideas : fallback();
    } catch (err) {
      this.s.log.warn({ err: errorMessage(err) }, 'Ideile de articole (AI) au eșuat');
      return fallback();
    }
  }

  /** Pentru raportul zilnic: ultima comparație, pe scurt. */
  digest(): string | null {
    const r = latestInsight<SeoReportDTO>(this.s.db, 'seo');
    if (!r || Date.now() - r.at > 8 * DAY) return null;
    const t = r.data.totals;
    return `SEO (săpt. ${zonedDate(Date.parse(r.data.period.start))} → ${zonedDate(Date.parse(r.data.period.end))}): ${t.clicks} clicuri (anterior ${t.clicksPrev}), ${t.impressions} afișări, poziția medie ${t.position}.`;
  }
}
