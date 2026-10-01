import { useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { BarChart3, Bell, CheckSquare, ChevronRight, FileText, LogOut, Monitor, Moon, Settings, Siren, Sun } from 'lucide-react';
import type { SessionInfoDTO } from '@datix/shared';
import { api } from '../lib/api';
import { useStatus } from '../layout/Shell';
import { getThemePref, setThemePref, type ThemePref } from '../lib/theme';
import { Card, Page, Segmented } from '../components/ui';

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
      <h1 className="mb-4 text-[22px] font-semibold tracking-tight">Mai mult</h1>
      <Card className="mb-5 overflow-hidden">
        {items.map((it) => (
          <Link key={it.href} href={it.href} className="flex items-center gap-3 border-t border-line px-4 py-3.5 first:border-t-0 active:bg-surface-2">
            <it.icon className="size-5 text-ink-2" />
            <span className="flex-1 font-medium">{it.label}</span>
            {it.badge ? <span className="min-w-5 rounded-full bg-critical px-1.5 text-center text-[11px] font-semibold leading-5 text-white">{it.badge}</span> : null}
            <ChevronRight className="size-4 text-ink-3" />
          </Link>
        ))}
      </Card>
      <Card className="mb-5 p-4">
        <div className="mb-2 text-sm font-medium">Aspect</div>
        <ThemePicker />
      </Card>
      <Card className="overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3.5">
          <div className="flex size-9 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent">{(session?.displayName ?? '?').slice(0, 1).toUpperCase()}</div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{session?.displayName}</div>
            <div className="truncate text-xs text-ink-3">{session?.email}</div>
          </div>
        </div>
        <button onClick={logout} className="flex w-full items-center gap-3 border-t border-line px-4 py-3.5 text-left font-medium text-critical-ink active:bg-surface-2">
          <LogOut className="size-5" /> Ieșire din cont
        </button>
      </Card>
    </Page>
  );
}
