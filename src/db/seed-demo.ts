/**
 * Demo audience for local/staging screens: ~240 dummy people across the world with a streak of recent sits, so the world
 * map, belts, dashboard and Users list have something to show. Every demo account has an e-mail ending `@demo.wehum`
 * (removed and re-created on each run). `--presence` keeps ~40 of them "sitting right now" until stopped.
 * Usage: npm run seed:demo [-- --presence]
 */
import Redis from 'ioredis';
import { v7 as uuid } from 'uuid';
import { env } from '../config/env';
import { PresenceService } from '../realtime/presence.service';
import { createPool } from './client';
import { K } from '../infra/redis';

const COUNTRIES: [string, number, string][] = [
  ['US', 30, 'America/New_York'], ['GB', 14, 'Europe/London'], ['DE', 14, 'Europe/Berlin'], ['FR', 8, 'Europe/Paris'], ['ES', 6, 'Europe/Madrid'], ['IT', 6, 'Europe/Rome'],
  ['NL', 5, 'Europe/Amsterdam'], ['SE', 4, 'Europe/Stockholm'], ['PL', 4, 'Europe/Warsaw'], ['TR', 4, 'Europe/Istanbul'], ['CA', 10, 'America/Toronto'], ['MX', 7, 'America/Mexico_City'],
  ['BR', 10, 'America/Sao_Paulo'], ['AR', 4, 'America/Argentina/Buenos_Aires'], ['CO', 3, 'America/Bogota'], ['AU', 8, 'Australia/Sydney'], ['NZ', 3, 'Pacific/Auckland'], ['IN', 12, 'Asia/Kolkata'],
  ['PK', 6, 'Asia/Karachi'], ['AE', 4, 'Asia/Dubai'], ['SA', 3, 'Asia/Riyadh'], ['JP', 8, 'Asia/Tokyo'], ['KR', 5, 'Asia/Seoul'], ['SG', 4, 'Asia/Singapore'], ['ID', 4, 'Asia/Jakarta'],
  ['PH', 3, 'Asia/Manila'], ['NG', 5, 'Africa/Lagos'], ['ZA', 5, 'Africa/Johannesburg'], ['EG', 3, 'Africa/Cairo'], ['KE', 3, 'Africa/Nairobi'], ['MA', 2, 'Africa/Casablanca'],
];
const FIRST = ['Ava', 'Liam', 'Noah', 'Mia', 'Emma', 'Lucas', 'Sofia', 'Leo', 'Yuki', 'Aarav', 'Zara', 'Omar', 'Ines', 'Mateo', 'Nora', 'Elif', 'Hana', 'Kofi', 'Amara', 'Ivan', 'Priya', 'Chloe', 'Jonas', 'Lena', 'Ravi', 'Tariq', 'Mei', 'Diego', 'Fatima', 'Oscar'];
const LAST = ['Smith', 'Müller', 'Rossi', 'Garcia', 'Khan', 'Silva', 'Tanaka', 'Nguyen', 'Okafor', 'Patel', 'Novak', 'Dubois', 'Jensen', 'Costa', 'Ali', 'Kim'];
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;
const slugOf = (t: string) => t.toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');

async function main() {
  const pool = createPool();
  const redis = new Redis(env.REDIS_URL);
  const q = (text: string, args: unknown[] = []) => pool.query(text, args);
  await q(`DELETE FROM users WHERE email LIKE '%@demo.wehum'`);
  const [session] = (await q(`SELECT id FROM sessions WHERE status = 'live' AND is_sos = false ORDER BY random() LIMIT 1`)).rows as { id: string }[];
  const wheel = COUNTRIES.flatMap(([c, w, tz]) => Array.from({ length: w }, () => ({ c, tz })));
  const now = Date.now();
  const people: { id: string; country: string }[] = [];
  const today = new Date(now).toISOString().slice(0, 10);
  const todayByCountry = new Map<string, number>();
  let medsToday = 0, minsToday = 0;
  const practiced: string[] = [];

  for (let i = 0; i < 240; i++) {
    const { c, tz } = pick(wheel), first = pick(FIRST), last = pick(LAST), id = uuid();
    const username = `${slugOf(first)}${i % 3 ? '_' : '.'}${slugOf(last)}${i}`.slice(0, 20);
    await q(`INSERT INTO users (id, first_name, last_name, username, email, is_guest, country, timezone, created_at, last_active_at) VALUES ($1,$2,$3,$4,$5,false,$6,$7,$8,$9)`,
      [id, first, last, username, `${username}@demo.wehum`, c, tz, new Date(now - Math.random() * 60 * 86_400_000), new Date(now - Math.random() * 3 * 86_400_000)]);
    // 35% members (mostly trial, some paid, a few founding)
    if (Math.random() < 0.35) {
      const trial = Math.random() < 0.5;
      await q(`INSERT INTO entitlements (user_id, active, product_id, store, period_type, started_at, expires_at, will_renew, is_founding) VALUES ($1,true,$2,'app_store',$3,now() - interval '3 days',now() + interval '30 days',$4,$5)`,
        [id, Math.random() < 0.7 ? 'wehum_annual' : 'wehum_monthly', trial ? 'trial' : 'normal', !trial, !trial && Math.random() < 0.2]);
    }
    // a streak of recent days; the longer ago, the fewer people
    const run = Math.floor(Math.random() * 15);
    let total = 0, minutes = 0, last_at: Date | null = null, first_at: Date | null = null;
    for (let d = 0; d < 14; d++) {
      if (d >= run && d !== 0) continue;
      if (d === 0 && Math.random() < 0.45) continue;
      const mins = pick([5, 10, 10, 15, 20, 30]);
      const start = new Date(now - d * 86_400_000 - Math.random() * 6 * 3600_000);
      const ld = start.toISOString().slice(0, 10), kind = pick(['solo', 'solo', 'group', 'silence']);
      await q(`INSERT INTO meditations (id, user_id, session_id, kind, started_at, ended_at, duration_sec, counted, completed, local_date, country) VALUES ($1,$2,$3,$4,$5,$6,$7,true,true,$8,$9)`,
        [uuid(), id, kind === 'silence' ? null : session?.id ?? null, kind, start, new Date(start.getTime() + mins * 60_000), mins * 60, ld, c]);
      await q(`INSERT INTO user_daily_stats (user_id, local_date, minutes, meditations, group_count) VALUES ($1,$2,$3,1,$4) ON CONFLICT (user_id, local_date) DO UPDATE SET minutes = user_daily_stats.minutes + $3, meditations = user_daily_stats.meditations + 1`, [id, ld, mins, kind === 'group' ? 1 : 0]);
      total++; minutes += mins; first_at = start; last_at ??= start;
      if (ld === today) { medsToday++; minsToday += mins; practiced.push(id); todayByCountry.set(c, (todayByCountry.get(c) ?? 0) + 1); }
    }
    await q(`INSERT INTO user_stats (user_id, minutes_total, meditations_total, group_total, first_meditation_at, last_meditation_at) VALUES ($1,$2,$3,0,$4,$5)`, [id, minutes, total, first_at, last_at]);
    people.push({ id, country: c });
  }
  // today's counters the map and dashboard read
  await redis.set(K.medsToday(today), String(medsToday), 'EX', 172_800);
  await redis.set(K.minsToday(today), String(minsToday), 'EX', 172_800);
  for (const [c, n] of todayByCountry) await redis.hset(K.medsTodayCountry(today), c, String(n));
  await redis.expire(K.medsTodayCountry(today), 172_800);
  if (practiced.length) await redis.sadd(K.practiced(today), ...practiced);
  console.log(`demo audience: 240 people, ${medsToday} sits today in ${todayByCountry.size} countries`);

  if (process.argv.includes('--presence')) {
    const presence = new PresenceService(redis);
    const live = people.slice(0, 45).map((p, i) => ({ ...p, med: uuid(), mode: (i % 5 === 0 ? 'group' : i % 4 === 0 ? 'silence' : 'solo') as 'solo' | 'group' | 'silence' }));
    const beat = async () => { for (const p of live) { if (!(await presence.beat(p.med, p.id))) await presence.start({ meditationId: p.med, userId: p.id, sessionId: session?.id ?? null, country: p.country, mode: p.mode }); } };
    await beat();
    console.log(`${live.length} people sitting now (Ctrl-C to stop)`);
    setInterval(() => void beat(), 20_000);
    return;
  }
  await pool.end(); await redis.quit();
}
void main();
