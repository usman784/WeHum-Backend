import { and, eq, isNull, sql } from 'drizzle-orm';
import { challengeParticipants, challenges, meditations } from '../../db/schema';
import type { DB } from '../../infra/core.module';

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

/**
 * Called by the stats job for every counted meditation (same transaction as the stats). Progress, not streaks (client
 * rule of Oct 5): a challenge's progress is the number of different local days, since joining, with a meditation that
 * counts for it. Missed days never reset it; the same day twice counts once; a late offline meditation fills its day.
 * Recounted from the meditations each time, so retries and out-of-order syncs always give the same answer.
 */
export async function applyChallengeDay(tx: Tx, m: typeof meditations.$inferSelect) {
  const open = await tx
    .select({ p: challengeParticipants, c: challenges })
    .from(challengeParticipants)
    .innerJoin(challenges, eq(challenges.id, challengeParticipants.challengeId))
    .where(and(eq(challengeParticipants.userId, m.userId), isNull(challengeParticipants.finishedAt)))
    .for('update', { of: challengeParticipants });
  let moved = 0;
  for (const { p, c } of open) {
    const [r] = (await tx.execute<{ days: number; last: string | null }>(sql`
      SELECT count(DISTINCT m.local_date)::int AS days, max(m.local_date)::text AS last
      FROM meditations m
      LEFT JOIN sessions s ON s.id = m.session_id
      LEFT JOIN themes t ON t.id = s.theme_id
      WHERE m.user_id = ${m.userId} AND m.counted AND m.started_at >= ${p.joinedAt} AND m.duration_sec >= ${c.minMinutes * 60}
        AND (${c.counts} = 'any'
          OR (${c.counts} = 'group' AND m.kind = 'group')
          OR (${c.counts} = 'sleep' AND (t.name ILIKE '%sleep%' OR EXISTS (SELECT 1 FROM unnest(s.tags) tag WHERE tag ILIKE '%sleep%'))))`)).rows;
    const days = Math.min(r?.days ?? 0, c.days);
    if (days === p.completedDays) continue;
    await tx
      .update(challengeParticipants)
      .set({ completedDays: days, lastDay: r?.last ?? null, ...(days >= c.days && { finishedAt: sql`now()` }) })
      .where(and(eq(challengeParticipants.challengeId, c.id), eq(challengeParticipants.userId, m.userId)));
    moved++;
  }
  return moved;
}
