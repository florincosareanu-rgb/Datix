import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { BookOpen, Check, Cloud, Copy, Download, Eye, Gauge, Layers, RefreshCw, Server, Store, Ticket } from 'lucide-react';
import type { AppSettings, SettingsResponseDTO } from '@datix/shared';
import { api, errorText } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Badge, Button, Card, CardHeader, Field, Input, Notice, Toggle } from '../../components/ui';
import { Grid, IntegrationTest, SecretField, useSettings } from './common';

type IntKey = keyof AppSettings['integrations'];

const GUIDE = 'https://github.com/florincosareanu-rgb/Datix/blob/main/docs/INTEGRARI.md';

interface InstallInfo {
  appUrl: string;
  whmcsWebhookUrl: string;
  wordpressWebhookUrl: string;
  serverIpHint: string;
}

function useInstallInfo() {
  return useQuery({ queryKey: ['install-info'], queryFn: () => api.get<InstallInfo>('/api/settings/install-info'), staleTime: Infinity });
}

/** Card pentru o integrare: comutator + câmpuri cu salvare proprie + chei + test. */
function IntegrationCard<K extends IntKey>({
  k,
  title,
  subtitle,
  icon,
  fields,
  children,
  guide,
}: {
  k: K;
  title: string;
  subtitle: ReactNode;
  icon: ReactNode;
  fields?: (v: AppSettings['integrations'][K], set: (p: Partial<AppSettings['integrations'][K]>) => void) => ReactNode;
  children?: ReactNode;
  guide?: string;
}) {
  const { data } = useSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const remote = data?.settings.integrations[k];
  const [draft, setDraft] = useState<AppSettings['integrations'][K] | null>(null);
  const dirty = !!draft && !!remote && JSON.stringify(draft) !== JSON.stringify(remote);
  useEffect(() => {
    if (remote && !dirty) setDraft(structuredClone(remote));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(remote)]);
  const save = useMutation({
    mutationFn: (value: AppSettings['integrations'][K]) => api.patch<SettingsResponseDTO>('/api/settings', { integrations: { [k]: value } }),
    onSuccess: (d) => {
      qc.setQueryData(['settings'], d);
      qc.invalidateQueries({ queryKey: ['status'] });
      toast('Salvat.', 'good');
    },
    onError: (err) => toast(errorText(err), 'critical'),
  });
  const status = data?.integrations.find((i) => i.key === k);
  if (!draft) return null;
  const set = (p: Partial<AppSettings['integrations'][K]>) => setDraft((d) => (d ? { ...d, ...p } : d));
  return (
    <Card className="mb-5">
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {title}
            {status?.configured ? <Badge tone="good">conectat</Badge> : <Badge>neconectat</Badge>}
          </span>
        }
        subtitle={subtitle}
        icon={icon}
      />
      <div className="px-4 pb-4 sm:px-5">
        <Toggle
          checked={draft.enabled}
          onChange={(enabled) => {
            const next = { ...draft, enabled };
            setDraft(next);
            save.mutate(next);
          }}
          label="Activ"
          description={draft.enabled ? 'Agentul folosește această integrare.' : 'Dezactivat: agentul nu o folosește, chiar dacă are cheile.'}
        />
        {fields && <div className={clsx('mt-2 space-y-4', !draft.enabled && 'opacity-60')}>{fields(draft, set)}</div>}
        {dirty && (
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => remote && setDraft(structuredClone(remote))}>
              Renunță
            </Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(draft)}>
              Salvează
            </Button>
          </div>
        )}
        <div className={clsx('mt-2', !draft.enabled && 'opacity-60')}>{children}</div>
        <IntegrationTest integration={k} />
        {guide && (
          <a href={`${GUIDE}#${guide}`} target="_blank" rel="noreferrer" className="mt-1 inline-flex min-h-11 items-center gap-1.5 text-[14px] font-medium text-accent-fg hover:underline">
            <BookOpen className="size-4" aria-hidden />
            Ghid pas cu pas
          </a>
        )}
      </div>
    </Card>
  );
}

function CopyLine({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Field label={label}>
      <div className="flex min-h-12 items-center gap-2 rounded-2xl bg-surface-2 py-0.5 pr-0.5 pl-4">
        <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{value}</code>
        <button
          type="button"
          className="pressable flex size-11 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink"
          aria-label="Copiază"
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="size-[18px] text-good-ink" /> : <Copy className="size-[18px]" />}
        </button>
      </div>
    </Field>
  );
}

/** Secret generat de aplicație (pentru WordPress / WHMCS): se poate afișa sau regenera, cu Face ID. */
function GeneratedSecret({ secretKey, label, regenerateWarning }: { secretKey: string; label: string; regenerateWarning: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [value, setValue] = useState<string | null>(null);
  const reveal = useMutation({
    mutationFn: () => api.post<{ value: string }>(`/api/settings/secrets/${secretKey}/reveal`),
    onSuccess: (r) => setValue(r.value),
    onError: (err) => toast(errorText(err), 'critical'),
  });
  const regen = useMutation({
    mutationFn: () => api.post<{ value: string }>(`/api/settings/secrets/${secretKey}/regenerate`),
    onSuccess: (r) => {
      setValue(r.value);
      qc.invalidateQueries({ queryKey: ['settings'] });
      toast('Secret nou generat.', 'good');
    },
    onError: (err) => toast(errorText(err), 'critical'),
  });
  return value ? (
    <CopyLine label={label} value={value} />
  ) : (
    <div className="flex flex-wrap gap-2 py-1">
      <Button size="sm" variant="ghost" icon={<Eye className="size-4" />} loading={reveal.isPending} onClick={() => reveal.mutate()}>
        Arată {label.toLowerCase()}
      </Button>
      <Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} loading={regen.isPending} onClick={() => confirm(regenerateWarning) && regen.mutate()}>
        Regenerează
      </Button>
    </div>
  );
}

function DownloadButton({ path, filename, children }: { path: string; filename: string; children: ReactNode }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="primary"
      icon={<Download className="size-4" />}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api.download(path, filename);
        } catch (err) {
          toast(errorText(err), 'critical');
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
    </Button>
  );
}

export function IntegrationsTab() {
  const info = useInstallInfo();
  return (
    <>
      <Notice tone="info">
        Cheile se salvează <strong>criptat pe serverul agentului</strong> și nu mai pot fi citite din aplicație. Nu le trimite niciodată pe chat sau pe e-mail. Unde se poate, restricționează-le la IP-ul
        serverului agentului.
      </Notice>
      <div className="h-5" />

      <IntegrationCard
        k="whmcs"
        title="WHMCS"
        icon={<Ticket className="size-4" />}
        guide="whmcs"
        subtitle="Tichete, clienți, facturi și cifre de business de pe my.datix.ro."
        fields={(v, set) => (
          <Grid>
            <Field label="Adresa WHMCS">
              <Input value={v.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://my.datix.ro" inputMode="url" />
            </Field>
            <Field label="Răspunde ca utilizatorul admin" hint="Numele de utilizator al adminului WHMCS sub care apar răspunsurile.">
              <Input value={v.replyAsAdmin} onChange={(e) => set({ replyAsAdmin: e.target.value })} placeholder="ex. florin" />
            </Field>
          </Grid>
        )}
      >
        <SecretField secretKey="whmcs.identifier" label="Identificator API" hint="WHMCS → Configurare → Personal → Manage API Credentials → Generate New API Credential." />
        <SecretField secretKey="whmcs.secret" label="Secret API" />
        <div className="mt-3 rounded-xl border border-line p-3">
          <div className="text-sm font-medium">Notificări instant (hook WHMCS)</div>
          <p className="mt-0.5 mb-3 text-xs text-ink-3">
            Fără hook, agentul verifică tichetele la 2 minute. Cu hook, află imediat de tichete noi, comenzi, plăți, anulări și autentificări de admin. Descarcă fișierul (conține deja adresa și secretul) și
            pune-l în folderul <code>includes/hooks/</code> din WHMCS.
          </p>
          <div className="flex flex-wrap gap-2">
            <DownloadButton path="/api/downloads/whmcs-hook.php" filename="dax.php">
              Descarcă hook-ul WHMCS
            </DownloadButton>
          </div>
          {info.data && <div className="mt-3"><CopyLine label="Adresa la care trimite hook-ul" value={info.data.whmcsWebhookUrl} /></div>}
          <GeneratedSecret secretKey="whmcs.webhookSecret" label="Secretul hook-ului" regenerateWarning="După regenerare trebuie să descarci și să încarci din nou fișierul hook în WHMCS. Continui?" />
        </div>
      </IntegrationCard>

      <IntegrationCard
        k="wordpress"
        title="WordPress (plugin DAX)"
        icon={<Layers className="size-4" />}
        guide="wordpress"
        subtitle="Starea WordPress, pluginuri, actualizări, utilizatori admin, modul mentenanță și evenimente de securitate pe datix.ro."
        fields={(v, set) => (
          <Field label="Adresa site-ului">
            <Input value={v.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://datix.ro" inputMode="url" />
          </Field>
        )}
      >
        <ol className="mt-1 mb-3 list-decimal space-y-1 pl-5 text-[13px] text-ink-2">
          <li>Descarcă pluginul (conține deja cheia de conectare).</li>
          <li>În WordPress: Module → Adaugă → Încarcă modul → alege fișierul → Activează.</li>
          <li>Apasă „Testează conexiunea” mai jos.</li>
        </ol>
        <DownloadButton path="/api/downloads/wordpress-plugin.zip" filename="dax-connector.zip">
          Descarcă pluginul WordPress
        </DownloadButton>
        <GeneratedSecret secretKey="wordpress.secret" label="Cheia pluginului" regenerateWarning="După regenerare, pluginul din WordPress nu se mai poate conecta până nu descarci și instalezi din nou pluginul (sau actualizezi cheia în setările lui). Continui?" />
      </IntegrationCard>

      <IntegrationCard
        k="directadmin"
        title="DirectAdmin"
        icon={<Server className="size-4" />}
        guide="directadmin"
        subtitle="Fișiere, loguri de erori, backup-uri, SSL și resursele contului de hosting. Așa repară agentul site-ul când pică."
        fields={(v, set) => (
          <>
            <Grid>
              <Field label="Adresa panoului" hint="Cu portul, de obicei 2222.">
                <Input value={v.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://server.exemplu.ro:2222" inputMode="url" />
              </Field>
              <Field label="Utilizator DirectAdmin">
                <Input value={v.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" />
              </Field>
            </Grid>
            <Grid>
              <Field label="Folderul site-ului WordPress">
                <Input value={v.wordpressPath} onChange={(e) => set({ wordpressPath: e.target.value })} className="font-mono text-[13px]" />
              </Field>
              <Field label="Folderul WHMCS">
                <Input value={v.whmcsPath} onChange={(e) => set({ whmcsPath: e.target.value })} className="font-mono text-[13px]" />
              </Field>
            </Grid>
          </>
        )}
      >
        <SecretField
          secretKey="directadmin.loginKey"
          label="Login Key"
          hint="DirectAdmin → Login Keys → Create Key. Bifează doar comenzile din ghid și limitează cheia la IP-ul serverului agentului. Nu folosi parola contului."
        />
      </IntegrationCard>

      <IntegrationCard
        k="cloudflare"
        title="Cloudflare"
        icon={<Cloud className="size-4" />}
        guide="cloudflare"
        subtitle="Atacuri blocate, modul „Sub atac”, golirea cache-ului, setările SSL și DNS pentru datix.ro."
        fields={(v, set) => (
          <Grid>
            <Field label="Domeniul (zona)">
              <Input value={v.zoneName} onChange={(e) => set({ zoneName: e.target.value })} placeholder="datix.ro" />
            </Field>
            <Field label="Zone ID (opțional)" hint="Se detectează automat.">
              <Input value={v.zoneId} onChange={(e) => set({ zoneId: e.target.value })} className="font-mono text-[13px]" />
            </Field>
          </Grid>
        )}
      >
        <SecretField secretKey="cloudflare.apiToken" label="API Token" hint="Cloudflare → My Profile → API Tokens → Create Custom Token, doar pentru zona datix.ro (permisiunile sunt în ghid). Nu folosi Global API Key." />
      </IntegrationCard>

      <IntegrationCard k="pagespeed" title="Google PageSpeed" icon={<Gauge className="size-4" />} guide="pagespeed" subtitle="Scorul de viteză și SEO, verificat zilnic.">
        <SecretField secretKey="pagespeed.apiKey" label="Cheie API (opțional)" hint="Funcționează și fără cheie, dar Google limitează numărul de verificări. O cheie gratuită se creează din Google Cloud Console." />
      </IntegrationCard>

      <IntegrationCard
        k="reseller"
        title="DirectAdmin Reseller"
        icon={<Store className="size-4" />}
        guide="reseller"
        subtitle="Pentru site-urile clienților, la furnizorul de reseller. Activează după ce cumperi pachetul de reseller."
        fields={(v, set) => (
          <Grid>
            <Field label="Adresa panoului reseller">
              <Input value={v.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://reseller.furnizor.ro:2222" inputMode="url" />
            </Field>
            <Field label="Utilizator reseller">
              <Input value={v.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" />
            </Field>
          </Grid>
        )}
      >
        <SecretField secretKey="reseller.loginKey" label="Login Key reseller" hint="Agentul poate vedea conturile clienților și resursele lor; suspendările și ștergerile cer mereu aprobarea ta." />
      </IntegrationCard>
    </>
  );
}
