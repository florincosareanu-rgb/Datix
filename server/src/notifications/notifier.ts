import webpush from 'web-push';
import type { NotificationDTO, NotificationKind } from '@datix/shared';
import type { Services } from '../services';
import { getMeta, setMeta } from '../db';
import { newId } from '../util/ids';
import { MINUTE } from '../util/time';

export interface NotifyInput {
  kind: NotificationKind;
  title: string;
  body: string;
  url?: string | null;
  priority?: NotificationDTO['priority'];
  /** Evită notificările duplicate în 30 de minute. */
  dedupeKey?: string;
}

interface SubRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failures: number;
}

/** Notificări în aplicație + push pe iPhone (Web Push, iOS 16.4+ cu aplicația adăugată pe ecranul principal). */
export class Notifier {
  private vapid: { publicKey: string; privateKey: string } | null = null;

  constructor(private readonly s: Services) {}

  ensureVapid(): string {
    if (this.vapid) return this.vapid.publicKey;
    let publicKey = getMeta(this.s.db, 'vapid_public');
    let privateKey = this.s.secrets.get('push.vapidPrivateKey');
    if (!publicKey || !privateKey) {
      const keys = webpush.generateVAPIDKeys();
      publicKey = keys.publicKey;
      privateKey = keys.privateKey;
      setMeta(this.s.db, 'vapid_public', publicKey);
      this.s.secrets.set('push.vapidPrivateKey', privateKey);
    }
    this.vapid = { publicKey, privateKey };
    return publicKey;
  }

  vapidPublicKey(): string {
    return this.ensureVapid();
  }

  subscribe(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent: string | null): void {
    if (!/^https:\/\//.test(sub.endpoint)) throw new Error('Abonament push invalid.');
    this.s.db
      .prepare(
        `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, failures = 0`,
      )
      .run(newId('ps_'), sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent?.slice(0, 300) ?? null, Date.now());
  }

  unsubscribe(endpoint: string): void {
    this.s.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  subscriptionCount(): number {
    return (this.s.db.prepare('SELECT COUNT(*) n FROM push_subscriptions').get() as { n: number }).n;
  }

  private enabledFor(kind: NotificationKind): boolean {
    const n = this.s.settings.get().notifications;
    switch (kind) {
      case 'incident':
      case 'incident_resolved':
        return n.incidents;
      case 'approval':
        return n.approvals;
      case 'ticket':
        return n.tickets;
      case 'security':
        return n.security;
      case 'report':
        return n.dailyReport;
      case 'business':
        return n.business;
      case 'maintenance':
        return n.maintenance;
      case 'mission':
      case 'system':
        return true;
    }
  }

  async notify(input: NotifyInput): Promise<NotificationDTO | null> {
    if (input.dedupeKey) {
      const recent = this.s.db.prepare('SELECT 1 FROM notifications WHERE dedupe_key = ? AND at > ?').get(input.dedupeKey, Date.now() - 30 * MINUTE);
      if (recent) return null;
    }
    const dto: NotificationDTO = {
      id: newId('n_'),
      at: Date.now(),
      kind: input.kind,
      title: input.title.slice(0, 120),
      body: input.body.slice(0, 500),
      url: input.url ?? null,
      priority: input.priority ?? 'normal',
      readAt: null,
    };
    this.s.db
      .prepare('INSERT INTO notifications (id, at, kind, title, body, url, priority, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(dto.id, dto.at, dto.kind, dto.title, dto.body, dto.url, dto.priority, input.dedupeKey ?? null);
    this.s.bus.emit({ type: 'notification', notification: dto });
    if (this.enabledFor(input.kind)) await this.push(dto).catch((err) => this.s.log.warn({ err }, 'Trimiterea notificării push a eșuat'));
    return dto;
  }

  private async push(dto: NotificationDTO): Promise<void> {
    if (this.s.config.demoMode && !this.subscriptionCount()) return;
    const subs = this.s.db.prepare('SELECT * FROM push_subscriptions').all() as SubRow[];
    if (!subs.length) return;
    const { publicKey, privateKey } = { publicKey: this.ensureVapid(), privateKey: this.vapid!.privateKey };
    const subject = this.s.settings.get().notifications.vapidSubject;
    const payload = JSON.stringify({
      title: dto.title,
      body: dto.body,
      url: dto.url ?? '/',
      tag: `${dto.kind}-${dto.id}`,
      kind: dto.kind,
      priority: dto.priority,
      id: dto.id,
    });
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
            TTL: 24 * 3600,
            urgency: dto.priority === 'critical' || dto.priority === 'high' ? 'high' : 'normal',
            vapidDetails: { subject, publicKey, privateKey },
          });
          this.s.db.prepare('UPDATE push_subscriptions SET last_success_at = ?, failures = 0 WHERE id = ?').run(Date.now(), sub.id);
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410 || sub.failures >= 10) {
            this.s.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
          } else {
            this.s.db.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?').run(sub.id);
            this.s.log.warn({ status, body: (err as { body?: string }).body }, 'Push eșuat');
          }
        }
      }),
    );
  }

  async sendTest(): Promise<number> {
    const n = this.subscriptionCount();
    await this.notify({ kind: 'system', title: 'Notificare de test', body: 'Notificările DAX funcționează pe acest dispozitiv. ✅', priority: 'normal', url: '/' });
    return n;
  }

  list(limit = 50): NotificationDTO[] {
    const rows = this.s.db.prepare('SELECT * FROM notifications ORDER BY at DESC LIMIT ?').all(limit) as Array<{
      id: string;
      at: number;
      kind: NotificationKind;
      title: string;
      body: string;
      url: string | null;
      priority: NotificationDTO['priority'];
      read_at: number | null;
    }>;
    return rows.map((r) => ({ id: r.id, at: r.at, kind: r.kind, title: r.title, body: r.body, url: r.url, priority: r.priority, readAt: r.read_at }));
  }

  unreadCount(): number {
    return (this.s.db.prepare('SELECT COUNT(*) n FROM notifications WHERE read_at IS NULL').get() as { n: number }).n;
  }

  markRead(id?: string): void {
    if (id) this.s.db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL').run(Date.now(), id);
    else this.s.db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL').run(Date.now());
  }

  cleanup(): void {
    this.s.db.prepare('DELETE FROM notifications WHERE at < ?').run(Date.now() - 90 * 24 * 60 * MINUTE);
  }
}
