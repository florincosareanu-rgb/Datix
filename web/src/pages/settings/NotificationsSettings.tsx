import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Bell, BellOff, FileText, Send, Share, Smartphone, SquarePlus } from 'lucide-react';
import { api, errorText } from '../../lib/api';
import { disablePush, enablePush, isIos, pushState, type PushState } from '../../lib/push';
import { useToast } from '../../lib/toast';
import { Button, Card, CardHeader, Field, Input, Notice, Toggle } from '../../components/ui';
import { SectionForm } from './common';

function InstallSteps() {
  return (
    <ol className="space-y-3 text-sm">
      <li className="flex gap-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">1</span>
        <span>
          Deschide aplicația în <strong>Safari</strong> pe iPhone (iOS 16.4 sau mai nou).
        </span>
      </li>
      <li className="flex gap-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">2</span>
        <span>
          Apasă <Share className="inline size-4 align-text-bottom" /> <strong>Distribuie</strong>, apoi <SquarePlus className="inline size-4 align-text-bottom" /> <strong>Adaugă la ecranul principal</strong>.
        </span>
      </li>
      <li className="flex gap-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">3</span>
        <span>
          Deschide <strong>DAX</strong> de pe ecranul principal, intră aici și apasă „Activează notificările”.
        </span>
      </li>
    </ol>
  );
}

function PushCard() {
  const toast = useToast();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => void pushState().then(setState).catch(() => setState('unsupported'));
  useEffect(refresh, []);
  const test = useMutation({
    mutationFn: () => api.post<{ devices: number }>('/api/push/test'),
    onSuccess: (r) => toast(r.devices ? `Notificare de test trimisă pe ${r.devices} ${r.devices === 1 ? 'dispozitiv' : 'dispozitive'}.` : 'Niciun dispozitiv abonat.', r.devices ? 'good' : 'info'),
    onError: (err) => toast(errorText(err), 'critical'),
  });
  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok, 'good');
    } catch (err) {
      toast(errorText(err), 'critical');
    } finally {
      setBusy(false);
      refresh();
    }
  };
  return (
    <Card className="mb-5">
      <CardHeader title="Notificări pe acest dispozitiv" subtitle="Căderi de site, aprobări, tichete care au nevoie de tine, probleme de securitate." icon={<Smartphone className="size-4" />} />
      <div className="space-y-3 px-4 pb-4 sm:px-5">
        {state === 'needs-install' && (
          <>
            <Notice tone="info">Pe iPhone, notificările merg doar după ce adaugi aplicația pe ecranul principal:</Notice>
            <InstallSteps />
          </>
        )}
        {state === 'unsupported' && <Notice tone="warning">Acest browser nu suportă notificări push. {isIos() ? 'Actualizează iOS la 16.4 sau mai nou.' : 'Încearcă Chrome, Edge, Firefox sau Safari.'}</Notice>}
        {state === 'denied' && <Notice tone="warning">Notificările sunt blocate. Pe iPhone: Configurări → Notificări → DAX → Permite notificările. Apoi revino aici.</Notice>}
        {state === 'off' && (
          <Button variant="primary" icon={<Bell className="size-4" />} loading={busy} onClick={() => run(enablePush, 'Notificările sunt active pe acest dispozitiv.')}>
            Activează notificările
          </Button>
        )}
        {state === 'on' && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={<Send className="size-4" />} loading={test.isPending} onClick={() => test.mutate()}>
              Trimite o notificare de test
            </Button>
            <Button variant="ghost" icon={<BellOff className="size-4" />} loading={busy} onClick={() => run(disablePush, 'Notificările au fost oprite pe acest dispozitiv.')}>
              Oprește pe acest dispozitiv
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

export function NotificationsTab() {
  return (
    <>
      <PushCard />
      <SectionForm section="notifications" title="Ce notificări primești" icon={<Bell className="size-4" />}>
        {(v, set) => (
          <div>
            <Toggle checked={v.incidents} onChange={(incidents) => set({ incidents })} label="Incidente" description="Site căzut, revenit, reamintiri cât timp durează." />
            <Toggle checked={v.approvals} onChange={(approvals) => set({ approvals })} label="Aprobări" description="Agentul așteaptă OK-ul tău pentru o acțiune." />
            <Toggle checked={v.tickets} onChange={(tickets) => set({ tickets })} label="Tichete" description="Tichete escaladate sau ciorne pregătite." />
            <Toggle checked={v.security} onChange={(security) => set({ security })} label="Securitate" description="Probleme noi de gravitate ridicată sau critică, admini noi, atacuri." />
            <Toggle checked={v.dailyReport} onChange={(dailyReport) => set({ dailyReport })} label="Raportul zilnic" />
            <details className="mt-2">
              <summary className="cursor-pointer text-[13px] text-ink-3">Avansat</summary>
              <div className="mt-2">
                <Field label="Contact pentru serviciul de notificări (VAPID)" hint="Cerut de Apple/Google; un e-mail al firmei.">
                  <Input value={v.vapidSubject} onChange={(e) => set({ vapidSubject: e.target.value })} placeholder="mailto:contact@datix.ro" />
                </Field>
              </div>
            </details>
          </div>
        )}
      </SectionForm>
      <SectionForm section="reports" title="Raportul zilnic" subtitle="Un rezumat al ultimelor 24 de ore, generat automat." icon={<FileText className="size-4" />}>
        {(v, set) => (
          <div>
            <Toggle checked={v.dailyEnabled} onChange={(dailyEnabled) => set({ dailyEnabled })} label="Generează raportul zilnic" />
            <Field label="Ora">
              <Input type="time" value={v.dailyAt} onChange={(e) => set({ dailyAt: e.target.value })} className="max-w-40" />
            </Field>
          </div>
        )}
      </SectionForm>
    </>
  );
}
