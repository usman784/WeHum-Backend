import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type Redis from 'ioredis';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REDIS } from '../src/infra/redis';
import { GroupService, SLOT, globalSlot, isGlobalSlot, slotDate } from '../src/modules/today/group.service';
import { bootApp, clearRates, http, member, resetTestDb } from './helpers';

let app: NestFastifyApplication;
let db: Client;
let redis: Redis;
const h = () => http(app);
const q = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows;
const dropCaches = async () => { const ks = [...(await redis.keys('today:*')), ...(await redis.keys('motd:*')), ...(await redis.keys('config:*'))]; if (ks.length) await redis.del(...ks); };
const setGroup = async (patch: Record<string, unknown>) => { await q(`UPDATE app_config SET value = value || $1::jsonb, version = version + 1 WHERE key='group'`, [JSON.stringify(patch)]); await dropCaches(); };
const at = (iso: string) => Date.parse(iso);

const EVERY_4H = { cadence: 'hourly', hourly: { fromHourUtc: 0, toHourUtc: 23, lengthMin: 30, stepHours: 4 } };
const SUNDAY_16 = { global: { enabled: true, weekday: 0, startUtc: '16:00', lengthMin: 30, lobbyOpenMin: 30, reminderMin: 60, title: 'Global meditation' } };

beforeAll(async () => {
  await resetTestDb();
  app = await bootApp();
  redis = app.get(REDIS);
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
});
beforeEach(async () => { await clearRates(); await dropCaches(); });
afterAll(async () => { await db?.end(); await app?.close(); });

describe('slot ids', () => {
  it('a global sit is `G` + its date; daily and hourly ids are unchanged', () => {
    expect(SLOT.test('2026-10-25')).toBe(true);
    expect(SLOT.test('2026-10-25T08')).toBe(true);
    expect(SLOT.test('G2026-10-25')).toBe(true);
    expect(SLOT.test('G2026-10-25T08')).toBe(false); // a global sit has no hour: its time is in the settings
    expect(isGlobalSlot('G2026-10-25')).toBe(true);
    expect(isGlobalSlot('2026-10-25T08')).toBe(false);
    expect(slotDate('G2026-10-25')).toBe('2026-10-25');
    expect(globalSlot('2026-10-25')).toBe('G2026-10-25');
  });
});

describe('group meditation: every 4 hours', () => {
  it('sits start at 00, 04, 08, 12, 16 and 20 UTC, and only the coming ones are watched', async () => {
    await setGroup(EVERY_4H);
    const g = app.get(GroupService);
    const now = at('2026-10-21T09:30:00Z'); // the 08:00 sit (30 min) is over
    const next = await g.next(now);
    expect(next).toMatchObject({ date: '2026-10-21T12', startsAt: '2026-10-21T12:00:00.000Z', lengthMin: 30, kind: 'group' });
    // the scheduler only watches what is close (lobby and reminder are minutes before a sit), so at 10:30 it watches 12:00, not 16:00
    const slots = (await g.slots(at('2026-10-21T10:30:00Z'))).filter((s) => !isGlobalSlot(s));
    expect(slots).toContain('2026-10-21T12');
    for (const no of ['2026-10-21T10', '2026-10-21T11', '2026-10-21T13', '2026-10-21T16']) expect(slots).not.toContain(no);
  });

  it('without a step it stays hourly, as before', async () => {
    await setGroup({ cadence: 'hourly', hourly: { fromHourUtc: 6, toHourUtc: 22, lengthMin: 10 } });
    const next = await app.get(GroupService).next(at('2026-10-21T09:30:00Z'));
    expect(next.date).toBe('2026-10-21T10');
  });

  it('the last sit of the day is followed by the first of the next', async () => {
    await setGroup(EVERY_4H);
    const next = await app.get(GroupService).next(at('2026-10-21T20:45:00Z'));
    expect(next.date).toBe('2026-10-22T00');
  });
});

describe('global meditation: once a week, all together', () => {
  it('is the next Sunday at the set time, with its own lobby window and length', async () => {
    await setGroup({ ...EVERY_4H, ...SUNDAY_16 });
    const g = app.get(GroupService);
    const wed = await g.nextGlobal(at('2026-10-21T09:30:00Z'));
    expect(wed).toMatchObject({ date: 'G2026-10-25', kind: 'global', startsAt: '2026-10-25T16:00:00.000Z', lengthMin: 30, state: 'scheduled', title: 'Global meditation' });
    expect(wed!.lobbyOpensAt).toBe('2026-10-25T15:30:00.000Z');
    expect(wed!.reminderMin).toBe(60);
    expect((await g.nextGlobal(at('2026-10-25T15:45:00Z')))!.state).toBe('lobby');
    expect((await g.nextGlobal(at('2026-10-25T16:10:00Z')))!.state).toBe('live');
    expect((await g.nextGlobal(at('2026-10-25T17:00:00Z')))!.date).toBe('G2026-11-01'); // done: the next one is a week later
  });

  it('can be moved to another day and time in the settings, and switched off', async () => {
    await setGroup({ global: { ...SUNDAY_16.global, weekday: 3, startUtc: '18:30', lengthMin: 45 } });
    const g = app.get(GroupService);
    expect(await g.nextGlobal(at('2026-10-21T09:30:00Z'))).toMatchObject({ date: 'G2026-10-21', startsAt: '2026-10-21T18:30:00.000Z', lengthMin: 45 }); // Wednesday
    await setGroup({ global: { ...SUNDAY_16.global, enabled: false } });
    expect(await g.nextGlobal(at('2026-10-21T09:30:00Z'))).toBeNull();
    expect((await g.slots(at('2026-10-21T09:30:00Z'))).some(isGlobalSlot)).toBe(false);
  });

  it('is watched by the scheduler (lobby, start, reminder) together with the group sits', async () => {
    await setGroup({ ...EVERY_4H, ...SUNDAY_16 });
    const slots = await app.get(GroupService).slots(at('2026-10-21T09:30:00Z'));
    expect(slots.filter(isGlobalSlot)).toEqual(['G2026-10-25']);
  });
});

describe('API', () => {
  it('/v1/today carries the next group sit and the next global sit as two different things; /v1/group/next?kind=global is the global lobby', async () => {
    await setGroup({ ...EVERY_4H, ...SUNDAY_16 });
    const m = await member(app, db);
    const t = await h().get('/v1/today', { token: m.accessToken });
    expect(t.status).toBe(200);
    expect(t.body.data.group).toMatchObject({ kind: 'group' });
    expect(t.body.data.group.date).toMatch(/T\d\d$/); // an hourly slot
    expect(t.body.data.global).toMatchObject({ kind: 'global', lengthMin: 30, title: 'Global meditation' });
    expect(t.body.data.global.date).toMatch(/^G\d{4}-\d{2}-\d{2}$/);
    const next = await h().get('/v1/group/next?kind=global', { token: m.accessToken });
    expect(next.status).toBe(200);
    expect(next.body.data).toMatchObject({ kind: 'global', date: t.body.data.global.date });
    const grp = await h().get('/v1/group/next', { token: m.accessToken });
    expect(grp.body.data.kind).toBe('group');
  });

  it('off: /v1/today has no global sit', async () => {
    await setGroup({ global: { ...SUNDAY_16.global, enabled: false } });
    const m = await member(app, db);
    const t = await h().get('/v1/today', { token: m.accessToken });
    expect(t.body.data.global).toBeNull();
  });
});
