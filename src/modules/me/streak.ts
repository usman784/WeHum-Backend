import { addDaysIso } from '../motd/motd.service';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** Monday = 0 … Sunday = 6 for a calendar date. */
const isoDow = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
const weekStart = (d: string) => addDaysIso(d, -isoDow(d));
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export type DayState = 'done' | 'rest' | 'today' | 'upcoming' | 'missed';
export interface StreakView {
  current: number; record: number;
  /** Grace days still unused this ISO week. */
  graceLeft: number; graceDays: number;
  weeklyGoal: number; goalDaysDone: number; daysToGoal: number;
  /** Today already has a counted meditation. */
  doneToday: boolean;
  week: { date: string; label: string; state: DayState; minutes: number }[];
}

/**
 * Forgiving streak (Stitch + roadmap S7). `activeDates` = local dates with a counted meditation.
 * - The run counts active days. A missed day is "rest" and keeps the run while that ISO week still has a grace day.
 * - A second miss in the same week resets the run to 0.
 * - Today is never a miss while it is running.
 * Pure function of the dates, so a late offline sync or a retry always gives the same answer.
 */
export function computeStreak(activeDates: string[], today: string, opts: { graceDays?: number; weeklyGoal?: number; minutesByDate?: Map<string, number> } = {}): StreakView {
  const graceDays = opts.graceDays ?? 1, weeklyGoal = opts.weeklyGoal ?? 5, minutes = opts.minutesByDate ?? new Map<string, number>();
  const active = new Set(activeDates.filter((d) => d <= today));
  const sorted = [...active].sort();
  let run = 0, record = 0;
  const graced = new Set<string>(), usedByWeek = new Map<string, number>();
  if (sorted.length) {
    for (let n = daysBetween(sorted[0]!, today), i = 0; i <= n; i++) {
      const d = addDaysIso(sorted[0]!, i);
      if (active.has(d)) { run++; record = Math.max(record, run); continue; }
      if (d === today || run === 0) continue; // still running, or nothing to protect
      const wk = weekStart(d), used = usedByWeek.get(wk) ?? 0;
      if (used < graceDays) { usedByWeek.set(wk, used + 1); graced.add(d); } else run = 0;
    }
  }
  const from = weekStart(today);
  const week = DOW.map((label, i) => {
    const date = addDaysIso(from, i);
    const state: DayState = active.has(date) ? 'done' : date === today ? 'today' : date > today ? 'upcoming' : graced.has(date) ? 'rest' : 'missed';
    return { date, label, state, minutes: minutes.get(date) ?? 0 };
  });
  const done = week.filter((d) => d.state === 'done').length;
  return {
    current: run, record, graceDays,
    graceLeft: Math.max(0, graceDays - (usedByWeek.get(from) ?? 0)),
    weeklyGoal, goalDaysDone: done, daysToGoal: Math.max(0, weeklyGoal - done), doneToday: active.has(today), week,
  };
}
