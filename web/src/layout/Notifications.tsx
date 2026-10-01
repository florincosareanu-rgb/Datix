import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import clsx from 'clsx';
import { Bell, CheckCheck } from 'lucide-react';
import type { NotificationDTO } from '@datix/shared';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';
import { Button, EmptyState, Modal } from '../components/ui';

interface NotificationsResponse {
  items: NotificationDTO[];
  unread: number;
}

export function useNotifications() {
  return useQuery({ queryKey: ['notifications'], queryFn: () => api.get<NotificationsResponse>('/api/notifications'), refetchInterval: 120_000 });
}

export function useUnreadCount() {
  return useNotifications().data?.unread ?? 0;
}

const DOT: Record<NotificationDTO['priority'], string> = {
  critical: 'bg-critical',
  high: 'bg-serious',
  normal: 'bg-accent',
  low: 'bg-line-strong',
};

export function NotificationsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data } = useNotifications();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const markRead = useMutation({
    mutationFn: (id?: string) => api.post('/api/notifications/read', { id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Notificări"
      footer={
        data?.unread ? (
          <Button size="sm" variant="ghost" icon={<CheckCheck className="size-4" />} onClick={() => markRead.mutate(undefined)}>
            Marchează toate ca citite
          </Button>
        ) : undefined
      }
    >
      {!data?.items.length ? (
        <EmptyState icon={<Bell className="size-8" />} title="Nicio notificare încă">
          Aici apar alertele despre site-uri, securitate, tichete și aprobări.
        </EmptyState>
      ) : (
        <ul className="-mx-2">
          {data.items.map((n) => (
            <li key={n.id}>
              <button
                className={clsx('flex w-full gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-surface-2', n.readAt && 'opacity-65')}
                onClick={() => {
                  if (!n.readAt) markRead.mutate(n.id);
                  if (n.url) {
                    onClose();
                    navigate(n.url);
                  }
                }}
              >
                <span className={clsx('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : DOT[n.priority])} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{n.title}</span>
                  <span className="mt-0.5 block text-[13px] text-ink-2">{n.body}</span>
                  <span className="mt-0.5 block text-xs text-ink-3">{timeAgo(n.at)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
