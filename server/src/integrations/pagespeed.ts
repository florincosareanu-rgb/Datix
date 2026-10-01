import { fetchWithRetry, IntegrationError, readJson } from './http';

const SERVICE = 'PageSpeed';

export interface PageSpeedResult {
  url: string;
  strategy: 'mobile' | 'desktop';
  at: number;
  scores: { performance: number | null; seo: number | null; accessibility: number | null; bestPractices: number | null };
  lab: { lcpMs: number | null; cls: number | null; tbtMs: number | null; fcpMs: number | null; speedIndexMs: number | null; ttfbMs: number | null };
  field: { lcpMs: number | null; inpMs: number | null; cls: number | null; category: string | null } | null;
  opportunities: Array<{ title: string; savingsMs: number | null }>;
}

type Audit = { score?: number | null; numericValue?: number; title?: string; details?: { type?: string; overallSavingsMs?: number } };

export async function runPageSpeed(url: string, strategy: 'mobile' | 'desktop', apiKey?: string | null): Promise<PageSpeedResult> {
  const params = new URLSearchParams({ url, strategy, locale: 'ro' });
  for (const c of ['performance', 'seo', 'accessibility', 'best-practices']) params.append('category', c);
  if (apiKey) params.set('key', apiKey);
  const res = await fetchWithRetry(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`, {
    service: SERVICE,
    timeoutMs: 120_000,
    retries: 1,
  });
  const data = await readJson<{
    error?: { message: string };
    lighthouseResult?: { categories?: Record<string, { score: number | null }>; audits?: Record<string, Audit> };
    loadingExperience?: { overall_category?: string; metrics?: Record<string, { percentile?: number; category?: string }> };
  }>(res, SERVICE);
  if (data.error) {
    const quota = /quota|rate/i.test(data.error.message);
    throw new IntegrationError(SERVICE, quota ? 'limita gratuită de interogări a fost atinsă — adaugă o cheie API PageSpeed în Setări.' : data.error.message, res.status);
  }
  const cats = data.lighthouseResult?.categories ?? {};
  const audits = data.lighthouseResult?.audits ?? {};
  const score = (k: string) => (cats[k]?.score == null ? null : Math.round((cats[k]!.score as number) * 100));
  const nv = (k: string) => (audits[k]?.numericValue == null ? null : Math.round(audits[k]!.numericValue as number));
  const m = data.loadingExperience?.metrics;
  const field = m
    ? {
        lcpMs: m.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? null,
        inpMs: m.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
        cls: m.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile != null ? m.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100 : null,
        category: data.loadingExperience?.overall_category ?? null,
      }
    : null;
  const opportunities = Object.values(audits)
    .filter((a) => a.details?.type === 'opportunity' && (a.details.overallSavingsMs ?? 0) > 100)
    .sort((a, b) => (b.details?.overallSavingsMs ?? 0) - (a.details?.overallSavingsMs ?? 0))
    .slice(0, 6)
    .map((a) => ({ title: a.title ?? '', savingsMs: a.details?.overallSavingsMs != null ? Math.round(a.details.overallSavingsMs) : null }));
  return {
    url,
    strategy,
    at: Date.now(),
    scores: { performance: score('performance'), seo: score('seo'), accessibility: score('accessibility'), bestPractices: score('best-practices') },
    lab: {
      lcpMs: nv('largest-contentful-paint'),
      cls: audits['cumulative-layout-shift']?.numericValue != null ? Math.round((audits['cumulative-layout-shift'].numericValue as number) * 1000) / 1000 : null,
      tbtMs: nv('total-blocking-time'),
      fcpMs: nv('first-contentful-paint'),
      speedIndexMs: nv('speed-index'),
      ttfbMs: nv('server-response-time'),
    },
    field,
    opportunities,
  };
}
