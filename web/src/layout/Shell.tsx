import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Activity,
  BarChart3,
  Bell,
  CheckSquare,
  FileText,
  LogOut,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Settings,
  ShieldCheck,
  Siren,
  Ticket,
  WifiOff,
} from 'lucide-react';
import type { SessionInfoDTO, StatusOverviewDTO } from '@datix/shared';
import { api } from '../lib/api';
import { useEventsConnected } from '../lib/events';
import { NotificationsPanel, useUnreadCount } from './Notifications';
import { ConversationList } from '../pages/ChatSidebar';
import { useQueryClient } from '@tanstack/react-query';

interface NavItem {
  href: string;
  label: string;
  icon: typeof Activity;
  badge?: number;
  tone?: 'critical' | 'accent';
  match?: (loc: string) => boolean;
}

export function useStatus() {
  return useQuery({ queryKey: ['status'], queryFn: () => api.get<StatusOverviewDTO>('/api/status'), refetchInterval: 60_000 });
}

function useNav(): NavItem[] {
  const { data } = useStatus();
  const securityBadge = data ? data.findingsBySeverity.critical + data.findingsBySeverity.high : 0;
  return [
    { href: '/', label: 'Chat', icon: MessageSquare, match: (l) => l === '/' || l.startsWith('/chat') },
    { href: '/status', label: 'Status', icon: Activity, badge: data?.openIncidents.length ? data.openIncidents.length : undefined, tone: 'critical', match: (l) => l.startsWith('/status') || l.startsWith('/monitor') },
    { href: '/tichete', label: 'Tichete', icon: Ticket, badge: data?.ticketsNeedingAttention || undefined, tone: 'accent' },
    { href: '/securitate', label: 'Securitate', icon: ShieldCheck, badge: securityBadge || undefined, tone: 'critical' },
    { href: '/incidente', label: 'Incidente', icon: Siren },
    { href: '/business', label: 'Business', icon: BarChart3 },
    { href: '/rapoarte', label: 'Rapoarte', icon: FileText },
    { href: '/aprobari', label: 'Aprobări', icon: CheckSquare, badge: data?.pendingApprovals || undefined, tone: 'critical' },
    { href: '/setari', label: 'Setări', icon: Settings },
  ];
}

function NavBadge({ value, tone = 'accent' }: { value?: number; tone?: 'critical' | 'accent' }) {
  if (!value) return null;
  return (
    <span className={clsx('ml-auto min-w-5 rounded-full px-1.5 text-center text-[11px] font-semibold leading-5 text-white', tone === 'critical' ? 'bg-critical' : 'bg-accent')}>
      {value > 99 ? '99+' : value}
    </span>
  );
}

export function Shell({ session, children }: { session: SessionInfoDTO; children: ReactNode }) {
  const [location] = useLocation();
  const nav = useNav();
  const [notifOpen, setNotifOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const unread = useUnreadCount();
  const connected = useEventsConnected();
  const qc = useQueryClient();
  const isChat = location === '/' || location.startsWith('/chat');
  const active = (item: NavItem) => (item.match ? item.match(location) : location === item.href || location.startsWith(`${item.href}/`));

  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    qc.clear();
    window.location.href = '/login';
  };

  const mobileTabs = nav.filter((n) => ['/', '/status', '/tichete', '/securitate'].includes(n.href));
  const moreActive = !mobileTabs.some(active);
  const moreBadge = nav.filter((n) => !mobileTabs.includes(n)).reduce((s, n) => s + (n.badge ?? 0), 0);

  return (
    <div className="flex h-full">
      {/* ---------------------------------------------------------------- bară laterală (desktop) */}
      <aside className="hidden w-72 shrink-0 flex-col border-r border-line bg-surface lg:flex">
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
          <img src="/icons/favicon.svg" alt="" className="size-8 rounded-lg" />
          <div className="min-w-0">
            <div className="font-semibold leading-tight">{session.agentName}</div>
            <div className="flex items-center gap-1 text-xs text-ink-3">
              <span className={clsx('size-1.5 rounded-full', connected ? 'bg-good' : 'bg-ink-3')} />
              {connected ? 'Conectat live' : 'Se reconectează…'}
            </div>
          </div>
          <button onClick={() => setNotifOpen(true)} className="relative ml-auto rounded-lg p-2 text-ink-2 hover:bg-surface-2" aria-label="Notificări">
            <Bell className="size-5" />
            {unread > 0 && <span className="absolute top-1 right-1 size-2 rounded-full bg-critical" />}
          </button>
        </div>
        <nav className="px-2">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={clsx('flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors', active(item) ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:bg-surface-2/60 hover:text-ink')}
            >
              <item.icon className="size-[18px]" />
              {item.label}
              <NavBadge value={item.badge} tone={item.tone} />
            </Link>
          ))}
        </nav>
        {isChat ? (
          <div className="mt-3 flex min-h-0 flex-1 flex-col border-t border-line pt-2">
            <ConversationList />
          </div>
        ) : (
          <div className="flex-1" />
        )}
        <div className="border-t border-line p-2">
          <div className="flex items-center gap-2 rounded-xl px-3 py-2">
            <div className="flex size-8 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent">{(session.displayName ?? '?').slice(0, 1).toUpperCase()}</div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{session.displayName}</div>
              <div className="truncate text-xs text-ink-3">{session.email}</div>
            </div>
            <button onClick={logout} className="rounded-lg p-2 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="Ieșire" title="Ieșire">
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* ---------------------------------------------------------------- conținut */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* bară de sus pe mobil */}
        <header className="safe-top sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur lg:hidden">
          <div className="flex h-12 items-center gap-1 px-2">
            {isChat ? (
              <button onClick={() => setDrawerOpen(true)} className="rounded-lg p-2 text-ink-2" aria-label="Conversații">
                <Menu className="size-5" />
              </button>
            ) : (
              <img src="/icons/favicon.svg" alt="" className="ml-2 size-7 rounded-md" />
            )}
            <div className="ml-1 flex min-w-0 items-center gap-1.5 font-semibold">
              {session.agentName}
              {!connected && <WifiOff className="size-3.5 text-ink-3" aria-label="Reconectare" />}
            </div>
            <button onClick={() => setNotifOpen(true)} className="relative ml-auto rounded-lg p-2 text-ink-2" aria-label="Notificări">
              <Bell className="size-5" />
              {unread > 0 && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-critical" />}
            </button>
          </div>
        </header>

        {session.demoMode && (
          <div className="border-b border-warning/40 bg-warning-soft px-4 py-1.5 text-center text-xs text-warning-ink">
            Mod demo: datele și agentul sunt simulate. Conectează DeepSeek și integrările din <Link href="/setari" className="underline">Setări</Link>.
          </div>
        )}

        <main className={clsx('min-h-0 flex-1', isChat ? 'flex flex-col' : 'overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+72px)] lg:pb-0')}>{children}</main>

        {/* bara de navigare de jos pe mobil */}
        {!isChat && (
          <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur lg:hidden">
            <div className="grid grid-cols-5">
              {mobileTabs.map((item) => (
                <Link key={item.href} href={item.href} className={clsx('relative flex flex-col items-center gap-0.5 pt-2 pb-1.5 text-[11px] font-medium', active(item) ? 'text-accent' : 'text-ink-3')}>
                  <item.icon className="size-[22px]" />
                  {item.label}
                  {item.badge ? <span className={clsx('absolute top-1 left-1/2 ml-2 min-w-4 rounded-full px-1 text-[10px] leading-4 text-white', item.tone === 'critical' ? 'bg-critical' : 'bg-accent')}>{item.badge}</span> : null}
                </Link>
              ))}
              <Link href="/mai-mult" className={clsx('relative flex flex-col items-center gap-0.5 pt-2 pb-1.5 text-[11px] font-medium', moreActive ? 'text-accent' : 'text-ink-3')}>
                <MoreHorizontal className="size-[22px]" />
                Mai mult
                {moreBadge ? <span className="absolute top-1 left-1/2 ml-2 min-w-4 rounded-full bg-critical px-1 text-[10px] leading-4 text-white">{moreBadge}</span> : null}
              </Link>
            </div>
          </nav>
        )}
      </div>

      {/* sertar cu conversații (mobil) */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawerOpen(false)} />
          <div className="safe-top safe-bottom absolute inset-y-0 left-0 flex w-[86%] max-w-sm flex-col bg-surface shadow-2xl">
            <div className="flex items-center gap-2 px-4 py-3">
              <img src="/icons/favicon.svg" alt="" className="size-7 rounded-md" />
              <span className="font-semibold">{session.agentName}</span>
            </div>
            <nav className="grid grid-cols-4 gap-1 border-b border-line px-2 pb-2">
              {nav
                .filter((n) => n.href !== '/')
                .slice(0, 8)
                .map((item) => (
                  <Link key={item.href} href={item.href} onClick={() => setDrawerOpen(false)} className="relative flex flex-col items-center gap-1 rounded-xl py-2 text-[11px] text-ink-2 hover:bg-surface-2">
                    <item.icon className="size-5" />
                    {item.label}
                    {item.badge ? <span className="absolute top-1 right-2 min-w-4 rounded-full bg-critical px-1 text-[10px] leading-4 text-white">{item.badge}</span> : null}
                  </Link>
                ))}
            </nav>
            <div className="flex min-h-0 flex-1 flex-col pt-2">
              <ConversationList onNavigate={() => setDrawerOpen(false)} />
            </div>
          </div>
        </div>
      )}

      <NotificationsPanel open={notifOpen} onClose={() => setNotifOpen(false)} />
    </div>
  );
}
