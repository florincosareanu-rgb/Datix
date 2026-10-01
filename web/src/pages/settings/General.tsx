import { Building2, Palette } from 'lucide-react';
import { Card, CardHeader, Field, Input } from '../../components/ui';
import { ThemePicker } from '../More';
import { Grid, SectionForm } from './common';

export function GeneralTab() {
  return (
    <>
      <SectionForm section="general" title="Firma și agentul" subtitle="Cum se prezintă agentul și cum îți spune pe nume." icon={<Building2 className="size-4" />}>
        {(v, set) => (
          <Grid>
            <Field label="Numele agentului">
              <Input value={v.agentName} onChange={(e) => set({ agentName: e.target.value })} maxLength={40} />
            </Field>
            <Field label="Numele firmei">
              <Input value={v.companyName} onChange={(e) => set({ companyName: e.target.value })} maxLength={80} />
            </Field>
            <Field label="Numele tău" hint="Agentul te va numi așa în chat și în rapoarte.">
              <Input value={v.ownerName} onChange={(e) => set({ ownerName: e.target.value })} maxLength={80} />
            </Field>
            <Field label="Fus orar" hint="Pentru programul de noapte/weekend și ora raportului zilnic.">
              <Input value={v.timezone} onChange={(e) => set({ timezone: e.target.value })} placeholder="Europe/Bucharest" />
            </Field>
          </Grid>
        )}
      </SectionForm>
      <Card className="mb-5">
        <CardHeader title="Aspect" subtitle="Se aplică doar pe acest dispozitiv." icon={<Palette className="size-4" />} />
        <div className="px-4 pb-4 sm:px-5">
          <ThemePicker />
        </div>
      </Card>
    </>
  );
}
