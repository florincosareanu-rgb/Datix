import { BookOpen, Info, Lock } from 'lucide-react';
import { Card, CardHeader } from '../../components/ui';
import { useSettings } from './common';

const DOCS = 'https://github.com/florincosareanu-rgb/Datix/blob/main/docs';

export function AboutTab() {
  const { data } = useSettings();
  return (
    <>
      <Card className="mb-5">
        <CardHeader title="Datix AI" subtitle={`Versiunea ${data?.version ?? '—'}${data?.demoMode ? ' · mod demo' : ''}`} icon={<Info className="size-4" />} />
        <div className="space-y-2 px-4 pb-4 text-sm text-ink-2 sm:px-5">
          <p>Agent de operațiuni pentru datix.ro și my.datix.ro: monitorizează, investighează, repară și răspunde la tichete — cu aprobarea ta acolo unde contează.</p>
        </div>
      </Card>
      <Card className="mb-5">
        <CardHeader title="Cum sunt protejate datele" icon={<Lock className="size-4" />} />
        <ul className="list-disc space-y-1.5 px-4 pb-4 pl-9 text-sm text-ink-2 sm:px-5 sm:pl-10">
          <li>Aplicația rulează pe serverul tău; datele stau într-o bază de date locală, cu backup zilnic.</li>
          <li>Cheile API sunt criptate (AES-256-GCM) și nu se pot citi înapoi din aplicație.</li>
          <li>Autentificare cu Face ID (passkey) sau parolă + cod 2FA; acțiunile sensibile cer confirmare.</li>
          <li>Spre DeepSeek pleacă doar ce e necesar, cu parolele, CNP-urile, cardurile și IBAN-urile mascate automat.</li>
          <li>Textul din tichete e tratat ca nesigur: un client nu poate da comenzi agentului.</li>
          <li>Fiecare acțiune a agentului apare în Jurnal.</li>
        </ul>
      </Card>
      <Card>
        <CardHeader title="Documentație" icon={<BookOpen className="size-4" />} />
        <ul className="space-y-1.5 px-4 pb-4 text-sm sm:px-5">
          {[
            ['INSTALARE.md', 'Instalare și actualizare pe server'],
            ['INTEGRARI.md', 'Conectarea WHMCS, DirectAdmin, Cloudflare, WordPress'],
            ['SECURITATE.md', 'Securitate și confidențialitate'],
            ['ARHITECTURA.md', 'Cum funcționează agentul'],
          ].map(([file, label]) => (
            <li key={file}>
              <a href={`${DOCS}/${file}`} target="_blank" rel="noreferrer" className="text-accent underline">
                {label}
              </a>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
