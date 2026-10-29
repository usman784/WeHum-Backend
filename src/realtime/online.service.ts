import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { K, REDIS } from '../infra/redis';
import { HIDDEN_COUNTRY } from './presence.service';

/** Someone whose app has not touched the online set for this long is offline (a crashed pod cannot say goodbye). */
export const ONLINE_STALE_MS = 90_000;
/** Connected sockets touch their user this often. */
export const ONLINE_TOUCH_MS = 30_000;
const KEEP_SEC = 180;

// Each user has a set of open sockets (all pods) with their last touch: `on:s:{user}`. The user is online while that
// set has a fresh entry; `on:z` (user → last touch) and `on:m` (user → "CC|g" / "CC|a") are what the CMS reads.

// KEYS: 1 on:z  2 on:m  3 on:s:{user}   ARGV: 1 userId  2 meta  3 now  4 staleBefore  5 keepSec  6.. socket ids
// Returns 1 when the user just came online (had no fresh socket before), else 0.
const TOUCH = `
local old = redis.call('ZSCORE', KEYS[1], ARGV[1])
for i = 6, #ARGV do redis.call('ZADD', KEYS[3], ARGV[3], ARGV[i]) end
redis.call('EXPIRE', KEYS[3], ARGV[5])
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
if old and tonumber(old) >= tonumber(ARGV[4]) then return 0 end
return 1`;

// KEYS: 1 on:z  2 on:m  3 on:s:{user}   ARGV: 1 userId  2 socketId  3 staleBefore
// Drops one socket; the user goes offline only when no fresh socket is left anywhere. Returns 1 when they went offline.
const LEAVE = `
redis.call('ZREM', KEYS[3], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', '(' .. ARGV[3])
if redis.call('ZCARD', KEYS[3]) > 0 then return 0 end
redis.call('DEL', KEYS[3])
local was = redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return was`;

// KEYS: 1 on:z  2 on:m   ARGV: 1 staleBefore  2 limit
// Removes users nobody touched for 90 s, only if still stale at removal time. Returns {id, lastTouch, ...}.
const SWEEP = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[1], 'WITHSCORES', 'LIMIT', 0, tonumber(ARGV[2]))
local out = {}
for i = 1, #ids, 2 do
  redis.call('ZREM', KEYS[1], ids[i]); redis.call('HDEL', KEYS[2], ids[i]); redis.call('DEL', 'on:s:' .. ids[i])
  table.insert(out, ids[i]); table.insert(out, ids[i + 1])
end
return out`;

// KEYS: 1 on:m   ARGV: 1 userId  2 meta — only while the user is online.
const SET_META = `if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]) end return 1`;

// KEYS: 1 on:z  2 on:m   ARGV: 1 since — everyone online, counted by country and by guest/account in one step.
const COUNT = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], '+inf')
local per, out = {}, {}
local guests = 0
for _, id in ipairs(ids) do
  local m = redis.call('HGET', KEYS[2], id) or 'XX|a'
  local c, g = string.match(m, '^(%w+)|(%a)$')
  c = c or 'XX'
  if g == 'g' then guests = guests + 1 end
  per[c] = (per[c] or 0) + 1
end
for c, n in pairs(per) do table.insert(out, c); table.insert(out, n) end
return { #ids, guests, out }`;

export interface OnlineCounts { total: number; guests: number; countries: { c: string; n: number }[] }
export interface OnlineUser { id: string; isGuest: boolean; country: string | null }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const metaOf = (u: { isGuest: boolean; country: string | null }) => `${u.country ?? HIDDEN_COUNTRY}|${u.isGuest ? 'g' : 'a'}`;

/**
 * Who has the app open right now (CMS: green dot, "Online now", the map). Online = at least one connected `/live` socket
 * on any pod. One entry per user however many devices; countries are only ever ISO codes, `XX` when the user hides theirs.
 */
@Injectable()
export class OnlineService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Marks these sockets of the user as alive. `true` when the user just came online (the CMS should hear about it). */
  async touch(u: OnlineUser, socketIds: string[], now = Date.now()): Promise<boolean> {
    return (await this.redis.eval(TOUCH, 3, K.onlineZ, K.onlineMeta, K.onlineSockets(u.id), u.id, metaOf(u), now, now - ONLINE_STALE_MS, KEEP_SEC, ...socketIds)) === 1;
  }

  /** One socket closed. `true` when that was the user's last one anywhere: they are offline now. */
  async leave(userId: string, socketId: string, now = Date.now()): Promise<boolean> {
    return (await this.redis.eval(LEAVE, 3, K.onlineZ, K.onlineMeta, K.onlineSockets(userId), userId, socketId, now - ONLINE_STALE_MS)) === 1;
  }

  /** The user changed "show my country" (or linked an account): the map follows at once, not at the next touch. */
  async setMeta(u: OnlineUser): Promise<void> {
    await this.redis.eval(SET_META, 1, K.onlineMeta, u.id, metaOf(u));
  }

  /** Drops users whose apps vanished without closing (a pod died); returns them with their last touch. */
  async sweep(now = Date.now()): Promise<{ id: string; lastSeen: number }[]> {
    const flat = (await this.redis.eval(SWEEP, 2, K.onlineZ, K.onlineMeta, now - ONLINE_STALE_MS, 1000)) as string[];
    const out: { id: string; lastSeen: number }[] = [];
    for (let i = 0; i < flat.length; i += 2) out.push({ id: flat[i]!, lastSeen: Number(flat[i + 1]) });
    return out;
  }

  async isOnline(ids: string[], now = Date.now()): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const scores = await this.redis.zmscore(K.onlineZ, ...ids);
    return new Set(ids.filter((_, i) => scores[i] !== null && Number(scores[i]) >= now - ONLINE_STALE_MS));
  }

  async total(now = Date.now()): Promise<number> { return this.redis.zcount(K.onlineZ, now - ONLINE_STALE_MS, '+inf'); }

  /** Online user ids (most recent first, capped at `limit`): the Users screen's "Online now" filter. */
  async ids(limit = 5000, now = Date.now()): Promise<string[]> {
    return (await this.redis.zrevrangebyscore(K.onlineZ, '+inf', now - ONLINE_STALE_MS, 'LIMIT', 0, limit)).filter((id) => UUID.test(id));
  }

  /** Totals and countries (hidden countries count in the total but are never listed). O(online): the leader runs it every 5 s. */
  async counts(now = Date.now()): Promise<OnlineCounts> {
    const [total, guests, flat] = (await this.redis.eval(COUNT, 2, K.onlineZ, K.onlineMeta, now - ONLINE_STALE_MS)) as [number, number, (string | number)[]];
    const countries: { c: string; n: number }[] = [];
    for (let i = 0; i < flat.length; i += 2) if (flat[i] !== HIDDEN_COUNTRY) countries.push({ c: String(flat[i]), n: Number(flat[i + 1]) });
    countries.sort((a, b) => b.n - a.n || a.c.localeCompare(b.c));
    return { total, guests, countries };
  }
}
