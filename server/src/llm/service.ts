import type { AgentContext, UsageSummaryDTO } from '@datix/shared';
import type { DB } from '../db';
import type { SettingsService } from '../settings/service';
import type { SecretsService } from '../settings/secrets';
import { DeepSeekProvider } from './deepseek';
import { LlmError, type LlmProvider, type LlmRequest, type LlmResult, type LlmStreamEvent, type LlmUsage } from './types';
import { startOfZonedDay, startOfZonedMonth } from '../util/time';

/**
 * Serviciul AI: alege furnizorul (DeepSeek sau simulatorul din modul demo),
 * înregistrează consumul și costul fiecărei cereri și aplică limita lunară de buget.
 */
export class LlmService {
  private override: LlmProvider | null = null;

  constructor(
    private readonly db: DB,
    private readonly settings: SettingsService,
    private readonly secrets: SecretsService,
    private readonly demoProvider: LlmProvider | null,
  ) {}

  /** Pentru teste: forțează un furnizor anume. */
  setProviderOverride(p: LlmProvider | null): void {
    this.override = p;
  }

  provider(): LlmProvider {
    if (this.override) return this.override;
    const key = this.secrets.get('llm.apiKey');
    if (key) return new DeepSeekProvider(key, this.settings.get().llm.baseUrl);
    if (this.demoProvider) return this.demoProvider;
    throw new LlmError('Cheia API DeepSeek nu e configurată. Adaug-o în Setări → AI.', null, false);
  }

  isAvailable(): boolean {
    return !!this.override || !!this.secrets.get('llm.apiKey') || !!this.demoProvider;
  }

  isSimulated(): boolean {
    return !this.override && !this.secrets.get('llm.apiKey') && !!this.demoProvider;
  }

  costOf(usage: LlmUsage): number {
    const p = this.settings.get().llm;
    const miss = Math.max(0, usage.promptTokens - usage.cacheHitTokens);
    return (miss * p.priceInputPerM + usage.cacheHitTokens * p.priceCacheHitPerM + usage.completionTokens * p.priceOutputPerM) / 1_000_000;
  }

  monthCost(): number {
    const tz = this.settings.get().general.timezone;
    const row = this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) c FROM llm_usage WHERE at >= ?').get(startOfZonedMonth(Date.now(), tz)) as { c: number };
    return row.c;
  }

  budgetExceeded(): boolean {
    const s = this.settings.get().llm;
    return s.monthlyBudgetUsd > 0 && this.monthCost() >= s.monthlyBudgetUsd;
  }

  /** Aruncă eroare dacă bugetul lunar e depășit și oprirea automată e activă. */
  assertBudget(): void {
    const s = this.settings.get().llm;
    if (s.hardStopAtBudget && this.budgetExceeded()) {
      throw new LlmError(
        `Bugetul lunar pentru AI (${s.monthlyBudgetUsd.toFixed(2)} $) a fost atins. Monitorizarea continuă fără AI; poți mări bugetul din Setări → AI.`,
        null,
        false,
      );
    }
  }

  async stream(
    req: LlmRequest,
    onEvent: (e: LlmStreamEvent) => void,
    meta: { context: AgentContext | 'system'; runId?: string | null },
    signal?: AbortSignal,
  ): Promise<LlmResult & { costUsd: number }> {
    this.assertBudget();
    const result = await this.provider().stream(req, onEvent, signal);
    const costUsd = this.isSimulated() ? 0 : this.costOf(result.usage);
    this.db
      .prepare(
        'INSERT INTO llm_usage (at, model, context, run_id, prompt_tokens, cache_hit_tokens, completion_tokens, reasoning_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        Date.now(),
        result.model,
        meta.context,
        meta.runId ?? null,
        result.usage.promptTokens,
        result.usage.cacheHitTokens,
        result.usage.completionTokens,
        result.usage.reasoningTokens,
        costUsd,
      );
    return { ...result, costUsd };
  }

  /** Cerere simplă, fără unelte (rapoarte, rezumate). */
  async complete(req: Omit<LlmRequest, 'tools'>, context: AgentContext | 'system' = 'system'): Promise<string> {
    const r = await this.stream(req, () => {}, { context });
    return r.content.trim();
  }

  async testConnection(): Promise<string> {
    const s = this.settings.get().llm;
    if (this.isSimulated()) return 'Mod demo: agentul folosește un simulator (nu e configurată o cheie DeepSeek).';
    const p = this.provider();
    let models: string[] = [];
    try {
      models = (await p.listModels?.()) ?? [];
    } catch {
      models = [];
    }
    const r = await this.stream(
      { model: s.model, messages: [{ role: 'user', content: 'Răspunde doar cu cuvântul: OK' }], thinking: false, maxTokens: 20 },
      () => {},
      { context: 'system' },
    );
    const modelNote = models.length ? ` Modele disponibile: ${models.join(', ')}.` : '';
    const known = models.length && !models.includes(s.model) ? ` Atenție: „${s.model}” nu apare în listă.` : '';
    return `DeepSeek răspunde (${r.model}): „${r.content.trim().slice(0, 40)}”.${modelNote}${known}`;
  }

  usageSummary(): UsageSummaryDTO {
    const s = this.settings.get();
    const tz = s.general.timezone;
    const month = this.db
      .prepare(
        'SELECT COUNT(*) n, COALESCE(SUM(cost_usd),0) c, COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(cache_hit_tokens),0) h, COALESCE(SUM(completion_tokens),0) o FROM llm_usage WHERE at >= ?',
      )
      .get(startOfZonedMonth(Date.now(), tz)) as { n: number; c: number; p: number; h: number; o: number };
    const today = this.db.prepare('SELECT COALESCE(SUM(cost_usd),0) c FROM llm_usage WHERE at >= ?').get(startOfZonedDay(Date.now(), tz)) as { c: number };
    return {
      monthCostUsd: Math.round(month.c * 10000) / 10000,
      monthBudgetUsd: s.llm.monthlyBudgetUsd,
      monthRequests: month.n,
      monthPromptTokens: month.p,
      monthCacheHitTokens: month.h,
      monthCompletionTokens: month.o,
      todayCostUsd: Math.round(today.c * 10000) / 10000,
      budgetExceeded: s.llm.monthlyBudgetUsd > 0 && month.c >= s.llm.monthlyBudgetUsd,
    };
  }
}
