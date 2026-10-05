import { describe, expect, it } from 'vitest';
import { isCounted, liveLine, localDate, validTimes } from './meditation.rules';

describe('meditation rules', () => {
  it('counts ≥ 3 min', () => { expect(isCounted(180)).toBe(true); expect(isCounted(179)).toBe(false); });
  it('counts half of a short session', () => { expect(isCounted(150, 300)).toBe(true); expect(isCounted(149, 300)).toBe(false); });
  it('local date crosses midnight by tz', () => {
    const at = new Date('2026-10-05T23:30:00Z');
    expect(localDate(at, 'Europe/Berlin')).toBe('2026-10-06');
    expect(localDate(at, 'America/New_York')).toBe('2026-10-05');
  });
  it('local date on DST change day', () => {
    expect(localDate(new Date('2026-10-25T00:30:00Z'), 'Europe/Berlin')).toBe('2026-10-25');
  });
  it('rejects future / too long', () => {
    const now = new Date('2026-10-05T12:00:00Z');
    expect(validTimes(new Date('2026-10-05T12:10:00Z'), new Date('2026-10-05T12:20:00Z'), now)).toBe(false);
    expect(validTimes(new Date('2026-10-05T06:00:00Z'), new Date('2026-10-05T11:00:00Z'), now)).toBe(false);
    expect(validTimes(new Date('2026-10-05T11:00:00Z'), new Date('2026-10-05T11:30:00Z'), now)).toBe(true);
  });
  it('empty-room rule never fakes numbers', () => {
    expect(liveLine(4, 1280, 10)).toEqual({ quiet: true, number: 1280, label: 'meditated today' });
    expect(liveLine(412, 1280, 10)).toEqual({ quiet: false, number: 412, label: 'meditating now' });
  });
});
