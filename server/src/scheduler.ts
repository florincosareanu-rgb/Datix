import { Cron } from 'croner';
import type { AppSettings } from '@datix/shared';
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

  // sarcinile cu oră aleasă din setări (raport, backup, actualizări, încasări, clienți, e-mail, SEO);
  // se reprogramează la fiecare schimbare a setărilor
  let dynamic: Cron[] = [];
  let signature = '';
  const scheduleDynamic = () => {
    const st = s.settings.get();
    const plan = dynamicPlan(st);
    const next = JSON.stringify(plan.map((p) => [p.name, p.pattern]).concat([['tz', st.general.timezone]]));
    if (next === signature) return;
    signature = next;
    for (const j of dynamic) j.stop();
    dynamic = plan.map((p) => new Cron(p.pattern, { protect: true, timezone: st.general.timezone, name: p.name }, safe(p.label, () => p.run(s))));
  };
  scheduleDynamic();
  const unsubscribe = s.settings.onChange(() => scheduleDynamic());

  s.missions.start();

  return () => {
    for (const j of jobs) j.stop();
    for (const j of dynamic) j.stop();
    unsubscribe();
    s.missions.stop();
  };
}

interface PlannedJob {
  name: string;
  label: string;
  pattern: string;
  run: (s: Services) => unknown;
}

const at = (hhmm: string, dow = '*') => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${m ?? 0} ${h ?? 0} * * ${dow}`;
};

/** Sarcinile programate după setările curente (exportat pentru teste și pentru „următoarea rulare”). */
export function dynamicPlan(st: AppSettings): PlannedJob[] {
  const plan: PlannedJob[] = [];
  if (st.reports.dailyEnabled) plan.push({ name: 'report', label: 'raport zilnic', pattern: at(st.reports.dailyAt), run: (s) => s.reports.generateDaily() });
  if (st.backups.enabled) plan.push({ name: 'backup', label: 'backup verificat', pattern: at(st.backups.time), run: (s) => s.backups.run('schedule') });
  if (st.updates.mode !== 'off') plan.push({ name: 'updates', label: 'actualizări sigure', pattern: at(st.updates.time), run: (s) => s.updates.run('schedule') });
  if (st.collections.enabled) plan.push({ name: 'collections', label: 'încasări', pattern: at(st.collections.time), run: (s) => s.integrations.isConfigured('whmcs') && s.collections.scan('schedule') });
  if (st.churn.enabled) plan.push({ name: 'churn', label: 'clienți în risc', pattern: at(st.churn.time, String(st.churn.weekday)), run: (s) => s.integrations.isConfigured('whmcs') && s.churn.analyze('schedule') });
  if (st.email.enabled) {
    plan.push({
      name: 'email',
      label: 'test de livrare e-mail',
      pattern: at(st.email.testTime),
      run: (s) => s.integrations.isConfigured('mailbox') && s.settings.get().email.whmcsTestClientId > 0 && s.email.runTest('schedule'),
    });
  }
  if (st.seo.enabled) plan.push({ name: 'seo', label: 'raport SEO', pattern: at(st.seo.time, String(st.seo.weekday)), run: (s) => s.integrations.isConfigured('gsc') && s.seo.generate('schedule') });
  return plan;
}

/** Următoarea rulare a unei sarcini programate (pentru interfață). */
export function nextRunOf(st: AppSettings, name: string): number | null {
  const job = dynamicPlan(st).find((j) => j.name === name);
  if (!job) return null;
  const probe = new Cron(job.pattern, { timezone: st.general.timezone, paused: true });
  const next = probe.nextRun()?.getTime() ?? null;
  probe.stop();
  return next;
}
