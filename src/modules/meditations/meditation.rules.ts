import { formatInTimeZone } from 'date-fns-tz';

/** A meditation counts when ≥ 180 s, or ≥ 50 % of a session shorter than 6 min (spec §8.2). */
export function isCounted(durationSec: number, sessionDurationSec?: number): boolean {
  if (durationSec >= 180) return true;
  if (sessionDurationSec && sessionDurationSec < 360) return durationSec >= sessionDurationSec * 0.5;
  return false;
}

/** User's local calendar date (YYYY-MM-DD) for an instant. */
export function localDate(at: Date, timeZone: string): string {
  return formatInTimeZone(at, timeZone, 'yyyy-MM-dd');
}

/** Validates client-sent times: not in the future (±5 min skew), ≤ 4 h, ended ≥ started. */
export function validTimes(startedAt: Date, endedAt: Date, now = new Date()): boolean {
  const skew = 5 * 60_000;
  return startedAt.getTime() <= now.getTime() + skew
    && endedAt.getTime() >= startedAt.getTime()
    && endedAt.getTime() - startedAt.getTime() <= 4 * 3600_000;
}

/** Empty-room rule (spec §1.2). */
export function liveLine(total: number, meditatedToday: number, threshold: number) {
  return total < threshold
    ? { quiet: true, number: meditatedToday, label: 'meditated today' }
    : { quiet: false, number: total, label: 'meditating now' };
}
