import { useQuery } from '@tanstack/react-query';
import { Brain, Coins, ShieldCheck } from 'lucide-react';
import type { UsageSummaryDTO } from '@datix/shared';
import { api } from '../../lib/api';
import { compact, usd } from '../../lib/format';
import { Card, CardHeader, Field, Input, Notice, Segmented, Select, Toggle } from '../../components/ui';
import { Meter } from '../../components/charts';
import { Grid, IntegrationTest, NumberInput, SecretField, SectionForm } from './common';

const MODELS = [
  { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash — rapid și foarte ieftin (recomandat)' },
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro — mai atent, mai scump' },
];

function ModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const known = MODELS.some((m) => m.value === value);
  return (
    <Select value={known ? value : '__custom'} onChange={(e) => onChange(e.target.value === '__custom' ? value : e.target.value)}>
      {MODELS.map((m) => (
        <option key={m.value} value={m.value}>
          {m.label}
        </option>
      ))}
      {!known && <option value="__custom">{value}</option>}
    </Select>
  );
}

function Usage() {
  const { data } = useQuery({ queryKey: ['usage'], queryFn: () => api.get<UsageSummaryDTO>('/api/usage'), refetchInterval: 60_000 });
  if (!data) return null;
  const pctUsed = data.monthBudgetUsd > 0 ? (data.monthCostUsd / data.monthBudgetUsd) * 100 : null;
  const cacheRate = data.monthPromptTokens > 0 ? Math.round((data.monthCacheHitTokens / data.monthPromptTokens) * 100) : null;
  return (
    <Card className="mb-5">
      <CardHeader title="Consum luna aceasta" icon={<Coins className="size-4" />} />
      <div className="space-y-4 px-4 pb-4 sm:px-5">
        <Meter label={`${usd(data.monthCostUsd)} din ${usd(data.monthBudgetUsd)}`} valuePct={pctUsed} detail={`azi: ${usd(data.todayCostUsd)} · ${data.monthRequests} cereri`} />
        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <div className="rounded-xl bg-surface-2 p-2">
            <div className="text-ink-3">Tokeni trimiși</div>
            <div className="font-semibold tabular">{compact(data.monthPromptTokens)}</div>
          </div>
          <div className="rounded-xl bg-surface-2 p-2">
            <div className="text-ink-3">Din cache</div>
            <div className="font-semibold tabular">{cacheRate == null ? '—' : `${cacheRate}%`}</div>
          </div>
          <div className="rounded-xl bg-surface-2 p-2">
            <div className="text-ink-3">Tokeni generați</div>
            <div className="font-semibold tabular">{compact(data.monthCompletionTokens)}</div>
          </div>
        </div>
        {data.budgetExceeded && <Notice tone="critical">Bugetul lunar a fost depășit. Agentul se oprește dacă ai activat oprirea la buget.</Notice>}
      </div>
    </Card>
  );
}

export function AiTab() {
  return (
    <>
      <Card className="mb-5">
        <CardHeader title="Cheia DeepSeek" subtitle="Agentul folosește DeepSeek pentru a gândi și a răspunde." icon={<Brain className="size-4" />} />
        <div className="px-4 pb-4 sm:px-5">
          <SecretField
            secretKey="llm.apiKey"
            label="Cheie API"
            placeholder="sk-…"
            hint={
              <>
                O creezi pe{' '}
                <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer" className="underline">
                  platform.deepseek.com
                </a>{' '}
                → API keys, după ce încarci credit (Top up). Cheia se salvează criptat pe server și nu mai poate fi citită din aplicație.
              </>
            }
          />
          <IntegrationTest integration="llm" />
        </div>
      </Card>

      <Usage />

      <SectionForm section="llm" title="Model și buget" subtitle="Modificările cer confirmare cu Face ID." icon={<ShieldCheck className="size-4" />}>
        {(v, set) => (
          <div className="space-y-4">
            <Field label="Model pentru chat și tichete">
              <ModelSelect value={v.model} onChange={(model) => set({ model })} />
            </Field>
            <Field label="Model pentru incidente" hint="Când pică site-ul contează viteza; Flash e de obicei suficient.">
              <ModelSelect value={v.incidentModel} onChange={(incidentModel) => set({ incidentModel })} />
            </Field>
            <Toggle checked={v.thinking} onChange={(thinking) => set({ thinking })} label="Gândire înainte de răspuns" description="Răspunsuri mai bune la probleme complicate; costă puțin mai mult." />
            {v.thinking && (
              <Field label="Cât de mult gândește">
                <Segmented
                  value={v.reasoningEffort}
                  onChange={(reasoningEffort) => set({ reasoningEffort })}
                  options={[
                    { value: 'low', label: 'Puțin' },
                    { value: 'high', label: 'Normal' },
                    { value: 'max', label: 'Maxim' },
                  ]}
                />
              </Field>
            )}
            <Grid>
              <Field label="Buget lunar" hint="Primești notificare la 80%.">
                <NumberInput value={v.monthlyBudgetUsd} onChange={(monthlyBudgetUsd) => set({ monthlyBudgetUsd })} min={0} max={10000} step={1} suffix="USD" />
              </Field>
              <Field label="Pași maximi per sarcină" hint="Limita de unelte folosite într-o singură rulare.">
                <NumberInput value={v.maxStepsPerRun} onChange={(maxStepsPerRun) => set({ maxStepsPerRun })} min={2} max={60} />
              </Field>
            </Grid>
            <Toggle checked={v.hardStopAtBudget} onChange={(hardStopAtBudget) => set({ hardStopAtBudget })} label="Oprește agentul când se atinge bugetul" description="Monitorizarea continuă oricum; doar analiza cu AI se oprește." />
            <details className="rounded-xl border border-line px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium">Avansat: adresă API și prețuri</summary>
              <div className="mt-3 space-y-4 pb-1">
                <Field label="Adresa API" hint="Implicit https://api.deepseek.com. Poți folosi un furnizor din UE compatibil cu DeepSeek.">
                  <Input value={v.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
                </Field>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Intrare / 1M tokeni">
                    <NumberInput value={v.priceInputPerM} onChange={(priceInputPerM) => set({ priceInputPerM })} min={0} step={0.001} suffix="$" />
                  </Field>
                  <Field label="Din cache / 1M">
                    <NumberInput value={v.priceCacheHitPerM} onChange={(priceCacheHitPerM) => set({ priceCacheHitPerM })} min={0} step={0.001} suffix="$" />
                  </Field>
                  <Field label="Ieșire / 1M">
                    <NumberInput value={v.priceOutputPerM} onChange={(priceOutputPerM) => set({ priceOutputPerM })} min={0} step={0.001} suffix="$" />
                  </Field>
                </div>
              </div>
            </details>
          </div>
        )}
      </SectionForm>

      <Notice tone="info">
        <strong>Confidențialitate:</strong> DeepSeek procesează cererile pe servere din China. Înainte de trimitere, agentul maschează automat parolele, cheile, CNP-urile, numerele de card și IBAN-urile. Pentru date
        procesate în UE, schimbă „Adresa API” cu un furnizor european compatibil.
      </Notice>
    </>
  );
}
