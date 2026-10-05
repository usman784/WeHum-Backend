export interface VibrationInput {
  meditationsToday: number;      // counted meditations so far today
  avgSameTime28d: number;        // average number of meditations by this time of day over the last 28 days
  groupJoinedToday: number;
  avgGroupJoined28d: number;
  previous: number | null;       // last smoothed value (null on the first run)
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const EMA_ALPHA = 0.3;

/**
 * World Vibration 0–100 (spec §7.5): `50 * (today / usual) + groupBonus`, groupBonus up to 30, smoothed with an EMA (α = 0.3).
 * "Usual" is what happened by this time of day on average over the last 28 days. With no history, any activity counts as normal (1×).
 */
export function vibration(i: VibrationInput): number {
  const ratio = i.avgSameTime28d > 0 ? i.meditationsToday / i.avgSameTime28d : i.meditationsToday > 0 ? 1 : 0;
  const bonus = Math.min(30, (30 * i.groupJoinedToday) / Math.max(1, i.avgGroupJoined28d));
  const raw = clamp(50 * ratio + bonus, 0, 100);
  const smoothed = i.previous === null ? raw : EMA_ALPHA * raw + (1 - EMA_ALPHA) * i.previous;
  return Math.round(clamp(smoothed, 0, 100) * 10) / 10;
}
