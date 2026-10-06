/**
 * Pure rules of the "coming soon" features (P11), kept free of I/O so they are unit-tested on their own.
 */

export const FEATURES = ['challenges', 'gratitude', 'breathwork', 'milestones', 'intent'] as const;
export type Feature = (typeof FEATURES)[number];

/** The milestones of app screen 73, in display order. `metric` names a number from `MilestoneStats`. */
export const MILESTONES = [
  { key: 'first', label: 'First meditation', badge: '1', metric: 'meditations', target: 1 },
  { key: 'days7', label: '7 days meditated', badge: '7', metric: 'days', target: 7 },
  { key: 'minutes100', label: '100 minutes', badge: '100', metric: 'minutes', target: 100 },
  { key: 'group10', label: '10 group meditations', badge: '10', metric: 'group', target: 10 },
  { key: 'days21', label: '21 days meditated', badge: '21', metric: 'days', target: 21 },
  { key: 'minutes500', label: '500 minutes', badge: '500', metric: 'minutes', target: 500 },
  { key: 'dedications10', label: '10 dedications', badge: '10', metric: 'dedications', target: 10 },
  { key: 'meditations50', label: '50 meditations', badge: '50', metric: 'meditations', target: 50 },
  { key: 'minutes1000', label: '1,000 minutes', badge: '1k', metric: 'minutes', target: 1000 },
  { key: 'days50', label: '50 days meditated', badge: '50', metric: 'days', target: 50 },
  { key: 'group50', label: '50 group meditations', badge: '50', metric: 'group', target: 50 },
  { key: 'days100', label: '100 days meditated', badge: '100', metric: 'days', target: 100 },
] as const;
export type MilestoneStats = { meditations: number; minutes: number; days: number; group: number; dedications: number };

export function milestones(stats: MilestoneStats) {
  return MILESTONES.map((m) => ({ key: m.key, label: m.label, badge: m.badge, target: m.target, value: Math.min(stats[m.metric], m.target), reached: stats[m.metric] >= m.target }));
}

/** A breathing pattern is valid when each beat is 0–20 s, in and out are at least 1 s, and a round is ≤ 60 s. */
export function patternProblem(p: { inhaleSec: number; hold1Sec: number; exhaleSec: number; hold2Sec: number; rounds: number }) {
  const beats = [p.inhaleSec, p.hold1Sec, p.exhaleSec, p.hold2Sec];
  if (beats.some((b) => !Number.isInteger(b) || b < 0 || b > 20)) return 'Each beat is 0–20 seconds';
  if (p.inhaleSec < 1 || p.exhaleSec < 1) return 'Breathe in and out for at least 1 second';
  if (beats.reduce((a, b) => a + b, 0) > 60) return 'One round is at most 60 seconds';
  if (!Number.isInteger(p.rounds) || p.rounds < 1 || p.rounds > 100) return 'Rounds are 1–100';
  return null;
}
