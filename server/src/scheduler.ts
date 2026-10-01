import { Cron } from 'croner';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Services } from './services';
import { backupDatabase } from './db';
import { zonedDate, DAY } from './util/time';
import { errorMessage } from './util/text';

/** Sarcini periodice: reamintiri, expirări, curățenie, backup, raport zilnic. */
export function startScheduler(s: Services): () => void {
  const jobs: Cron[] = [];
  const safe = (name: string, fn: () => unknown) => async () => {
    try {
      await fn();
    } catch (err) {
      s.log.error({ err: errorMessage(err) }, `Sarcina programată „${name}” a eșuat`);
    }
  };

  jobs.push(
    new Cron('* * * * *', { protect: true }, safe('minut', () => {
      s.incidents.escalate();
      s.approvals.expireOld();
    })),
  );
  jobs.push(
    new Cron('17 * * * *', { protect: true }, safe('curățenie', () => {
      s.auth.cleanup();
      s.notifier.cleanup();
      s.db.prepare('DELETE FROM webhook_nonces WHERE at < ?').run(Date.now() - DAY);
      s.db.prepare('DELETE FROM events_inbox WHERE at < ?').run(Date.now() - 90 * DAY);
    })),
  );
  jobs.push(
    new Cron('40 3 * * *', { protect: true, timezone: 'Europe/Bucharest' }, safe('backup', () => {
      s.monitoring.cleanup();
      const dir = join(s.config.dataDir, 'backups');
      mkdirSync(dir, { recursive: true });
      backupDatabase(s.db, join(dir, `datix-${zonedDate(Date.now())}.db`));
      const files = readdirSync(dir).filter((f) => /^datix-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
      for (const f of files.slice(0, Math.max(0, files.length - 14))) unlinkSync(join(dir, f));
      s.log.info('Backup zilnic al bazei de date realizat');
    })),
  );

  // raportul zilnic — ora se poate schimba din setări
  let reportJob: Cron | null = null;
  const scheduleReport = () => {
    reportJob?.stop();
    const st = s.settings.get();
    const [h, m] = st.reports.dailyAt.split(':').map(Number);
    reportJob = new Cron(`${m ?? 0} ${h ?? 8} * * *`, { protect: true, timezone: st.general.timezone }, safe('raport zilnic', async () => {
      if (s.settings.get().reports.dailyEnabled) await s.reports.generateDaily();
    }));
  };
  scheduleReport();
  const unsubscribe = s.settings.onChange(() => scheduleReport());

  return () => {
    for (const j of jobs) j.stop();
    reportJob?.stop();
    unsubscribe();
  };
}
