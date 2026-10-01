import { useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { BarChart3, Bell, CheckSquare, ChevronRight, FileText, LogOut, Monitor, Moon, Settings, Siren, Sun } from 'lucide-react';
import type { SessionInfoDTO } from '@datix/shared';
import { api } from '../lib/api';
import { useStatus } from '../layout/Shell';
import { getThemePref, setThemePref, type ThemePref } from '../lib/theme';
import { Card, IconTile, Page, Segmented } from '../components/ui';

export function ThemePicker() {
  const [theme, setTheme] = useState<ThemePref>(getThemePref());
  return (
    <Segmented
      value={theme}
      onChange={(t) => {
        setTheme(t);
        setThemePref(t);
      }}
      options={[
        { value: 'system', label: 'Automat', icon: <Monitor className="size-4" /> },
        { value: 'light', label: 'Luminos', icon: <Sun className="size-4" /> },
        { value: 'dark', label: 'Întunecat', icon: <Moon className="size-4" /> },
      ]}
    />
  );
}

export function MorePage() {
  const { data } = useStatus();
  const qc = useQueryClient();
  const session = qc.getQueryData<SessionInfoDTO>(['session']);
  const items = [
    { href: '/incidente', label: 'Incidente', icon: Siren, badge: data?.openIncidents.length },
    { href: '/aprobari', label: 'Aprobări', icon: CheckSquare, badge: data?.pendingApprovals },
    { href: '/business', label: 'Business', icon: BarChart3 },
    { href: '/rapoarte', label: 'Rapoarte', icon: FileText },
    { href: '/setari/notificari', label: 'Notificări pe iPhone', icon: Bell },
    { href: '/setari', label: 'Setări', icon: Settings },
  ];
  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    qc.clear();
    window.location.href = '/login';
  };
  return (
    <Page>
      <h1 className="mb-6 font-display text-[30px] leading-tight font-semibold tracking-tight">Mai mult</h1>
      <Card className="enter-stagger mb-6 overflow-hidden">
        {items.map((it) => (
          <Link key={it.href} href={it.href} className="flex min-h-[60px] items-center gap-3.5 border-t border-line/70 px-4 py-2.5 transition-colors first:border-t-0 hover:bg-surface-2/60 active:bg-surface-2">
            <IconTile>
              <it.icon />
            </IconTile>
            <span className="flex-1 text-[16px] font-medium">{it.label}</span>
            {it.badge ? <span className="tabular min-w-5 rounded-full bg-critical px-1.5 text-center text-[11px] leading-5 font-semibold text-white">{it.badge}</span> : null}
            <ChevronRight className="size-[18px] text-ink-3" aria-hidden />
          </Link>
        ))}
      </Card>
      <Card className="mb-6 p-5">
        <div className="mb-3 font-display text-[16px] font-semibold">Aspect</div>
        <ThemePicker />
      </Card>
      <Card className="overflow-hidden">
        <div className="flex items-center gap-3.5 px-4 py-4">
          <div className="flex size-11 items-center justify-center rounded-full bg-brand font-display text-[17px] font-semibold text-white" aria-hidden>
            {(session?.displayName ?? '?').slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[16px] font-medium">{session?.displayName}</div>
            <div className="truncate text-[14px] text-ink-3">{session?.email}</div>
          </div>
        </div>
        <button onClick={logout} className="flex min-h-[56px] w-full items-center gap-3 border-t border-line/70 px-4 py-3 text-left text-[16px] font-medium text-critical-ink transition-colors hover:bg-critical-soft/50 active:bg-surface-2">
          <LogOut className="size-5" aria-hidden /> Ieșire din cont
        </button>
      </Card>
    </Page>
  );
}
