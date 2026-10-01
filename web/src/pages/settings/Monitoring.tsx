import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ListChecks } from 'lucide-react';
import type { MonitorDTO } from '@datix/shared';
import { api, errorText } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Card, CardHeader, Field, Toggle } from '../../components/ui';
import { StatusBadge } from '../../components/status';
import { LineList } from './Sites';
import { Grid, NumberInput, SectionForm } from './common';

function MonitorToggles() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['monitors'], queryFn: () => api.get<MonitorDTO[]>('/api/monitors') });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch<MonitorDTO>(`/api/monitors/${id}`, { enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monitors'] });
      qc.invalidateQueries({ queryKey: ['status'] });
    },
    onError: (err) => toast(errorText(err), 'critical'),
  });
  if (!data) return null;
  return (
    <Card className="mb-5">
      <CardHeader title="Verificări" subtitle="Le poți pune pe pauză individual (ex. în timpul unei mentenanțe planificate)." icon={<ListChecks className="size-4" />} />
      <div className="divide-y divide-line px-4 pb-2 sm:px-5">
        {data.map((m) => (
          <Toggle
            key={m.id}
            checked={m.enabled}
            onChange={(enabled) => toggle.mutate({ id: m.id, enabled })}
            label={
              <span className="flex flex-wrap items-center gap-2">
                {m.name} <StatusBadge status={m.status} />
              </span>
            }
            description={`${m.target} · la ${m.intervalSec >= 3600 ? `${Math.round(m.intervalSec / 3600)} h` : m.intervalSec >= 60 ? `${Math.round(m.intervalSec / 60)} min` : `${m.intervalSec} s`}`}
          />
        ))}
      </div>
    </Card>
  );
}

export function MonitoringTab() {
  return (
    <>
      <SectionForm section="monitoring" title="Reguli de monitorizare" subtitle="Cât de des verificăm și când deschidem un incident." icon={<Activity className="size-4" />}>
        {(v, set) => (
          <div className="space-y-4">
            <Grid>
              <Field label="Verifică site-urile la fiecare" hint="Între 30 de secunde și o oră.">
                <NumberInput value={v.uptimeIntervalSec} onChange={(uptimeIntervalSec) => set({ uptimeIntervalSec })} min={30} max={3600} suffix="sec" />
              </Field>
              <Field label="Răspuns lent peste" hint="Peste prag, site-ul apare „Degradat”.">
                <NumberInput value={v.slowThresholdMs} onChange={(slowThresholdMs) => set({ slowThresholdMs })} min={500} max={60000} step={100} suffix="ms" />
              </Field>
              <Field label="Eșecuri la rând până la incident" hint="Evită alarmele false de o secundă.">
                <NumberInput value={v.failuresBeforeIncident} onChange={(failuresBeforeIncident) => set({ failuresBeforeIncident })} min={1} max={10} />
              </Field>
              <Field label="Verificări reușite până la „rezolvat”">
                <NumberInput value={v.successesBeforeResolve} onChange={(successesBeforeResolve) => set({ successesBeforeResolve })} min={1} max={10} />
              </Field>
              <Field label="Re-notifică dacă incidentul durează" hint="Intervalul se dublează la fiecare reamintire (maxim 2 ore).">
                <NumberInput value={v.escalateAfterMin} onChange={(escalateAfterMin) => set({ escalateAfterMin })} min={1} max={1440} suffix="min" />
              </Field>
            </Grid>
            <Toggle checked={v.autoInvestigate} onChange={(autoInvestigate) => set({ autoInvestigate })} label="Investigație automată" description="Când se deschide un incident, agentul începe imediat să caute cauza (și o repară, conform setărilor de autonomie)." />
            <Field label="Servere DNS folosite la verificări (câte unul pe rând)" hint="Maxim 4. Implicit Cloudflare (1.1.1.1) și Google (8.8.8.8).">
              <LineList value={v.dnsResolvers} onChange={(dnsResolvers) => set({ dnsResolvers })} placeholder={'1.1.1.1\n8.8.8.8'} />
            </Field>
          </div>
        )}
      </SectionForm>
      <MonitorToggles />
    </>
  );
}
