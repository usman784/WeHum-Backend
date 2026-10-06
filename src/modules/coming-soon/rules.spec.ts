import { describe, expect, it } from 'vitest';
import { MILESTONES, milestones, patternProblem } from './rules';

describe('milestones', () => {
  it('12 awards; reached by the right numbers; progress is capped at the target', () => {
    expect(MILESTONES).toHaveLength(12);
    const list = milestones({ meditations: 64, minutes: 820, days: 12, group: 48, dedications: 2 });
    const by = Object.fromEntries(list.map((m) => [m.key, m]));
    expect(by.first!.reached).toBe(true);
    expect(by.days7!.reached).toBe(true);
    expect(by.days21!).toMatchObject({ reached: false, value: 12, target: 21 });
    expect(by.minutes500!.reached).toBe(true);
    expect(by.minutes1000!).toMatchObject({ reached: false, value: 820 });
    expect(by.group10!.reached).toBe(true);
    expect(by.meditations50!).toMatchObject({ reached: true, value: 50 });
    expect(by.group50!).toMatchObject({ reached: false, value: 48 });
    expect(list.filter((m) => m.reached)).toHaveLength(6); // first, days7, minutes100, group10, minutes500, meditations50
  });
});

describe('patternProblem', () => {
  it('accepts the templates and refuses bad patterns', () => {
    expect(patternProblem({ inhaleSec: 4, hold1Sec: 7, exhaleSec: 8, hold2Sec: 0, rounds: 10 })).toBeNull();
    expect(patternProblem({ inhaleSec: 4, hold1Sec: 4, exhaleSec: 4, hold2Sec: 4, rounds: 10 })).toBeNull();
    expect(patternProblem({ inhaleSec: 0, hold1Sec: 0, exhaleSec: 4, hold2Sec: 0, rounds: 10 })).toMatch(/at least 1 second/);
    expect(patternProblem({ inhaleSec: 21, hold1Sec: 0, exhaleSec: 4, hold2Sec: 0, rounds: 10 })).toMatch(/0–20/);
    expect(patternProblem({ inhaleSec: 20, hold1Sec: 20, exhaleSec: 20, hold2Sec: 1, rounds: 10 })).toMatch(/60 seconds/);
    expect(patternProblem({ inhaleSec: 4, hold1Sec: 0, exhaleSec: 4, hold2Sec: 0, rounds: 0 })).toMatch(/Rounds/);
  });
});
