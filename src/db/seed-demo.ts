/**
 * Demo data for a showcase server (not for production): people, members, payments, meditations, posts, gratitude,
 * push history, team, challenges and 90 days of analytics — what the CMS mock mode shows, in a real database.
 * Runs after `seed` (needs the catalog and the owner). Does nothing when demo data is already there.
 *   node dist/db/seed-demo.js        (in the production image)
 *   npx tsx src/db/seed-demo.ts      (locally)
 */
import { createPool } from './client';

const NAMES = [
  'Marcus', 'Elena', 'Aiko', 'Lukas', 'Sam', 'Hannah', 'David', 'Priya', 'Nina', 'Tom', 'Sofia', 'Jonas', 'Mia', 'Omar', 'Lea', 'Ravi',
  'Clara', 'Ben', 'Yuki', 'Ana', 'Felix', 'Zara', 'Leon', 'Ines', 'Noah', 'Emma', 'Ali', 'Lena', 'Max', 'Sara', 'Paul', 'Amira',
  'Jan', 'Maya', 'Luca', 'Ella', 'Finn', 'Nora', 'Ivan', 'Rosa', 'Kai', 'Lina', 'Theo', 'Ada', 'Hugo', 'Iris', 'Elias', 'Vera',
  'Oskar', 'Lia', 'Emil', 'Alma', 'Milo', 'Nele', 'Anton', 'Juna', 'Karl', 'Ida', 'Otto', 'Mila',
];
const COUNTRIES = ['DE', 'AT', 'CH', 'US', 'GB', 'JP', 'IN', 'PK', 'BR', 'FR', 'CA', 'AU'];
const TZ: Record<string, string> = { DE: 'Europe/Berlin', AT: 'Europe/Vienna', CH: 'Europe/Zurich', US: 'America/New_York', GB: 'Europe/London', JP: 'Asia/Tokyo', IN: 'Asia/Kolkata', PK: 'Asia/Karachi', BR: 'America/Sao_Paulo', FR: 'Europe/Paris', CA: 'America/Toronto', AU: 'Australia/Sydney' };

export async function seedDemo(url?: string) {
  const pool = createPool(url);
  const q = (sql: string, args: unknown[] = []) => pool.query(sql, args);
  try {
    if ((await q(`SELECT 1 FROM users WHERE email LIKE '%@demo.wehum.app' LIMIT 1`)).rowCount) { console.log('demo data already there'); return; }
    const owner = (await q(`SELECT id, password_hash FROM admin_users WHERE role = 'owner' ORDER BY created_at LIMIT 1`)).rows[0];
    if (!owner) throw new Error('run the seed first (no owner)');
    const sessions = (await q(`SELECT id FROM sessions WHERE status = 'live' AND NOT is_sos ORDER BY slug`)).rows.map((r) => r.id as string);
    if (!sessions.length) throw new Error('run the seed first (no sessions)');

    // ── people: 60 users over the last 60 days, a third of them guests
    const users: { id: string; name: string; country: string; guest: boolean }[] = [];
    for (let i = 0; i < NAMES.length; i++) {
      const name = NAMES[i]!, country = COUNTRIES[i % COUNTRIES.length]!, guest = i % 3 === 2;
      const r = await q(
        `INSERT INTO users (id, first_name, email, is_guest, country, timezone, created_at, last_active_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now() - make_interval(days => $6), now() - make_interval(mins => $7)) RETURNING id`,
        [name, guest ? null : `${name.toLowerCase()}.${i}@demo.wehum.app`, guest, country, TZ[country], 60 - i, (i * 37) % 2000],
      );
      const id = r.rows[0].id as string;
      users.push({ id, name, country, guest });
      await q(`INSERT INTO user_stats (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
      await q(`INSERT INTO auth_identities (id, user_id, provider, provider_uid) VALUES (gen_random_uuid(), $1, 'device', $2)`, [id, `demo-install-${i}`]);
      if (!guest) await q(`INSERT INTO auth_identities (id, user_id, provider, provider_uid) VALUES (gen_random_uuid(), $1, $2, $3)`, [id, i % 2 ? 'apple' : 'google', `demo-${i}`]);
      await q(`INSERT INTO devices (id, user_id, install_id, platform, push_token, app_version, model) VALUES (gen_random_uuid(), $1, $2, $3, $4, '1.0.0', $5)`,
        [id, `demo-install-${i}`, i % 4 ? 'ios' : 'android', `demo-push-token-${i}`, i % 4 ? 'iPhone 15' : 'Pixel 7']);
    }

    // ── membership: founding, annual, monthly, trials, cancelled, a payment problem
    const plan = (i: number) => (i < 22 ? 'founding' : i < 26 ? 'annual' : i < 34 ? 'monthly' : i < 40 ? 'trial' : i < 43 ? 'cancelled' : i < 45 ? 'problem' : null);
    let founding = 0;
    for (let i = 0; i < users.length; i++) {
      const p = plan(i);
      if (!p) continue;
      const u = users[i]!;
      const product = p === 'monthly' || p === 'problem' ? 'wehum_monthly' : p === 'annual' ? 'wehum_annual' : 'wehum_annual_founding';
      const period = p === 'trial' ? 'trial' : 'normal';
      const isFounding = product === 'wehum_annual_founding' && p !== 'trial';
      if (isFounding) founding++;
      const started = `now() - make_interval(days => ${(i * 3) % 50 + 1})`;
      const expires = p === 'trial' ? `now() + make_interval(days => ${(i % 6) + 1})` : p === 'monthly' || p === 'problem' ? `now() + make_interval(days => ${(i * 5) % 28 + 2})` : `now() + make_interval(days => ${300 + i})`;
      await q(
        `INSERT INTO entitlements (user_id, active, product_id, period_type, store, started_at, expires_at, will_renew, billing_issue, is_founding)
         VALUES ($1, true, $2, $3, $4, ${started}, ${expires}, $5, $6, $7)`,
        [u.id, product, period, i % 4 ? 'app_store' : 'play_store', p !== 'cancelled', p === 'problem', isFounding],
      );
      const price = product === 'wehum_monthly' ? 9.99 : product === 'wehum_annual' ? 79 : 59;
      const events: [string, string, number | null][] = p === 'trial' ? [['INITIAL_PURCHASE', 'trial', 0]] : [['INITIAL_PURCHASE', 'normal', price]];
      if (p === 'cancelled') events.push(['CANCELLATION', 'normal', null]);
      if (p === 'problem') events.push(['BILLING_ISSUE', 'normal', null]);
      for (const [k, [type, pt, usd]] of events.entries())
        await q(
          `INSERT INTO subscription_events (id, user_id, type, product_id, period_type, price_usd, currency, store, event_at, processed_at, raw)
           VALUES ($1, $2, $3, $4, $5, $6, 'USD', 'APP_STORE', ${started} + make_interval(hours => $7), now(), '{}'::jsonb)`,
          [`demo-${i}-${k}`, u.id, type, product, pt, usd, k * 30],
        );
    }
    await q(`UPDATE offers SET taken = $1 + 390 WHERE id = 'founding'`, [founding]); // the counter as if earlier members existed too

    // ── meditations over the last 14 days (counted), and the stats they make
    for (let i = 0; i < users.length; i++) {
      const u = users[i]!, days = (i * 7) % 14 + 1;
      for (let d = 0; d < days; d++) {
        const min = [10, 15, 20, 30, 45][(i + d) % 5]!;
        const kind = (i + d) % 4 === 0 ? 'group' : (i + d) % 3 === 0 ? 'motd' : 'solo';
        await q(
          `INSERT INTO meditations (id, user_id, session_id, kind, started_at, ended_at, duration_sec, counted, completed, local_date, country)
           VALUES (gen_random_uuid(), $1, $2, $3, now() - make_interval(days => $4, hours => $5), now() - make_interval(days => $4, hours => $5) + make_interval(mins => $6), $6 * 60, true, true,
                   (now() - make_interval(days => $4))::date, $7)`,
          [u.id, sessions[(i + d) % sessions.length], kind, d, (i % 12) + 1, min, u.country],
        );
      }
    }
    await q(`INSERT INTO user_daily_stats (user_id, local_date, minutes, meditations, group_count)
             SELECT user_id, local_date, sum(duration_sec) / 60, count(*), count(*) FILTER (WHERE kind = 'group') FROM meditations GROUP BY 1, 2
             ON CONFLICT (user_id, local_date) DO NOTHING`);
    await q(`UPDATE user_stats s SET minutes_total = m.mins, meditations_total = m.n, group_total = m.g, first_meditation_at = m.first, last_meditation_at = m.last
             FROM (SELECT user_id, sum(duration_sec) / 60 AS mins, count(*) AS n, count(*) FILTER (WHERE kind = 'group') AS g, min(started_at) AS first, max(ended_at) AS last FROM meditations GROUP BY 1) m
             WHERE m.user_id = s.user_id`);

    // ── dedications: visible ones, auto-flagged, reported and hidden, one with crisis words
    const posts: [number, string, string, string[], number][] = [
      [0, 'Dedicated to anyone navigating tough news today.', 'visible', [], 0],
      [1, 'For my brother before his exam.', 'visible', [], 0],
      [3, 'For hospital night shift workers finding quiet before dawn.', 'visible', [], 0],
      [4, 'For my mother, who taught me to breathe slowly.', 'visible', [], 0],
      [6, 'For everyone who feels alone tonight.', 'visible', [], 0],
      [7, 'For my team before the product launch. Steady hands, steady minds.', 'visible', [], 0],
      [9, 'This damn week is finally over, for all of you.', 'flagged', ['profanity'], 0],
      [10, 'Join my course, DM me for the breathwork link.', 'hidden', [], 3],
      [12, 'Off-topic rant about my neighbours parking.', 'flagged', [], 1],
      [13, 'For myself. I don’t know how much longer I can keep going like this.', 'flagged', ['crisis'], 0],
    ];
    for (const [k, [i, text, status, flags, reportsN]] of posts.entries()) {
      const u = users[i]!;
      const m = (await q(`SELECT id, session_id FROM meditations WHERE user_id = $1 ORDER BY started_at DESC LIMIT 1`, [u.id])).rows[0];
      if (!m) continue;
      const d = await q(
        `INSERT INTO dedications (id, session_id, user_id, meditation_id, first_name, country, text, status, auto_flags, report_count, holding_count, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() - make_interval(mins => $11)) RETURNING id`,
        [m.session_id, u.id, m.id, u.name, u.country, text, status, flags, reportsN, status === 'visible' ? 40 + k * 113 : 0, 12 + k * 41],
      );
      for (let r = 0; r < reportsN; r++) await q(`INSERT INTO reports (id, dedication_id, reporter_id, reason) VALUES (gen_random_uuid(), $1, $2, $3)`, [d.rows[0].id, users[20 + r]!.id, r % 2 ? 'other' : 'spam']);
    }

    // ── gratitude feed
    const grat: [number, string, string, string, string[]][] = [
      [15, 'gratitude', 'The first cold morning and a warm cup of tea.', 'visible', []],
      [16, 'gratitude', 'My daughter laughing at breakfast.', 'visible', []],
      [17, 'gratitude', 'Ten quiet minutes before the kids woke up.', 'visible', []],
      [18, 'affirmation', 'I am allowed to rest.', 'visible', []],
      [19, 'love', 'Sending love to everyone in Lahore tonight.', 'visible', []],
      [21, 'gratitude', 'This stupid traffic made me late but I still meditated.', 'flagged', ['profanity']],
    ];
    for (const [k, [i, kind, text, status, flags]] of grat.entries()) {
      const u = users[i]!;
      await q(`INSERT INTO gratitude_posts (id, user_id, kind, first_name, country, text, status, auto_flags, created_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, now() - make_interval(mins => $8))`,
        [u.id, kind, u.name, u.country, text, status, flags, 30 + k * 95]);
    }

    // ── push notifications: sent (with numbers), scheduled, draft
    await q(`INSERT INTO notifications (id, title, body, audience, send_mode, send_at, status, targeted, delivered, opened, failed, created_by, created_at) VALUES
      (gen_random_uuid(), 'New: 7-Day Autonomic Reset', 'Seven days, ten minutes a day. Start today.', 'all', 'now', now() - interval '16 days', 'sent', 14800, 14210, 2558, 12, $1, now() - interval '16 days'),
      (gen_random_uuid(), 'Midday Coherence is now daily', 'Join everyone at noon for the group meditation.', 'members', 'now', now() - interval '27 days', 'sent', 2100, 2020, 485, 3, $1, now() - interval '27 days'),
      (gen_random_uuid(), 'Welcome to WeHum, Founding members', 'Thank you for being here from the start.', 'founding', 'now', now() - interval '36 days', 'sent', 1000, 980, 402, 0, $1, now() - interval '36 days'),
      (gen_random_uuid(), 'The 21-Day Resilience Arc starts Monday', 'Twenty minutes a day with Raphael.', 'all', 'scheduled', now() + interval '3 days', 'scheduled', 14820, 0, 0, 0, $1, now() - interval '1 hour'),
      (gen_random_uuid(), 'Retreat in Vienna (draft)', 'A weekend of silence in the Alps.', 'country', 'now', NULL, 'draft', 0, 0, 0, 0, $1, now() - interval '10 minutes')`, [owner.id]);
    await q(`UPDATE notifications SET countries = '{AT}' WHERE audience = 'country' AND countries = '{}'`);

    // ── team (same password as the owner, so the demo can sign in as each role)
    await q(`INSERT INTO admin_users (id, email, name, role, status, password_hash) VALUES
      (gen_random_uuid(), 'editor@wehum.app', 'Lena Fischer', 'editor', 'active', $1),
      (gen_random_uuid(), 'moderator@wehum.app', 'Jonas Weber', 'moderator', 'active', $1),
      (gen_random_uuid(), 'admin@wehum.app', 'Usman', 'admin', 'active', $1),
      (gen_random_uuid(), 'invited@wehum.app', 'Mia Keller', 'editor', 'invited', NULL)
      ON CONFLICT (email) DO NOTHING`, [owner.password_hash]);

    // ── challenges with people in them
    const ch = await q(`INSERT INTO challenges (id, name, days, counts, min_minutes, members_only, status) VALUES
      (gen_random_uuid(), '7 days of calm', 7, 'any', 3, true, 'live'),
      (gen_random_uuid(), '21 days to a habit', 21, 'any', 3, true, 'live'),
      (gen_random_uuid(), 'Sleep week', 7, 'sleep', 3, true, 'live'),
      (gen_random_uuid(), 'New year, 30 days', 30, 'any', 3, true, 'draft') RETURNING id, days`);
    for (let i = 0; i < 30; i++) {
      const c = ch.rows[i % 3]!;
      const done = Math.min(c.days, (i * 3) % (c.days + 3));
      await q(`INSERT INTO challenge_participants (challenge_id, user_id, joined_at, completed_days, finished_at) VALUES ($1, $2, now() - interval '20 days', $3, $4) ON CONFLICT DO NOTHING`,
        [c.id, users[i]!.id, done, done >= c.days ? new Date() : null]);
    }

    // ── 90 days of analytics (the nightly roll-up's table)
    await q(`INSERT INTO daily_aggregates (date, meditations, minutes, group_meditations, active_users, new_users, new_trials, new_paid, cancellations, revenue_usd, peak_live, countries, by_theme, funnel)
      SELECT d::date,
             2400 + (extract(doy FROM d)::int * 137) % 900 + (90 - g) * 6,
             (2400 + (extract(doy FROM d)::int * 137) % 900) * 13,
             300 + (extract(doy FROM d)::int * 53) % 200,
             1100 + (extract(doy FROM d)::int * 31) % 400,
             35 + (extract(doy FROM d)::int * 7) % 30, 8 + g % 6, 4 + g % 5, g % 3,
             (40 + (g % 9) * 11)::numeric, 180 + (g * 17) % 260,
             '{"DE": 420, "US": 380, "GB": 210, "AT": 140, "CH": 90, "JP": 70, "IN": 60, "PK": 40}'::jsonb,
             '{"Sleep": 15800, "Breathing": 11200, "Short Resets": 8000, "Mindfulness": 6000, "Transcendent": 4500, "Focus": 3100}'::jsonb,
             jsonb_build_object('installed', 70 + g % 20, 'introDone', 56 + g % 15, 'firstMeditation', 48 + g % 12, 'continuedFree', 43 + g % 10, 'trialStarted', 10 + g % 4, 'savedAccount', 25 + g % 8, 'paid', 3 + g % 3)
      FROM generate_series(1, 90) g, LATERAL (SELECT (current_date - g) AS d) x
      ON CONFLICT (date) DO NOTHING`);

    console.log(`demo data: ${users.length} people, ${founding} founding members, ${posts.length} dedications, ${grat.length} gratitude posts, 5 notifications, 3 team members, 4 challenges, 90 days of analytics`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) seedDemo().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
