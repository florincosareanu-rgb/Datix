import { Cron } from 'croner';
import { WEEKDAY_LABEL, type MissionDTO, type MissionFrequency, type MissionScheduleDTO } from '@datix/shared';
import type { Services } from '../services';
import { newId } from '../util/ids';
import { errorMessage, safeJsonParse, truncate } from '../util/text';
import { formatDateTimeRo } from '../util/time';

// Misiunile programate: sarcini recurente cerute din chat („în fiecare luni la 9 trimite-mi facturile restante”).
// La ora stabilită, agentul rulează misiunea într-o conversație nouă (context „mission”) și îți trimite rezultatul.

interface MissionRow {
  id: string;
  title: string;
  prompt: string;
  schedule: string;
  allow_changes: number;
  enabled: number;
  created_by: 'owner' | 'agent';
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  last_status: MissionDTO['lastStatus'];
  last_summary: string | null;
  last_conversation_id: string | null;
  run_count: number;
}

export class MissionError extends Error {}

export const MAX_MISSIONS = 30;
const HOURLY_STEPS = [1, 2, 3, 4, 6, 8, 12];

export interface MissionInput {
  title: string;
  prompt: string;
  schedule: Partial<MissionScheduleDTO> & { frequency: MissionFrequency };
  allowChanges?: boolean;
  enabled?: boolean;
}

const hhmm = (value: string | undefined, fallback: string): string => {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new MissionError(`Ora „${value}” nu e validă (folosește HH:MM, ex. 09:00).`);
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
};

/** Completează și validează programarea (valori implicite rezonabile, limite clare). */
export function normalizeSchedule(input: Partial<MissionScheduleDTO> & { frequency: MissionFrequency }, now = Date.now()): MissionScheduleDTO {
  const frequency = input.frequency;
  if (!['once', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly'].includes(frequency)) throw new MissionError(`Frecvență necunoscută: ${frequency}`);
  const time = hhmm(input.time, frequency === 'hourly' ? '00:05' : '09:00');
  const weekdays = [...new Set((input.weekdays ?? []).map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort();
  if (frequency === 'weekly' && !weekdays.length) throw new MissionError('Pentru o misiune săptămânală alege cel puțin o zi (1 = luni … 7 = duminică).');
  const dayOfMonth = Math.trunc(Number(input.dayOfMonth ?? 1));
  if (frequency === 'monthly' && (dayOfMonth < 1 || dayOfMonth > 28)) throw new MissionError('Ziua din lună trebuie să fie între 1 și 28.');
  const everyHours = Math.trunc(Number(input.everyHours ?? 1));
  if (frequency === 'hourly' && !HOURLY_STEPS.includes(everyHours)) throw new MissionError(`Intervalul în ore poate fi: ${HOURLY_STEPS.join(', ')}.`);
  let runAt: number | null = null;
  if (frequency === 'once') {
    runAt = Number(input.runAt ?? 0) || null;
    if (!runAt) throw new MissionError('Pentru o misiune o singură dată, alege data și ora.');
    if (runAt < now - 60_000) throw new MissionError('Data aleasă a trecut deja.');
  }
  return {
    frequency,
    time,
    weekdays: frequency === 'weekly' ? weekdays : [],
    dayOfMonth: frequency === 'monthly' ? dayOfMonth : 1,
    everyHours: frequency === 'hourly' ? everyHours : 1,
    runAt,
  };
}

/** Expresia cron (în fusul orar al aplicației) sau momentul exact pentru „o singură dată”. */
export function cronFor(s: MissionScheduleDTO): string | Date {
  const [h, m] = s.time.split(':').map(Number);
  switch (s.frequency) {
    case 'once':
      return new Date(s.runAt ?? 0);
    case 'hourly':
      return `${m} ${s.everyHours === 1 ? '*' : `*/${s.everyHours}`} * * *`;
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekdays':
      return `${m} ${h} * * 1-5`;
    case 'weekly':
      return `${m} ${h} * * ${s.weekdays.join(',')}`;
    case 'monthly':
      return `${m} ${h} ${s.dayOfMonth} * *`;
  }
}

const joinRo = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} și ${items[items.length - 1]}`);

/** Descrierea programării, în română („în fiecare luni la 09:00”). */
export function describeSchedule(s: MissionScheduleDTO, tz = 'Europe/Bucharest'): string {
  switch (s.frequency) {
    case 'once':
      return `o singură dată, ${s.runAt ? formatDateTimeRo(s.runAt, tz) : '—'}`;
    case 'hourly':
      return s.everyHours === 1 ? `în fiecare oră, la minutul ${s.time.slice(3)}` : `la fiecare ${s.everyHours} ore (minutul ${s.time.slice(3)})`;
    case 'daily':
      return `zilnic la ${s.time}`;
    case 'weekdays':
      return `de luni până vineri la ${s.time}`;
    case 'weekly':
      return s.weekdays.length === 7 ? `zilnic la ${s.time}` : `în fiecare ${joinRo(s.weekdays.map((d) => WEEKDAY_LABEL[d] ?? String(d)))} la ${s.time}`;
    case 'monthly':
      return `lunar, pe ${s.dayOfMonth} ale lunii, la ${s.time}`;
  }
}

/** Prima frază utilă din răspunsul agentului (pentru notificare). */
export function summaryLine(text: string, max = 180): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').replace(/^[-*>]\s+/, '').replace(/\*\*|__|`/g, '').trim())
    .filter((l) => l && !/^[-=|]+$/.test(l));
  return truncate(clean[0] ?? '', max, '…');
}

export class MissionService {
  private readonly jobs = new Map<string, Cron>();
  private readonly queue: string[] = [];
  private runningId: string | null = null;
  private started = false;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly s: Services) {}

  // ------------------------------------------------------------ programare

  start(): void {
    if (this.started) return;
    this.started = true;
    this.rescheduleAll();
    let tz = this.s.settings.get().general.timezone;
    this.unsubscribe = this.s.settings.onChange((st) => {
      if (st.general.timezone !== tz) {
        tz = st.general.timezone;
        this.rescheduleAll();
      }
    });
  }

  stop(): void {
    for (const j of this.jobs.values()) j.stop();
    this.jobs.clear();
    this.unsubscribe?.();
    this.started = false;
  }

  private rescheduleAll(): void {
    for (const j of this.jobs.values()) j.stop();
    this.jobs.clear();
    for (const row of this.rows()) this.scheduleRow(row);
  }

  private scheduleRow(row: MissionRow): void {
    this.jobs.get(row.id)?.stop();
    this.jobs.delete(row.id);
    if (!this.started || row.enabled !== 1) return;
    const schedule = safeJsonParse<MissionScheduleDTO | null>(row.schedule, null);
    if (!schedule) return;
    if (schedule.frequency === 'once' && (schedule.runAt ?? 0) < Date.now()) return;
    const job = new Cron(cronFor(schedule), { timezone: this.s.settings.get().general.timezone, protect: true }, () => this.enqueue(row.id));
    this.jobs.set(row.id, job);
  }

  private nextRunAt(row: MissionRow): number | null {
    if (row.enabled !== 1) return null;
    const live = this.jobs.get(row.id);
    if (live) return live.nextRun()?.getTime() ?? null;
    const schedule = safeJsonParse<MissionScheduleDTO | null>(row.schedule, null);
    if (!schedule) return null;
    if (schedule.frequency === 'once') return (schedule.runAt ?? 0) > Date.now() ? schedule.runAt : null;
    const probe = new Cron(cronFor(schedule), { timezone: this.s.settings.get().general.timezone, paused: true });
    const next = probe.nextRun()?.getTime() ?? null;
    probe.stop();
    return next;
  }

  // ------------------------------------------------------------ citire

  private rows(): MissionRow[] {
    return this.s.db.prepare('SELECT * FROM missions ORDER BY created_at').all() as MissionRow[];
  }

  private row(id: string): MissionRow | null {
    return (this.s.db.prepare('SELECT * FROM missions WHERE id = ?').get(id) as MissionRow | undefined) ?? null;
  }

  private toDTO(r: MissionRow): MissionDTO {
    const schedule = safeJsonParse<MissionScheduleDTO>(r.schedule, { frequency: 'daily', time: '09:00', weekdays: [], dayOfMonth: 1, everyHours: 1, runAt: null });
    return {
      id: r.id,
      title: r.title,
      prompt: r.prompt,
      schedule,
      scheduleText: describeSchedule(schedule, this.s.settings.get().general.timezone),
      allowChanges: r.allow_changes === 1,
      enabled: r.enabled === 1,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      nextRunAt: this.nextRunAt(r),
      lastRunAt: r.last_run_at,
      lastStatus: r.last_status,
      lastSummary: r.last_summary,
      lastConversationId: r.last_conversation_id,
      runCount: r.run_count,
      running: this.runningId === r.id || this.queue.includes(r.id),
    };
  }

  list(): MissionDTO[] {
    return this.rows().map((r) => this.toDTO(r));
  }

  get(id: string): MissionDTO | null {
    const r = this.row(id);
    return r ? this.toDTO(r) : null;
  }

  allowsChanges(id: string): boolean {
    return this.row(id)?.allow_changes === 1;
  }

  // ------------------------------------------------------------ modificare

  create(input: MissionInput, createdBy: 'owner' | 'agent' = 'owner'): MissionDTO {
    const count = (this.s.db.prepare('SELECT COUNT(*) n FROM missions').get() as { n: number }).n;
    if (count >= MAX_MISSIONS) throw new MissionError(`Poți avea cel mult ${MAX_MISSIONS} misiuni. Șterge una pe care nu o mai folosești.`);
    const title = input.title.trim().slice(0, 80);
    const prompt = input.prompt.trim().slice(0, 4000);
    if (title.length < 3) throw new MissionError('Dă-i misiunii un nume (minim 3 caractere).');
    if (prompt.length < 5) throw new MissionError('Descrie ce trebuie să facă DAX (minim 5 caractere).');
    const schedule = normalizeSchedule(input.schedule);
    const id = newId('mis_');
    const now = Date.now();
    this.s.db
      .prepare('INSERT INTO missions (id, title, prompt, schedule, allow_changes, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, title, prompt, JSON.stringify(schedule), input.allowChanges ? 1 : 0, input.enabled === false ? 0 : 1, createdBy, now, now);
    this.scheduleRow(this.row(id)!);
    this.s.audit.log({ actor: createdBy, action: 'mission.created', target: title, details: describeSchedule(schedule, this.s.settings.get().general.timezone) });
    return this.emit(id)!;
  }

  update(id: string, patch: Partial<Omit<MissionInput, 'schedule'>> & { schedule?: MissionInput['schedule'] }): MissionDTO {
    const row = this.row(id);
    if (!row) throw new MissionError('Misiunea nu există.');
    const title = patch.title !== undefined ? patch.title.trim().slice(0, 80) : row.title;
    const prompt = patch.prompt !== undefined ? patch.prompt.trim().slice(0, 4000) : row.prompt;
    if (title.length < 3) throw new MissionError('Dă-i misiunii un nume (minim 3 caractere).');
    if (prompt.length < 5) throw new MissionError('Descrie ce trebuie să facă DAX (minim 5 caractere).');
    const schedule = patch.schedule ? normalizeSchedule(patch.schedule) : safeJsonParse<MissionScheduleDTO>(row.schedule, normalizeSchedule({ frequency: 'daily' }));
    const enabled = patch.enabled === undefined ? row.enabled === 1 : patch.enabled;
    if (enabled && schedule.frequency === 'once' && (schedule.runAt ?? 0) < Date.now()) throw new MissionError('Misiunea „o singură dată” a trecut; alege o dată nouă.');
    this.s.db
      .prepare('UPDATE missions SET title = ?, prompt = ?, schedule = ?, allow_changes = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(title, prompt, JSON.stringify(schedule), (patch.allowChanges ?? row.allow_changes === 1) ? 1 : 0, enabled ? 1 : 0, Date.now(), id);
    this.scheduleRow(this.row(id)!);
    this.s.audit.log({ actor: 'owner', action: 'mission.updated', target: title });
    return this.emit(id)!;
  }

  delete(id: string): boolean {
    const row = this.row(id);
    if (!row) return false;
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
    this.s.db.prepare('DELETE FROM missions WHERE id = ?').run(id);
    this.s.audit.log({ actor: 'owner', action: 'mission.deleted', target: row.title });
    return true;
  }

  /** Pornește misiunea acum (în fundal, la rând cu celelalte). */
  runNow(id: string): MissionDTO {
    if (!this.row(id)) throw new MissionError('Misiunea nu există.');
    this.enqueue(id);
    return this.get(id)!;
  }

  private emit(id: string): MissionDTO | null {
    const dto = this.get(id);
    if (dto) this.s.bus.emit({ type: 'mission', mission: dto });
    return dto;
  }

  // ------------------------------------------------------------ execuție

  private enqueue(id: string): void {
    if (this.runningId === id || this.queue.includes(id)) return;
    this.queue.push(id);
    this.emit(id);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.runningId) return;
    while (this.queue.length) {
      const id = this.queue.shift()!;
      this.runningId = id;
      try {
        await this.execute(id);
      } catch (err) {
        this.s.log.error({ err: errorMessage(err), mission: id }, 'Misiunea programată a eșuat');
      } finally {
        this.runningId = null;
        this.emit(id);
      }
    }
  }

  /** Rulează misiunea și o notifică pe proprietar. Întoarce conversația creată (dacă a rulat). */
  async execute(id: string): Promise<string | null> {
    const row = this.row(id);
    if (!row) return null;
    const tz = this.s.settings.get().general.timezone;
    const finish = (status: MissionDTO['lastStatus'], summary: string, conversationId: string | null) => {
      this.s.db
        .prepare('UPDATE missions SET last_run_at = ?, last_status = ?, last_summary = ?, last_conversation_id = COALESCE(?, last_conversation_id), run_count = run_count + 1 WHERE id = ?')
        .run(Date.now(), status, truncate(summary, 500, '…'), conversationId, id);
      const schedule = safeJsonParse<MissionScheduleDTO | null>(row.schedule, null);
      if (schedule?.frequency === 'once') {
        this.s.db.prepare('UPDATE missions SET enabled = 0 WHERE id = ?').run(id);
        this.scheduleRow(this.row(id)!);
      }
    };

    const llm = this.s.llm;
    const blocked = !llm.isAvailable()
      ? 'AI-ul nu e configurat (Setări → AI).'
      : llm.budgetExceeded() && this.s.settings.get().llm.hardStopAtBudget
        ? 'Bugetul lunar pentru AI a fost atins.'
        : null;
    if (blocked) {
      finish('skipped', blocked, null);
      void this.s.notifier.notify({ kind: 'mission', title: `🗓️ ${row.title}: nu a rulat`, body: blocked, priority: 'normal', url: '/misiuni', dedupeKey: `mission-skip:${id}` });
      return null;
    }

    const conversationId = this.s.conversations.create('mission', `🗓️ ${row.title} · ${formatDateTimeRo(Date.now(), tz)}`, id);
    const intro = [
      `Misiune programată: **${row.title}** (${describeSchedule(safeJsonParse(row.schedule, normalizeSchedule({ frequency: 'daily' })), tz)}).`,
      row.allow_changes === 1
        ? 'Ai voie să faci singur modificări reversibile; cele ireversibile se trimit spre aprobare.'
        : 'Nu face modificări fără aprobare: dacă e nevoie de o acțiune, propune-o (va fi trimisă proprietarului).',
      '',
      row.prompt,
    ].join('\n');
    this.s.conversations.append({ conversationId, role: 'user', content: intro });

    try {
      const outcome = await this.s.agent.run({ conversationId, context: 'mission', trigger: `mission:${id}` });
      const ok = outcome.status !== 'error' && outcome.status !== 'cancelled';
      const summary = summaryLine(outcome.finalText) || (ok ? 'Misiunea s-a încheiat.' : outcome.error ?? 'Misiunea s-a oprit cu eroare.');
      finish(ok ? 'ok' : 'error', summary, conversationId);
      void this.s.notifier.notify({
        kind: 'mission',
        title: `🗓️ ${row.title}`,
        body: ok ? summary : `Nu am putut termina: ${outcome.error ?? summary}`,
        priority: ok ? 'normal' : 'high',
        url: `/chat/${conversationId}`,
      });
    } catch (err) {
      const msg = errorMessage(err);
      finish('error', msg, conversationId);
      void this.s.notifier.notify({ kind: 'mission', title: `🗓️ ${row.title}: eroare`, body: truncate(msg, 200, '…'), priority: 'high', url: `/chat/${conversationId}` });
    }
    return conversationId;
  }
}
