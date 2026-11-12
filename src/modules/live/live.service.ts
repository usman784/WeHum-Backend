import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { BELTS, BELT_NAMES, beltOf, beltsOf, countryName, emptyBelts, type BeltCounts } from '../../common/belts';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { K, REDIS } from '../../infra/redis';
import { ConfigService, type TodayConfig } from '../config/config.service';
import { liveLine } from '../meditations/meditation.rules';
import { HIDDEN_COUNTRY } from '../../realtime/presence.service';
import type { SilenceLive } from '../../realtime/socket-events';

/** Matches `LiveAgg` in realtime/socket-events.ts (+ `degraded` when Redis is unreachable). */
export interface LiveSnapshot {
  total: number | null;
  countries: number | null;
  top: { c: string; n: number }[];
  /** Where people meditated today (country → people), for the map when nobody is live right now. */
  todayTop: { c: string; n: number }[];
  /** The same people grouped into Americas / EMEA / APAC (hidden countries are not in a belt). */
  belts?: BeltCounts;
  /** Cities of people meditating now, only cities with at least PUBLIC_CITY_MIN people (the app's maps; the ticker adds it). */
  cities?: { c: string; name: string; lat: number; lng: number; n: number }[];
  quiet: boolean;
  meditatedToday: number | null;
  vibration: number;
  at: number;
  degraded?: true;
  line?: ReturnType<typeof liveLine>;
}

/** The `silence:live` socket payload from {@link LiveService.silence}. */
export const silenceLive = (s: Awaited<ReturnType<LiveService['silence']>>, at: number): SilenceLive =>
  ({ people: s.people, countries: s.countries, top: s.top, todayTop: s.todayTop, belts: s.belts, quiet: s.quiet, at });

/** Reads the live numbers the presence engine keeps in Redis (spec §7.4). Never faked: no presence → 0. */
@Injectable()
export class LiveService {
  private readonly log = new Logger('Live');
  constructor(@Inject(REDIS) private readonly redis: Redis, private readonly config: ConfigService, @Inject(DRIZZLE) private readonly db: DB) {}

  async snapshot(date: string): Promise<LiveSnapshot> {
    const today = await this.config.value<TodayConfig>('today');
    try {
      const [agg, meds, vib, doneByCountry, citiesJson] = await Promise.all([this.redis.hgetall(K.aggCountry), this.redis.get(K.medsToday(date)), this.redis.get(K.vibration), this.redis.hgetall(K.medsTodayCountry(date)), this.redis.get(K.liveCities)]);
      const all = Object.entries(agg).map(([c, n]) => ({ c, n: Number(n) })).filter((e) => e.n > 0);
      const total = all.reduce((s, e) => s + e.n, 0); // everyone counts…
      const entries = all.filter((e) => e.c !== HIDDEN_COUNTRY).sort((a, b) => b.n - a.n || a.c.localeCompare(b.c)); // …but hidden countries are never shown
      const meditatedToday = Number(meds) || 0;
      const todayTop = Object.entries(doneByCountry).map(([c, n]) => ({ c, n: Number(n) })).filter((e) => e.n > 0 && e.c !== HIDDEN_COUNTRY).sort((a, b) => b.n - a.n || a.c.localeCompare(b.c)).slice(0, 50);
      return {
        total, countries: entries.length, top: entries.slice(0, 50), todayTop, belts: beltsOf(entries), cities: citiesJson ? (JSON.parse(citiesJson) as NonNullable<LiveSnapshot['cities']>) : [], quiet: total < today.emptyRoomThreshold, meditatedToday,
        vibration: Number(vib) || 0, at: Date.now(), line: liveLine(total, meditatedToday, today.emptyRoomThreshold),
      };
    } catch (e) {
      this.log.warn(`live counts unavailable: ${(e as Error).message}`);
      return { total: null, countries: null, top: [], todayTop: [], belts: emptyBelts(), quiet: true, meditatedToday: null, vibration: 0, at: Date.now(), degraded: true };
    }
  }

  /** Who is meditating right now, one row per user: the base for the silence and world numbers (cached 5 s, 20k entries at most). */
  private async presenceRows(): Promise<{ user: string; country: string; mode: string }[]> {
    const hit = await this.redis.get('live:rows').catch(() => null);
    if (hit) return JSON.parse(hit);
    const ids = await this.redis.zrange(K.presenceZ, '0', '19999');
    const p = this.redis.pipeline();
    for (const id of ids) p.hmget(K.presenceMed(id), 'userId', 'country', 'mode');
    const res = (await p.exec()) ?? [];
    const seen = new Map<string, { user: string; country: string; mode: string }>();
    for (const [, v] of res) {
      const [user, country, mode] = (v ?? []) as (string | null)[];
      if (!user || !country) continue;
      const prev = seen.get(user);
      // a user in a group sit counts as group even if another meditation is open
      if (!prev || mode === 'group') seen.set(user, { user, country, mode: mode ?? 'solo' });
    }
    const rows = [...seen.values()];
    await this.redis.set('live:rows', JSON.stringify(rows), 'EX', 5).catch(() => null);
    return rows;
  }

  /**
   * The Silence Room live line: people meditating in silence now, by belt and by country (`top`, for the map and
   * "where people are meditating"), plus where people meditated in silence today (`todayTop`, the map of a quiet room).
   * Country level only: never who.
   */
  async silence(now = Date.now()) {
    const date = new Date(now).toISOString().slice(0, 10), dayStart = new Date(`${date}T00:00:00Z`);
    const [rows, today] = await Promise.all([
      this.presenceRows().catch(() => []),
      this.db.execute<{ country: string | null; n: number }>(sql`
        SELECT country, count(*)::int AS n FROM meditations WHERE kind = 'silence' AND counted AND started_at >= ${dayStart} GROUP BY country`).then((r) => r.rows).catch(() => []),
    ]);
    const mine = rows.filter((r) => r.mode === 'silence');
    const belts = emptyBelts();
    const byCountry = new Map<string, number>();
    for (const r of mine) {
      const b = beltOf(r.country); if (b) belts[b]++;
      if (r.country !== HIDDEN_COUNTRY) byCountry.set(r.country, (byCountry.get(r.country) ?? 0) + 1);
    }
    const rank = (m: Iterable<[string, number]>) => [...m].map(([c, n]) => ({ c, n })).filter((e) => e.n > 0).sort((a, b) => b.n - a.n || a.c.localeCompare(b.c)).slice(0, 50);
    const top = rank(byCountry);
    const todayTop = rank(today.filter((t) => t.country && t.country !== HIDDEN_COUNTRY).map((t) => [t.country!, Number(t.n)] as [string, number]));
    const todayTotal = today.reduce((s, t) => s + Number(t.n), 0);
    const zones = new Set(today.map((t) => (t.country ? beltOf(t.country) : null)).filter(Boolean)).size;
    const cfg = await this.config.value<TodayConfig>('today');
    return { people: mine.length, countries: byCountry.size, top, todayTop, belts, quiet: mine.length < cfg.emptyRoomThreshold, todayTotal, todayZones: zones, at: now };
  }

  /**
   * The world gauge (Stitch "Global Field"): numbers only, from country codes. `syncShare` = share of the people sitting
   * right now who are in a group sit (a real, defined number, not a score). `trendPct` compares the minutes sat so far
   * today with the same period yesterday (null without a baseline).
   */
  async world(now = Date.now()) {
    const date = new Date(now).toISOString().slice(0, 10), dayStart = new Date(`${date}T00:00:00Z`);
    const yStart = new Date(dayStart.getTime() - 86_400_000), yNow = new Date(now - 86_400_000);
    const [snap, rows, minutes, yMinutes] = await Promise.all([
      this.snapshot(date), this.presenceRows().catch(() => []),
      this.db.execute<{ country: string; mins: number }>(sql`SELECT country, round(sum(duration_sec) / 60.0)::int AS mins FROM meditations WHERE counted AND country IS NOT NULL AND started_at >= ${dayStart} GROUP BY country`).then((r) => r.rows),
      this.db.execute<{ mins: number }>(sql`SELECT coalesce(round(sum(duration_sec) / 60.0), 0)::int AS mins FROM meditations WHERE counted AND started_at >= ${yStart} AND started_at < ${yNow}`).then((r) => r.rows[0]?.mins ?? 0),
    ]);
    const minsBy = new Map(minutes.map((m) => [m.country, Number(m.mins)]));
    const total = [...minsBy.values()].reduce((s, n) => s + n, 0);
    const per = new Map<string, { n: number; group: number }>();
    for (const r of rows) { const e = per.get(r.country) ?? { n: 0, group: 0 }; e.n++; if (r.mode === 'group') e.group++; per.set(r.country, e); }
    const share = (n: number, g: number) => (n ? Math.round((g / n) * 100) : 0);
    const regions = BELTS.map((key) => {
      let n = 0, g = 0, m = 0;
      for (const [c, e] of per) if (beltOf(c) === key) { n += e.n; g += e.group; }
      for (const [c, v] of minsBy) if (beltOf(c) === key) m += v;
      return { key, name: BELT_NAMES[key], sittingNow: n, minutesToday: m, syncShare: share(n, g) };
    });
    const countries = new Set([...per.keys(), ...minsBy.keys()]);
    const belts = [...countries].map((c) => { const e = per.get(c) ?? { n: 0, group: 0 }; return { country: c, name: countryName(c), sittingNow: e.n, minutesToday: minsBy.get(c) ?? 0, syncShare: share(e.n, e.group) }; })
      .sort((a, b) => b.sittingNow - a.sittingNow || b.minutesToday - a.minutesToday || a.country.localeCompare(b.country)).slice(0, 12);
    return {
      total: snap.total, countries: snap.countries, vibration: snap.vibration, quiet: snap.quiet, meditatedToday: snap.meditatedToday,
      minutesToday: total, trendPct: yMinutes > 0 ? Math.round(((total - yMinutes) / yMinutes) * 100) : null, regions, belts, at: now,
    };
  }
}
