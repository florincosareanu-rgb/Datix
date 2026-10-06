export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const now = (): number => Date.now();

/** Părțile datei într-un fus orar (implicit Europe/Bucharest). */
export function zonedParts(ts: number, timeZone = 'Europe/Bucharest') {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekdayMap[parts.weekday ?? 'Mon'] ?? 1,
  };
}

/** "YYYY-MM-DD" în fusul orar dat. */
export function zonedDate(ts: number, timeZone = 'Europe/Bucharest'): string {
  const p = zonedParts(ts, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Începutul lunii curente (în fusul orar dat), ca timestamp UTC aproximativ (suficient pentru agregări). */
export function startOfZonedMonth(ts: number, timeZone = 'Europe/Bucharest'): number {
  const p = zonedParts(ts, timeZone);
  const offsetMs = zonedOffsetMs(ts, timeZone);
  return Date.UTC(p.year, p.month - 1, 1, 0, 0, 0) - offsetMs;
}

export function startOfZonedDay(ts: number, timeZone = 'Europe/Bucharest'): number {
  const p = zonedParts(ts, timeZone);
  const offsetMs = zonedOffsetMs(ts, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0) - offsetMs;
}

/** Diferența (ms) dintre ora locală din fusul dat și UTC, la momentul ts. */
export function zonedOffsetMs(ts: number, timeZone = 'Europe/Bucharest'): number {
  const p = zonedParts(ts, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

export function parseHHMM(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return 0;
  return Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]));
}

/**
 * Verifică dacă momentul ts e în fereastra „automat”:
 * - în weekend (dacă weekendsAllDay) toată ziua;
 * - în zilele lucrătoare între start și end (poate trece peste miezul nopții, ex. 20:00 → 08:00).
 */
export function isWithinSchedule(
  ts: number,
  schedule: { weekdayStart: string; weekdayEnd: string; weekendsAllDay: boolean },
  timeZone = 'Europe/Bucharest',
): boolean {
  const p = zonedParts(ts, timeZone);
  const isWeekend = p.weekday === 0 || p.weekday === 6;
  if (isWeekend && schedule.weekendsAllDay) return true;
  const minutes = p.hour * 60 + p.minute;
  const start = parseHHMM(schedule.weekdayStart);
  const end = parseHHMM(schedule.weekdayEnd);
  if (start === end) return true;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

export function formatDateTimeRo(ts: number, timeZone = 'Europe/Bucharest'): string {
  return new Intl.DateTimeFormat('ro-RO', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));
}

export function formatDurationRo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h} h ${rm} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} zile ${rh} h` : `${d} zile`;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Ora locală „YYYY-MM-DD HH:MM” (în fusul dat) → timestamp UTC; null dacă formatul nu e valid. */
export function zonedLocalToUtc(value: string, timeZone = 'Europe/Bucharest'): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  // două treceri: decalajul se poate schimba (ora de vară) între ora „naivă” și cea reală
  let ts = naive - zonedOffsetMs(naive, timeZone);
  ts = naive - zonedOffsetMs(ts, timeZone);
  return ts;
}
