import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Activity,
  BarChart3,
  Bell,
  CheckSquare,
  FileText,
  FlaskConical,
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
import { DaxOrb } from '../components/brand';

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

function NavBadge({ value, tone = 'accent', className }: { value?: number; tone?: 'critical' | 'accent'; className?: string }) {
  if (!value) return null;
  return (
    <span className={clsx('min-w-5 rounded-full px-1.5 text-center text-[11px] leading-5 font-semibold text-white tabular', tone === 'critical' ? 'bg-critical' : 'bg-accent', className)}>
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
      <aside className="glass hidden w-[288px] shrink-0 flex-col border-r border-line/70 lg:flex">
        <div className="flex items-center gap-3 px-5 pt-5 pb-4">
          <DaxOrb size={36} />
          <div className="min-w-0">
            <div className="font-display text-[20px] leading-tight font-semibold tracking-tight">{session.agentName}</div>
            <div className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
              <span className={clsx('size-1.5 rounded-full', connected ? 'bg-good shadow-[0_0_0_3px_rgb(12_163_12/0.18)]' : 'bg-ink-3')} aria-hidden />
              {connected ? 'Conectat live' : 'Se reconectează…'}
            </div>
          </div>
          <button onClick={() => setNotifOpen(true)} className="pressable relative ml-auto flex size-10 items-center justify-center rounded-full text-ink-2 hover:bg-surface-2 hover:text-ink" aria-label={unread ? `Notificări (${unread} necitite)` : 'Notificări'}>
            <Bell className="size-5" />
            {unread > 0 && <span className="absolute top-2 right-2 size-2 rounded-full bg-critical ring-2 ring-surface" aria-hidden />}
          </button>
        </div>
        <nav className="space-y-0.5 px-3" aria-label="Navigare principală">
          {nav.map((item) => {
            const on = active(item);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={on ? 'page' : undefined}
                className={clsx(
                  'pressable flex h-11 items-center gap-3 rounded-2xl px-3.5 text-[15px] font-medium',
                  on ? 'bg-accent-soft text-accent-fg' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                )}
              >
                <item.icon className="size-[19px]" aria-hidden />
                {item.label}
                <NavBadge value={item.badge} tone={item.tone} className="ml-auto" />
              </Link>
            );
          })}
        </nav>
        {isChat ? (
          <div className="mt-4 flex min-h-0 flex-1 flex-col border-t border-line/70 pt-3">
            <ConversationList />
          </div>
        ) : (
          <div className="flex-1" />
        )}
        <div className="border-t border-line/70 p-3">
          <div className="flex items-center gap-3 rounded-2xl px-2 py-2">
            <div className="flex size-9 items-center justify-center rounded-full bg-brand font-display text-[15px] font-semibold text-white" aria-hidden>
              {(session.displayName ?? '?').slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-medium">{session.displayName}</div>
              <div className="truncate text-[12.5px] text-ink-3">{session.email}</div>
            </div>
            <button onClick={logout} className="pressable flex size-10 items-center justify-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="Ieșire" title="Ieșire">
              <LogOut className="size-[18px]" />
            </button>
          </div>
        </div>
      </aside>

      {/* ---------------------------------------------------------------- conținut */}
      <div className="safe-x flex min-w-0 flex-1 flex-col">
        {/* bară de sus pe telefon */}
        <header className="glass safe-top sticky top-0 z-30 border-b border-line/60 lg:hidden">
          <div className="flex h-14 items-center gap-1 px-2">
            {isChat ? (
              <button onClick={() => setDrawerOpen(true)} className="pressable flex size-11 items-center justify-center rounded-full text-ink-2" aria-label="Conversații și meniu">
                <Menu className="size-[22px]" />
              </button>
            ) : (
              <span className="flex size-11 items-center justify-center">
                <DaxOrb size={26} />
              </span>
            )}
            <div className="flex min-w-0 items-center gap-1.5 font-display text-[18px] font-semibold tracking-tight">
              {session.agentName}
              {!connected && <WifiOff className="size-3.5 text-ink-3" aria-label="Se reconectează" />}
            </div>
            <button onClick={() => setNotifOpen(true)} className="pressable relative ml-auto flex size-11 items-center justify-center rounded-full text-ink-2" aria-label={unread ? `Notificări (${unread} necitite)` : 'Notificări'}>
              <Bell className="size-[22px]" />
              {unread > 0 && <span className="absolute top-2.5 right-2.5 size-2 rounded-full bg-critical ring-2 ring-page" aria-hidden />}
            </button>
          </div>
        </header>

        {session.demoMode && (
          <div className="flex items-center justify-center gap-2 border-b border-warning/30 bg-warning-soft px-4 py-2 text-center text-[13px] text-warning-ink">
            <FlaskConical className="size-4 shrink-0" aria-hidden />
            <span>
              Mod demo: date și agent simulate. Conectează DeepSeek și integrările din{' '}
              <Link href="/setari" className="font-medium underline underline-offset-2">
                Setări
              </Link>
              .
            </span>
          </div>
        )}

        {/* loc pentru bara de jos plutitoare; scroll-padding ține elementul focalizat deasupra ei */}
        <main
          className={clsx(
            'aurora min-h-0 flex-1',
            isChat
              ? 'flex flex-col'
              : 'overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+104px)] scroll-pb-[calc(env(safe-area-inset-bottom)+104px)] short:pb-[calc(env(safe-area-inset-bottom)+80px)] short:scroll-pb-[calc(env(safe-area-inset-bottom)+80px)] lg:pb-0 lg:scroll-pb-0',
          )}
        >
          {children}
        </main>

        {/* bara de navigare de jos pe telefon (plutitoare, din sticlă) */}
        {!isChat && (
          <nav
            className="glass glass-line float-shadow fixed z-30 rounded-[28px] lg:hidden"
            style={{ bottom: 'max(env(safe-area-inset-bottom), 12px)', left: 'max(env(safe-area-inset-left), 12px)', right: 'max(env(safe-area-inset-right), 12px)' }}
            aria-label="Navigare principală"
          >
            <div className="grid grid-cols-5 px-1.5 py-1.5">
              {[...mobileTabs.map((t) => ({ ...t, isActive: active(t) })), { href: '/mai-mult', label: 'Mai mult', icon: MoreHorizontal, badge: moreBadge || undefined, tone: 'critical' as const, isActive: moreActive }].map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={item.isActive ? 'page' : undefined}
                  className={clsx(
                    'pressable relative flex min-h-[54px] flex-col items-center justify-center gap-1 rounded-[22px] text-[11px] font-medium short:min-h-11 short:flex-row short:gap-2 short:text-[13px]',
                    item.isActive ? 'text-accent-fg short:bg-accent-soft' : 'text-ink-3',
                  )}
                >
                  <span className={clsx('flex h-7 w-12 items-center justify-center rounded-full transition-colors duration-200 short:w-auto', item.isActive && 'bg-accent-soft short:bg-transparent')}>
                    <item.icon className="size-[21px]" aria-hidden />
                  </span>
                  {item.label}
                  {item.badge ? <NavBadge value={item.badge} tone={item.tone} className="absolute top-0.5 left-1/2 ml-2 min-w-[18px] text-[10px] leading-[18px] short:static short:ml-0" /> : null}
                </Link>
              ))}
            </div>
          </nav>
        )}
      </div>

      {/* sertar cu conversații (telefon) */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-[rgb(10_11_18/0.45)] backdrop-blur-[3px]" onClick={() => setDrawerOpen(false)} />
          <div className="safe-top safe-bottom enter absolute inset-y-0 left-0 flex w-[86%] max-w-sm flex-col border-r border-line bg-surface pl-[env(safe-area-inset-left)] float-shadow">
            <div className="flex items-center gap-3 px-5 py-4">
              <DaxOrb size={30} />
              <span className="font-display text-[19px] font-semibold">{session.agentName}</span>
            </div>
            <nav className="grid grid-cols-4 gap-1 border-b border-line px-3 pb-3" aria-label="Secțiuni">
              {nav
                .filter((n) => n.href !== '/')
                .slice(0, 8)
                .map((item) => (
                  <Link key={item.href} href={item.href} onClick={() => setDrawerOpen(false)} className="pressable relative flex flex-col items-center gap-1.5 rounded-2xl py-2.5 text-[11.5px] font-medium text-ink-2 hover:bg-surface-2">
                    <span className="flex size-10 items-center justify-center rounded-xl bg-surface-2 text-ink-2">
                      <item.icon className="size-5" aria-hidden />
                    </span>
                    {item.label}
                    {item.badge ? <NavBadge value={item.badge} tone={item.tone} className="absolute top-1 right-2 min-w-[18px] text-[10px] leading-[18px]" /> : null}
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
