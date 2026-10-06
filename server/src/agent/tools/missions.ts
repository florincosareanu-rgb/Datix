import { z } from 'zod';
import type { MissionScheduleDTO } from '@datix/shared';
import { defineTool, OWNER_ONLY, ToolFailure } from './types';
import { MissionError, type MissionInput } from '../../missions/service';
import { zonedLocalToUtc } from '../../util/time';

const scheduleShape = {
  frequency: z
    .enum(['once', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly'])
    .describe('once = o singură dată; hourly = la câteva ore; daily = zilnic; weekdays = luni–vineri; weekly = în anumite zile; monthly = lunar'),
  time: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('Ora locală HH:MM (România). Pentru hourly contează doar minutul. Implicit 09:00.'),
  weekdays: z.array(z.number().int().min(1).max(7)).optional().describe('Pentru weekly: 1 = luni, 2 = marți … 7 = duminică'),
  day_of_month: z.number().int().min(1).max(28).optional().describe('Pentru monthly: ziua din lună (1–28)'),
  every_hours: z.number().int().optional().describe('Pentru hourly: 1, 2, 3, 4, 6, 8 sau 12'),
  run_at: z.string().optional().describe('Pentru once: data și ora locală, format „YYYY-MM-DD HH:MM”'),
};

type ScheduleArgs = { frequency: MissionScheduleDTO['frequency']; time?: string; weekdays?: number[]; day_of_month?: number; every_hours?: number; run_at?: string };

function toSchedule(a: ScheduleArgs, tz: string): MissionInput['schedule'] {
  let runAt: number | null = null;
  if (a.frequency === 'once') {
    runAt = a.run_at ? zonedLocalToUtc(a.run_at, tz) : null;
    if (!runAt) throw new ToolFailure('Pentru o misiune „once” trimite run_at în formatul „YYYY-MM-DD HH:MM”.');
  }
  return { frequency: a.frequency, time: a.time, weekdays: a.weekdays, dayOfMonth: a.day_of_month, everyHours: a.every_hours, runAt };
}

const wrap = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (err) {
    if (err instanceof MissionError) throw new ToolFailure(err.message);
    throw err;
  }
};

export const missionTools = [
  defineTool({
    name: 'mission_create',
    label: 'Programez o misiune',
    description:
      'Creează o misiune recurentă pe care o vei executa singur la ora stabilită (ex. „în fiecare luni la 9 trimite-mi facturile restante”). prompt = instrucțiunea completă, la imperativ, ca și cum ți-ar fi dată atunci (fără „în fiecare luni”). Rezultatul ajunge la proprietar ca notificare. allow_changes = true doar dacă proprietarul a cerut explicit ca misiunea să și repare/modifice ceva singură.',
    schema: z.object({
      title: z.string().min(3).max(80).describe('Nume scurt, ex. „Facturi restante”'),
      prompt: z.string().min(5).max(4000),
      ...scheduleShape,
      allow_changes: z.boolean().default(false),
    }),
    risk: 'write',
    contexts: OWNER_ONLY,
    summarize: (a) => `Misiune nouă: „${a.title}”`,
    async execute(a, ctx) {
      const s = ctx.services;
      const mission = wrap(() =>
        s.missions.create({ title: a.title, prompt: a.prompt, schedule: toSchedule(a, s.settings.get().general.timezone), allowChanges: a.allow_changes }, 'agent'),
      );
      return { created: true, id: mission.id, title: mission.title, schedule: mission.scheduleText, nextRunAt: mission.nextRunAt ? new Date(mission.nextRunAt).toISOString() : null, allowChanges: mission.allowChanges };
    },
  }),
  defineTool({
    name: 'mission_list',
    label: 'Citesc misiunile programate',
    description: 'Misiunile programate: nume, programare, următoarea rulare, ultimul rezultat.',
    schema: z.object({}),
    risk: 'read',
    contexts: OWNER_ONLY,
    async execute(_a, ctx) {
      return ctx.services.missions.list().map((m) => ({
        id: m.id,
        title: m.title,
        prompt: m.prompt,
        schedule: m.scheduleText,
        enabled: m.enabled,
        allowChanges: m.allowChanges,
        nextRunAt: m.nextRunAt ? new Date(m.nextRunAt).toISOString() : null,
        lastRunAt: m.lastRunAt ? new Date(m.lastRunAt).toISOString() : null,
        lastStatus: m.lastStatus,
        lastSummary: m.lastSummary,
      }));
    },
  }),
  defineTool({
    name: 'mission_update',
    label: 'Modific o misiune',
    description: 'Modifică o misiune: activare/pauză, nume, instrucțiune, programare (trimite toate câmpurile de programare dacă o schimbi).',
    schema: z.object({
      id: z.string().min(3),
      enabled: z.boolean().optional(),
      title: z.string().min(3).max(80).optional(),
      prompt: z.string().min(5).max(4000).optional(),
      allow_changes: z.boolean().optional(),
      ...scheduleShape,
      frequency: scheduleShape.frequency.optional(),
    }),
    risk: 'write',
    contexts: OWNER_ONLY,
    summarize: (a) => `Modifică misiunea ${a.id}`,
    async execute(a, ctx) {
      const s = ctx.services;
      const schedule = a.frequency ? toSchedule({ ...a, frequency: a.frequency }, s.settings.get().general.timezone) : undefined;
      const m = wrap(() => s.missions.update(a.id, { enabled: a.enabled, title: a.title, prompt: a.prompt, allowChanges: a.allow_changes, schedule }));
      return { updated: true, title: m.title, schedule: m.scheduleText, enabled: m.enabled, nextRunAt: m.nextRunAt ? new Date(m.nextRunAt).toISOString() : null };
    },
  }),
  defineTool({
    name: 'mission_delete',
    label: 'Șterg o misiune',
    description: 'Șterge definitiv o misiune programată.',
    schema: z.object({ id: z.string().min(3) }),
    risk: 'write',
    contexts: OWNER_ONLY,
    summarize: (a) => `Șterge misiunea ${a.id}`,
    async execute(a, ctx) {
      if (!ctx.services.missions.delete(a.id)) throw new ToolFailure('Misiunea nu există.');
      return { deleted: true };
    },
  }),
  defineTool({
    name: 'mission_run_now',
    label: 'Pornesc misiunea acum',
    description: 'Rulează imediat o misiune (în fundal); rezultatul vine ca notificare.',
    schema: z.object({ id: z.string().min(3) }),
    risk: 'write',
    contexts: OWNER_ONLY,
    summarize: (a) => `Rulează acum misiunea ${a.id}`,
    async execute(a, ctx) {
      const m = wrap(() => ctx.services.missions.runNow(a.id));
      return { started: true, title: m.title };
    },
  }),
];
