import { describe, expect, it } from 'vitest';
import { isWithinSchedule } from '../src/util/time';

// Program implicit: răspunsuri automate între 20:00 și 08:00 în zilele lucrătoare și tot weekendul (ora României).
const schedule = { weekdayStart: '20:00', weekdayEnd: '08:00', weekendsAllDay: true };
// 1 oct. 2026 este joi; România e pe ora de vară (UTC+3) până pe 25 oct.
const at = (iso: string) => Date.parse(iso);

describe('programul pentru răspunsuri automate', () => {
  it('joi la 10:00 → în program (doar ciorne)', () => {
    expect(isWithinSchedule(at('2026-10-01T07:00:00Z'), schedule)).toBe(false);
  });
  it('joi la 22:00 și vineri la 07:00 → automat', () => {
    expect(isWithinSchedule(at('2026-10-01T19:00:00Z'), schedule)).toBe(true);
    expect(isWithinSchedule(at('2026-10-02T04:00:00Z'), schedule)).toBe(true);
  });
  it('sâmbătă la prânz → automat doar dacă weekendul e inclus', () => {
    expect(isWithinSchedule(at('2026-10-03T09:00:00Z'), schedule)).toBe(true);
    expect(isWithinSchedule(at('2026-10-03T09:00:00Z'), { ...schedule, weekendsAllDay: false })).toBe(false);
  });
  it('limitele: 08:00 fix e în program, 20:00 fix e automat', () => {
    expect(isWithinSchedule(at('2026-10-01T05:00:00Z'), schedule)).toBe(false);
    expect(isWithinSchedule(at('2026-10-01T17:00:00Z'), schedule)).toBe(true);
  });
});
