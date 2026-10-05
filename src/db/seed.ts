/**
 * Seed: config defaults (spec §4.2), founding offer, automatic notifications, first CMS owner,
 * demo catalog (themes, Raphael, sessions, SoS, sound blocks, program, MOTD ±2 weeks, daily messages).
 * Idempotent — safe to run many times. Usage: npm run seed
 */
import argon2 from 'argon2';
import { sql } from 'drizzle-orm';
import { v7 as uuid } from 'uuid';
import { env } from '../config/env';
import { createDb, createPool } from './client';
import * as s from './schema';
import { CONFIG_DEFAULTS } from './config-defaults';


const THEMES: [string, string, string, string][] = [
  ['transcendent', 'Transcendent', 'Go beyond thought', 'sunrise'],
  ['loving-kindness', 'Loving Kindness', 'Warmth for yourself and others', 'heart'],
  ['mindfulness', 'Mindfulness', 'Be here, now', 'leaf'],
  ['breathing', 'Breathing', 'Calm through the breath', 'breath'],
  ['body-scan', 'Body Scan', 'Rest attention in the body', 'body'],
  ['sleep', 'Sleep', 'Let the day go', 'moon'],
  ['short-resets', 'Short Resets', 'A few minutes, anywhere', 'reset'],
  ['deep-meditation', 'Deep Meditation', 'Long, still sessions', 'mountain'],
];
const IMAGES = ['dawn', 'ocean', 'lake', 'forest', 'night', 'aurora', 'dunes', 'ember', 'stones', 'rain', 'clouds', 'seated'];
const SOS: [string, string, number][] = [
  ['Panic', 'Grounding with the senses', 4], ['Anxiety', 'A long, slow exhale', 6], ['Can’t stop thinking', 'Step back from the loop', 5],
  ['Low mood', 'Gentle, spacious awareness', 8], ['Anger', 'Release and soften', 5], ['Can’t sleep', 'Heavy body, slow descent', 8],
  ['Overwhelm', 'One thing at a time', 4], ['Grief', 'Steady holding', 7],
];
const AUTO = [
  ['daily_nudge', 'WeHum', 'Time to meditate, {firstName}. Today’s meditation with Raphael is ready.'],
  ['daily_message', 'Today’s message from Raphael', '{title}'],
  ['group_warning', 'Group meditation in 10 minutes', '{title} starts at {time}. {waiting} people are already in the lobby.'],
  ['trial_ending', 'Your trial ends in 2 days', 'Keep meditating with everyone. Manage your membership anytime.'],
];

const slug = (t: string) => t.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const day = (d: Date) => d.toISOString().slice(0, 10); // UTC dates (the MOTD / group time are UTC)

export async function seed(url?: string) {
  const pool = createPool(url);
  const db = createDb(pool);
  try {
    for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
      await db.insert(s.appConfig).values({ key, value }).onConflictDoNothing();
    }
    await db.insert(s.offers).values({ id: 'founding', cap: 1000, productId: 'wehum_annual_founding' }).onConflictDoNothing();
    for (const [key, title, body] of AUTO) await db.insert(s.autoNotifications).values({ key: key!, title: title!, body: body! }).onConflictDoNothing();

    await db.insert(s.adminUsers).values({
      id: uuid(), email: env.SEED_OWNER_EMAIL, name: 'Owner', role: 'owner', status: 'active',
      passwordHash: await argon2.hash(env.SEED_OWNER_PASSWORD, { type: argon2.argon2id }),
    }).onConflictDoNothing();

    const already = await db.select({ n: sql<number>`count(*)::int` }).from(s.themes);
    if ((already[0]?.n ?? 0) > 0) { console.log('catalog already seeded'); return; }

    const media = async (kind: string, name: string, durationSec?: number) => {
      const id = uuid();
      await db.insert(s.mediaAssets).values({
        id, kind, storageKey: `seed/${kind}/${slug(name)}-${id.slice(-6)}.${kind === 'image' ? 'jpg' : 'm4a'}`,
        mime: kind === 'image' ? 'image/jpeg' : 'audio/mp4', durationSec, status: 'ready', loudnessLufs: kind === 'audio' ? '-16.10' : null,
      });
      return id;
    };

    const themeIds: string[] = [];
    for (const [i, [sl, name, sub, icon]] of THEMES.entries()) {
      const id = uuid(); themeIds.push(id);
      await db.insert(s.themes).values({ id, slug: sl, name, subtitle: sub, description: `${name}: ${sub.toLowerCase()}.`, iconKey: icon, order: i });
    }
    const raphael = uuid();
    await db.insert(s.teachers).values({
      id: raphael, name: 'Raphael Reiter', role: 'Meditation teacher', specialty: 'Transcendent & breath meditation',
      bio: 'Raphael has taught meditation to hundreds of thousands of people through his online library.',
      quote: 'You never meditate alone.', canLeadGroup: true, youtubeUrl: 'https://www.youtube.com/@raphaelreiter',
    });

    const titles = ['Steady Under Pressure', 'Evening Settle', 'Open Heart', 'Quiet Mind', 'Rooted', 'Into Stillness', 'Soft Landing', 'Clear Sky', 'Morning Light', 'Ocean Breath', 'Letting Go', 'Home in the Body'];
    const sessionIds: string[] = [];
    let n = 0;
    for (const [ti, themeId] of themeIds.entries()) {
      for (let k = 0; k < 3; k++, n++) {
        const title = `${titles[n % titles.length]}${n >= titles.length ? ` ${Math.floor(n / titles.length) + 1}` : ''}`;
        const dur = [10, 20, 30][k]! * 60;
        const id = uuid(); sessionIds.push(id);
        await db.insert(s.sessions).values({
          id, slug: slug(title), title, description: `A guided ${THEMES[ti]![1].toLowerCase()} meditation with Raphael.`,
          type: k === 2 && ti % 3 === 0 ? 'video' : 'audio', access: 'premium', themeId, teacherId: raphael, tags: [THEMES[ti]![0]],
          durationSec: dur, mediaId: await media('audio', title, dur), coverUrl: `img/${IMAGES[n % IMAGES.length]}.jpg`, status: 'live', publishAt: new Date(),
        });
      }
    }
    // Free for you (online library, YouTube-hosted — never labelled "YouTube" in the app)
    for (const [i, title] of ['Ten Minutes of Calm', 'Breath of Relief', 'Morning Reset', 'Body at Ease'].entries()) {
      await db.insert(s.sessions).values({
        id: uuid(), slug: slug(title), title, type: 'youtube', access: 'free', themeId: themeIds[i * 2], teacherId: raphael,
        durationSec: (10 + i * 5) * 60, youtubeId: `seedYT0000${i}`, coverUrl: `img/${IMAGES[(i + 3) % IMAGES.length]}.jpg`, status: 'live', publishAt: new Date(),
      });
    }
    for (const [i, [feeling, sub, min]] of SOS.entries()) {
      await db.insert(s.sessions).values({
        id: uuid(), slug: `sos-${slug(feeling)}`, title: feeling, type: 'audio', access: 'premium', teacherId: raphael, durationSec: min * 60,
        mediaId: await media('audio', `sos ${feeling}`, min * 60), isSos: true, sosFeeling: feeling, sosSubtitle: sub, sosOrder: i, status: 'live', publishAt: new Date(),
      });
    }
    const blocks: [typeof s.blockKind.enumValues[number], string, number, boolean][] = [
      ['opening', 'Arrive (Raphael)', 90, false], ['opening', 'Settle the breath', 120, false],
      ['core', 'Breath focus', 300, true], ['core', 'Body awareness', 300, true],
      ['closing', 'Return gently', 60, false], ['closing', 'Gratitude close', 90, false],
      ['sound', 'Rain', 600, true], ['sound', 'Ocean', 600, true], ['sound', 'Forest', 600, true],
      ['bell', 'Tibetan bowl', 8, false], ['bell', 'Soft chime', 5, false],
      ['loop', 'OM loop', 12, true], ['loop', 'Mantra loop', 20, true],
    ];
    for (const [i, [kind, name, dur, loop]] of blocks.entries()) {
      await db.insert(s.soundBlocks).values({ id: uuid(), kind, name, durationSec: dur, loopable: loop, mediaId: await media('audio', name, dur), order: i, loudnessLufs: '-16.20' });
    }
    const program = uuid();
    await db.insert(s.programs).values({ id: program, slug: '7-days-of-calm', title: '7 Days of Calm', description: 'A gentle week to build the habit.', access: 'premium', status: 'live', coverUrl: 'img/lake.jpg' });
    for (let d = 1; d <= 7; d++) await db.insert(s.programDays).values({ programId: program, day: d, sessionId: sessionIds[(d * 2) % sessionIds.length]! });

    const today = new Date();
    for (let d = -3; d <= 10; d++) {
      const date = day(new Date(today.getTime() + d * 86_400_000));
      await db.insert(s.motdDays).values({ date, sessionId: sessionIds[(d + 3) % sessionIds.length]!, practicedToday: d < 0 ? 900 + d * 40 : 0 });
      for (const len of [10, 30, 45]) await db.insert(s.motdVariants).values({ date, lengthMin: len, mediaId: await media('audio', `motd ${date} ${len}`, len * 60) });
    }
    for (let d = -6; d <= 0; d++) {
      await db.insert(s.dailyMessages).values({
        date: day(new Date(today.getTime() + d * 86_400_000)), type: d % 3 === 0 ? 'audio' : 'text', title: ['On patience', 'Small steps', 'Being kind to yourself', 'The quiet in between', 'Starting again', 'You are not alone', 'Rest is practice'][d + 6]!,
        text: 'A short reflection from Raphael for today.', themeTag: THEMES[(d + 6) % THEMES.length]![1], status: 'live',
      });
    }
    console.log('seed complete');
  } finally {
    await pool.end();
  }
}

if (require.main === module) seed().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
