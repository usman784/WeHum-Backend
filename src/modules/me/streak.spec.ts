import { describe, expect, it } from 'vitest';
import { computeStreak } from './streak';

// 2026-10-12 is a Monday.
describe('computeStreak', () => {
  it('counts consecutive active days', () => {
    const s = computeStreak(['2026-10-12', '2026-10-13', '2026-10-14'], '2026-10-14');
    expect(s.current).toBe(3);
    expect(s.record).toBe(3);
    expect(s.graceLeft).toBe(1);
    expect(s.doneToday).toBe(true);
  });

  it('today is not a miss while it is still running', () => {
    const s = computeStreak(['2026-10-12', '2026-10-13'], '2026-10-14');
    expect(s.current).toBe(2);
    expect(s.doneToday).toBe(false);
    expect(s.week[2]!.state).toBe('today');
  });

  it('one missed day in a week is rest and keeps the run', () => {
    const s = computeStreak(['2026-10-12', '2026-10-14'], '2026-10-14');
    expect(s.current).toBe(2);
    expect(s.graceLeft).toBe(0);
    expect(s.week[1]!.state).toBe('rest');
  });

  it('a second miss in the same week resets the run', () => {
    // Mon active, Tue + Wed missed, Thu today
    const s = computeStreak(['2026-10-12'], '2026-10-15');
    expect(s.current).toBe(0);
    expect(s.record).toBe(1);
  });

  it('the grace day comes back with the next ISO week', () => {
    // Sat missed (grace, week 1), Tue missed (grace, week 2): the run survives
    const days = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-18', '2026-10-19', '2026-10-21'];
    const s = computeStreak(days, '2026-10-21');
    expect(s.current).toBe(8);
  });

  it('record survives a reset', () => {
    const days = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-15'];
    const s = computeStreak(days, '2026-10-15');
    expect(s.record).toBe(5);
    expect(s.current).toBe(1);
  });

  it('weekly goal progress', () => {
    const s = computeStreak(['2026-10-12', '2026-10-13', '2026-10-14'], '2026-10-14', { weeklyGoal: 5 });
    expect(s.goalDaysDone).toBe(3);
    expect(s.daysToGoal).toBe(2);
  });

  it('no history', () => {
    const s = computeStreak([], '2026-10-14');
    expect(s.current).toBe(0);
    expect(s.record).toBe(0);
    expect(s.graceLeft).toBe(1);
    expect(s.week.map((d) => d.state)).toEqual(['missed', 'missed', 'today', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
  });

  it('a late offline day fills the gap', () => {
    const s = computeStreak(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'], '2026-10-15');
    expect(s.current).toBe(4);
    expect(s.graceLeft).toBe(1);
  });
});
