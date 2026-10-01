import { useLocation, useRoute } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import type { StatusOverviewDTO } from '@datix/shared';
import { Loading, Page, PageHeader, Tabs } from '../../components/ui';
import { useSettings } from './common';
import { GeneralTab } from './General';
import { AiTab } from './Ai';
import { SitesTab } from './Sites';
import { IntegrationsTab } from './Integrations';
import { MonitoringTab } from './Monitoring';
import { TicketsSettingsTab } from './TicketsSettings';
import { AutonomyTab } from './Autonomy';
import { NotificationsTab } from './NotificationsSettings';
import { KnowledgeTab } from './Knowledge';
import { AccountTab } from './Account';
import { JournalTab } from './Journal';
import { AboutTab } from './About';

const TABS = [
  { value: 'general', label: 'General', Component: GeneralTab },
  { value: 'ai', label: 'AI (DeepSeek)', Component: AiTab },
  { value: 'integrari', label: 'Integrări', Component: IntegrationsTab },
  { value: 'site-uri', label: 'Site-uri', Component: SitesTab },
  { value: 'monitorizare', label: 'Monitorizare', Component: MonitoringTab },
  { value: 'tichete', label: 'Tichete', Component: TicketsSettingsTab },
  { value: 'autonomie', label: 'Autonomie', Component: AutonomyTab },
  { value: 'notificari', label: 'Notificări', Component: NotificationsTab },
  { value: 'cunostinte', label: 'Bază de cunoștințe', Component: KnowledgeTab },
  { value: 'cont', label: 'Securitate cont', Component: AccountTab },
  { value: 'jurnal', label: 'Jurnal', Component: JournalTab },
  { value: 'despre', label: 'Despre', Component: AboutTab },
] as const;

type TabValue = (typeof TABS)[number]['value'];

export function SettingsPage() {
  const [, params] = useRoute('/setari/:tab');
  const [, navigate] = useLocation();
  const { data, isLoading } = useSettings();
  const status = useQuery<StatusOverviewDTO>({ queryKey: ['status'], enabled: false });
  const tab = (TABS.find((t) => t.value === params?.tab)?.value ?? 'general') as TabValue;
  const Active = TABS.find((t) => t.value === tab)!.Component;
  const missing = (data?.integrations ?? status.data?.integrations ?? []).filter((i) => !i.configured && ['llm', 'whmcs', 'directadmin', 'cloudflare', 'wordpress'].includes(i.key));
  return (
    <Page>
      <PageHeader title="Setări" />
      <Tabs
        value={tab}
        onChange={(v) => navigate(`/setari/${v}`)}
        tabs={TABS.map((t) => ({
          value: t.value,
          label: t.label,
          badge: t.value === 'integrari' ? missing.filter((m) => m.key !== 'llm').length || undefined : t.value === 'ai' ? (missing.some((m) => m.key === 'llm') ? 1 : undefined) : undefined,
        }))}
      />
      {isLoading ? <Loading /> : <Active />}
    </Page>
  );
}
