import { AlertTriangle, MessageSquareText, Ticket } from 'lucide-react';
import { Card, CardHeader, Field, Input, Notice, Textarea, Toggle } from '../../components/ui';
import { Grid, NumberInput, SectionForm } from './common';

export function TicketsSettingsTab() {
  return (
    <>
      <Notice tone="info">
        Modul de lucru (Oprit / Ciornă / Automat) se schimbă rapid din pagina <strong>Tichete</strong>. Aici sunt regulile.
      </Notice>
      <div className="h-5" />
      <SectionForm section="tickets" title="Reguli pentru tichete" icon={<Ticket className="size-4" />}>
        {(v, set) => (
          <div className="space-y-5">
            <div>
              <div className="mb-1 text-sm font-semibold">Program pentru răspunsurile automate</div>
              <Toggle checked={v.autoOnlyInSchedule} onChange={(autoOnlyInSchedule) => set({ autoOnlyInSchedule })} label="Automat doar în afara programului" description="În program, agentul face doar ciorne pe care le trimiți tu." />
              <Grid>
                <Field label="Program de lucru: de la">
                  <Input type="time" value={v.schedule.weekdayStart} onChange={(e) => set({ schedule: { ...v.schedule, weekdayStart: e.target.value } })} />
                </Field>
                <Field label="până la">
                  <Input type="time" value={v.schedule.weekdayEnd} onChange={(e) => set({ schedule: { ...v.schedule, weekdayEnd: e.target.value } })} />
                </Field>
              </Grid>
              <Toggle checked={v.schedule.weekendsAllDay} onChange={(weekendsAllDay) => set({ schedule: { ...v.schedule, weekendsAllDay } })} label="Weekendul e în afara programului" />
            </div>

            <div>
              <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                <AlertTriangle className="size-4 text-warning-ink" /> Ajung mereu la tine (agentul nu răspunde singur)
              </div>
              <Toggle checked={v.escalate.money} onChange={(money) => set({ escalate: { ...v.escalate, money } })} label="Bani" description="Facturi, plăți, rambursări, prețuri speciale, reduceri." />
              <Toggle checked={v.escalate.cancellation} onChange={(cancellation) => set({ escalate: { ...v.escalate, cancellation } })} label="Anulări și ștergeri" description="Anulare servicii, ștergere conturi, date sau site-uri." />
              <Toggle checked={v.escalate.accountChange} onChange={(accountChange) => set({ escalate: { ...v.escalate, accountChange } })} label="Modificări pe cont" description="Schimbare titular, e-mail, parole, transfer de domeniu." />
              <Toggle checked={v.escalate.complaintLegal} onChange={(complaintLegal) => set({ escalate: { ...v.escalate, complaintLegal } })} label="Reclamații și aspecte legale" description="Nemulțumiri, amenințări, GDPR, ANPC, avocați." />
              {!(v.escalate.money && v.escalate.cancellation && v.escalate.accountChange && v.escalate.complaintLegal) && (
                <Notice tone="warning">Ai dezactivat o protecție. Agentul va putea răspunde singur la astfel de tichete în modul Automat.</Notice>
              )}
            </div>

            <Grid>
              <Field label="Încredere minimă pentru răspuns automat" hint="Sub prag, agentul face doar ciornă și te anunță.">
                <NumberInput value={Math.round(v.minConfidence * 100)} onChange={(n) => set({ minConfidence: Number.isFinite(n) ? n / 100 : v.minConfidence })} min={0} max={100} suffix="%" />
              </Field>
              <Field label="Răspunsuri automate pe tichet, pe zi" hint="Previne conversațiile în buclă.">
                <NumberInput value={v.maxAutoRepliesPerTicketPerDay} onChange={(maxAutoRepliesPerTicketPerDay) => set({ maxAutoRepliesPerTicketPerDay })} min={1} max={20} />
              </Field>
              <Field label="Verifică tichetele la fiecare" hint="Doar dacă nu folosești hook-ul WHMCS.">
                <NumberInput value={v.pollIntervalSec} onChange={(pollIntervalSec) => set({ pollIntervalSec })} min={30} max={3600} suffix="sec" />
              </Field>
              <Field label="Departamente excluse" hint="Separate prin virgulă. Agentul doar te anunță de tichetele din ele.">
                <Input
                  value={v.excludedDepartments.join(', ')}
                  onChange={(e) =>
                    set({
                      excludedDepartments: e.target.value
                        .split(',')
                        .map((x) => x.trim())
                        .filter(Boolean),
                    })
                  }
                  placeholder="ex. Abuz, Vânzări"
                />
              </Field>
            </Grid>
            <Toggle checked={v.addInternalNote} onChange={(addInternalNote) => set({ addInternalNote })} label="Notă internă în WHMCS" description="Agentul lasă în tichet o notă vizibilă doar echipei, cu analiza lui." />

            <div>
              <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                <MessageSquareText className="size-4" /> Semnătura
              </div>
              <div className="space-y-4">
                <Field label="Semnătură">
                  <Textarea value={v.signature} onChange={(e) => set({ signature: e.target.value })} className="min-h-20" maxLength={500} />
                </Field>
                <Field label="Notă AI (la finalul fiecărui răspuns scris de agent)">
                  <Textarea value={v.aiNote} onChange={(e) => set({ aiNote: e.target.value })} className="min-h-20" maxLength={500} />
                </Field>
              </div>
            </div>
            <Card className="bg-surface-2/60">
              <CardHeader title="Previzualizare" subtitle="Așa se termină un răspuns trimis de agent." />
              <div className="px-4 pb-4 text-sm whitespace-pre-wrap sm:px-5">
                {'Bună ziua,\n\nAm verificat și site-ul funcționează din nou. …\n\n'}
                {v.signature}
                {v.aiNote ? (
                  <>
                    {'\n\n---\n'}
                    <em>{v.aiNote}</em>
                  </>
                ) : null}
              </div>
            </Card>
          </div>
        )}
      </SectionForm>
    </>
  );
}
