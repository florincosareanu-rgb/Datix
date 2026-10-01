import { useState } from 'react';
import { Globe } from 'lucide-react';
import { Field, Input, Textarea } from '../../components/ui';
import { Grid, SectionForm } from './common';

const parseLines = (t: string) =>
  t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** Listă editabilă, câte un element pe rând (păstrează rândurile goale cât timp scrii). */
export function LineList({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState(value.join('\n'));
  // dacă valoarea s-a schimbat din afară (ex. „Renunță”), afișăm valoarea nouă
  const display = JSON.stringify(parseLines(text)) === JSON.stringify(value) ? text : value.join('\n');
  return (
    <Textarea
      value={display}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseLines(e.target.value));
      }}
      placeholder={placeholder}
      className="min-h-24 font-mono text-[13px]"
    />
  );
}

export function SitesTab() {
  return (
    <SectionForm section="sites" title="Site-urile monitorizate" subtitle="Verificate la fiecare minut: disponibilitate, viteză, conținut, SSL." icon={<Globe className="size-4" />}>
      {(v, set) => (
        <div className="space-y-4">
          <Grid>
            <Field label="Site-ul WordPress">
              <Input value={v.wordpressUrl} onChange={(e) => set({ wordpressUrl: e.target.value })} placeholder="https://datix.ro" inputMode="url" />
            </Field>
            <Field label="Text care trebuie să apară pe pagină" hint="Dacă lipsește, site-ul e considerat stricat (ex. pagină goală).">
              <Input value={v.wordpressKeyword} onChange={(e) => set({ wordpressKeyword: e.target.value })} placeholder="Datix" />
            </Field>
            <Field label="Zona de clienți WHMCS">
              <Input value={v.whmcsUrl} onChange={(e) => set({ whmcsUrl: e.target.value })} placeholder="https://my.datix.ro" inputMode="url" />
            </Field>
            <Field label="Text care trebuie să apară pe pagină">
              <Input value={v.whmcsKeyword} onChange={(e) => set({ whmcsKeyword: e.target.value })} placeholder="Datix" />
            </Field>
          </Grid>
          <Field
            label="IP-ul serverului de hosting (opțional)"
            hint="Cu el, agentul verifică site-ul și direct pe server, ocolind Cloudflare — așa își dă seama dacă problema e la hosting sau la Cloudflare. Îl găsești în DirectAdmin → Informații cont."
          >
            <Input value={v.originIp} onChange={(e) => set({ originIp: e.target.value.trim() })} placeholder="ex. 185.0.0.10" inputMode="decimal" />
          </Field>
          <Field label="Pagini suplimentare de verificat (câte una pe rând)" hint="Ex. pagina de comandă sau de contact. Maxim 50.">
            <LineList value={v.extraUrls} onChange={(extraUrls) => set({ extraUrls })} placeholder={'https://datix.ro/contact\nhttps://my.datix.ro/cart.php'} />
          </Field>
        </div>
      )}
    </SectionForm>
  );
}
