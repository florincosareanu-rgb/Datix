import { Bot, Check, Minus, ShieldCheck } from 'lucide-react';
import { Card, CardHeader, Notice, Toggle } from '../../components/ui';
import { SectionForm } from './common';

const Yes = () => <Check className="mx-auto size-4 text-good" aria-label="da" />;
const No = () => <Minus className="mx-auto size-4 text-ink-3" aria-label="nu" />;

function Matrix() {
  // oglindește matricea din server/src/agent/policy.ts
  const rows: Array<{ label: string; owner: React.ReactNode; incident: React.ReactNode; ticket: React.ReactNode }> = [
    { label: 'Citește: loguri, stări, setări, tichete', owner: <Yes />, incident: <Yes />, ticket: <Yes /> },
    { label: 'Reparații reversibile (cu backup automat): dezactivare plugin, mentenanță, golire cache', owner: <Yes />, incident: 'conform setării de mai jos', ticket: 'doar propune, cu OK-ul tău' },
    { label: 'Ireversibile: restaurare backup, DNS, actualizări, ștergeri', owner: 'cu Face ID', incident: 'cu Face ID', ticket: 'doar propune, cu Face ID' },
    { label: 'Mesaje către clienți', owner: 'după ce confirmi textul', incident: <No />, ticket: 'conform modului Tichete' },
  ];
  return (
    <Card className="mb-5">
      <CardHeader title="Ce poate face agentul" subtitle="Conținutul tichetelor e tratat ca „date nesigure”: un client nu poate convinge agentul să facă ceva." icon={<Bot className="size-4" />} />
      <div className="scrollbar-thin overflow-x-auto px-2 pb-3">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead className="text-xs text-ink-3">
            <tr>
              <th className="px-2 py-1.5 font-medium">Acțiune</th>
              <th className="px-2 py-1.5 text-center font-medium">În chat cu tine</th>
              <th className="px-2 py-1.5 text-center font-medium">La incidente</th>
              <th className="px-2 py-1.5 text-center font-medium">La tichete</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-t border-line">
                <td className="px-2 py-2">{r.label}</td>
                <td className="px-2 py-2 text-center text-[13px] text-ink-2">{r.owner}</td>
                <td className="px-2 py-2 text-center text-[13px] text-ink-2">{r.incident}</td>
                <td className="px-2 py-2 text-center text-[13px] text-ink-2">{r.ticket}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function AutonomyTab() {
  return (
    <>
      <Matrix />
      <SectionForm section="autonomy" title="Autonomie" subtitle="Modificările cer confirmare cu Face ID." icon={<ShieldCheck className="size-4" />}>
        {(v, set) => (
          <div>
            <Toggle
              checked={v.incidentAutoRemediate}
              onChange={(incidentAutoRemediate) => set({ incidentAutoRemediate })}
              label="Reparare automată la incidente"
              description="Când pică site-ul, agentul aplică singur remedieri reversibile (ex. dezactivează pluginul care a stricat site-ul), cu backup înainte. Recomandat: pornit."
            />
            <Toggle
              checked={v.ownerConfirmIrreversible}
              onChange={(ownerConfirmIrreversible) => set({ ownerConfirmIrreversible })}
              label="Confirmare cu Face ID pentru acțiuni ireversibile în chat"
              description="Chiar și când tu îi ceri, agentul îți arată exact ce va face și așteaptă confirmarea. Recomandat: pornit."
            />
            <Toggle
              checked={v.incidentAllowIrreversible}
              onChange={(incidentAllowIrreversible) => set({ incidentAllowIrreversible })}
              label="Acțiuni ireversibile fără aprobare la incidente"
              description="Agentul ar putea, de exemplu, să restaureze singur un backup în toiul nopții. Nerecomandat."
            />
            {v.incidentAllowIrreversible && (
              <div className="mt-2">
                <Notice tone="warning">Cu această opțiune, agentul poate face modificări care nu se pot anula, fără să te întrebe. Lasă-o oprită dacă nu ai un motiv clar.</Notice>
              </div>
            )}
          </div>
        )}
      </SectionForm>
    </>
  );
}
