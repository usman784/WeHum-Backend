import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { K, REDIS } from '../infra/redis';

/** A presence entry that has not been refreshed for this long is gone (spec §7.4). */
export const PRESENCE_STALE_MS = 90_000;
/** Redis keeps the data a bit longer than "stale", so the sweep can still read it when it cleans up. */
const KEEP_SEC = 180;

/** `XX` = counted in the total, but the user's country is not shown (privacy setting "show my country" off). */
export const HIDDEN_COUNTRY = 'XX';

// KEYS: 1 pz:m:{id}  2 pz:z  3 pz:u:{user}  4 pz:agg:country  5 pz:agg:session
// ARGV: 1 id  2 userId  3 sessionId  4 country  5 mode  6 startedAt  7 now  8 keepSec
const START = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  if redis.call('HGET', KEYS[1], 'userId') ~= ARGV[2] then return -1 end
  redis.call('ZADD', KEYS[2], ARGV[7], ARGV[1]); redis.call('EXPIRE', KEYS[1], ARGV[8]); redis.call('EXPIRE', KEYS[3], ARGV[8])
  return 0
end
redis.call('HSET', KEYS[1], 'userId', ARGV[2], 'sessionId', ARGV[3], 'country', ARGV[4], 'mode', ARGV[5], 'startedAt', ARGV[6])
redis.call('EXPIRE', KEYS[1], ARGV[8])
redis.call('ZADD', KEYS[2], ARGV[7], ARGV[1])
local first = redis.call('HLEN', KEYS[3]) == 0
local known = false
if ARGV[3] ~= '' then
  for _, v in ipairs(redis.call('HVALS', KEYS[3])) do if v == ARGV[3] then known = true break end end
end
redis.call('HSET', KEYS[3], ARGV[1], ARGV[3])
redis.call('EXPIRE', KEYS[3], ARGV[8])
if first then redis.call('HINCRBY', KEYS[4], ARGV[4], 1) end
if ARGV[3] ~= '' and not known then
  redis.call('HINCRBY', KEYS[5], ARGV[3], 1)
  redis.call('HINCRBY', 'pz:sc:' .. ARGV[3], ARGV[4], 1)
end
return 1`;

// ARGV: 1 id  2 userId ('' = not checked)  3 minus-infinity guard unused
const STOP = `
local m = redis.call('HGETALL', KEYS[1])
if #m == 0 then redis.call('ZREM', KEYS[2], ARGV[1]); return 0 end
local h = {}
for i = 1, #m, 2 do h[m[i]] = m[i + 1] end
if ARGV[2] ~= '' and h.userId ~= ARGV[2] then return -1 end
redis.call('DEL', KEYS[1]); redis.call('ZREM', KEYS[2], ARGV[1]); redis.call('HDEL', KEYS[3], ARGV[1])
local function dec(key, field)
  local n = redis.call('HINCRBY', key, field, -1)
  if n <= 0 then redis.call('HDEL', key, field) end
end
if redis.call('HLEN', KEYS[3]) == 0 then redis.call('DEL', KEYS[3]); dec(KEYS[4], h.country) end
if h.sessionId ~= '' then
  local still = false
  for _, v in ipairs(redis.call('HVALS', KEYS[3])) do if v == h.sessionId then still = true break end end
  if not still then dec(KEYS[5], h.sessionId); dec('pz:sc:' .. h.sessionId, h.country) end
end
return 1`;

// ARGV: 1 id  2 userId  3 now  4 keepSec
const BEAT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if redis.call('HGET', KEYS[1], 'userId') ~= ARGV[2] then return -1 end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1]); redis.call('EXPIRE', KEYS[1], ARGV[4]); redis.call('EXPIRE', KEYS[3], ARGV[4])
return 1`;

// KEYS: 1 pz:z  2 pz:agg:country  3 pz:agg:session — rebuilds the counters from the active entries in one atomic step,
// so starts and stops that happen meanwhile can neither be lost nor counted twice.
const RECONCILE = `
local ids = redis.call('ZRANGE', KEYS[1], 0, -1)
local userSeen, perCountry, sessSeen, sessCount, sessCountry = {}, {}, {}, {}, {}
local users, sessions = 0, 0
for _, id in ipairs(ids) do
  local m = redis.call('HMGET', 'pz:m:' .. id, 'userId', 'sessionId', 'country')
  local u, s, c = m[1], m[2], m[3]
  if u and c then
    if not userSeen[u] then userSeen[u] = true; users = users + 1; perCountry[c] = (perCountry[c] or 0) + 1 end
    if s and s ~= '' and not sessSeen[s .. '|' .. u] then
      sessSeen[s .. '|' .. u] = true
      if not sessCount[s] then sessCount[s] = 0; sessCountry[s] = {}; sessions = sessions + 1 end
      sessCount[s] = sessCount[s] + 1
      sessCountry[s][c] = (sessCountry[s][c] or 0) + 1
    end
  end
end
for _, s in ipairs(redis.call('HKEYS', KEYS[3])) do redis.call('DEL', 'pz:sc:' .. s) end
redis.call('DEL', KEYS[2], KEYS[3])
for c, n in pairs(perCountry) do redis.call('HSET', KEYS[2], c, n) end
for s, n in pairs(sessCount) do
  redis.call('HSET', KEYS[3], s, n)
  for c, k in pairs(sessCountry[s]) do redis.call('HSET', 'pz:sc:' .. s, c, k) end
end
return { users, sessions }`;

export interface StartInput { meditationId: string; userId: string; sessionId?: string | null; country?: string | null; mode: 'solo' | 'group' | 'silence' }

/**
 * Live presence in Redis (spec §7.4): who is meditating right now. A user counts once however many meditations they have
 * open; a country is only ever an ISO code. Counters are kept incrementally by atomic scripts and rebuilt every minute.
 */
@Injectable()
export class PresenceService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async start(i: StartInput, now = Date.now()): Promise<'started' | 'refreshed' | 'forbidden'> {
    const r = await this.redis.eval(START, 5, K.presenceMed(i.meditationId), K.presenceZ, K.presenceUser(i.userId), K.aggCountry, K.aggSession,
      i.meditationId, i.userId, i.sessionId ?? '', i.country ?? HIDDEN_COUNTRY, i.mode, now, now, KEEP_SEC) as number;
    return r === 1 ? 'started' : r === 0 ? 'refreshed' : 'forbidden';
  }

  /** `false` when the meditation is unknown (expired) or not the caller's: the app should start it again. */
  async beat(meditationId: string, userId: string, now = Date.now()): Promise<boolean> {
    return (await this.redis.eval(BEAT, 3, K.presenceMed(meditationId), K.presenceZ, K.presenceUser(userId), meditationId, userId, now, KEEP_SEC)) === 1;
  }

  async stop(meditationId: string, userId: string): Promise<boolean> {
    return (await this.redis.eval(STOP, 5, K.presenceMed(meditationId), K.presenceZ, K.presenceUser(userId), K.aggCountry, K.aggSession, meditationId, userId)) === 1;
  }

  /** Removes entries nobody has refreshed for 90 s. Returns how many. */
  async sweep(now = Date.now()): Promise<number> {
    let removed = 0;
    for (;;) {
      const ids = await this.redis.zrangebyscore(K.presenceZ, '-inf', now - PRESENCE_STALE_MS, 'LIMIT', '0', '500');
      if (!ids.length) return removed;
      for (const id of ids) {
        const userId = await this.redis.hget(K.presenceMed(id), 'userId');
        if (userId) await this.redis.eval(STOP, 5, K.presenceMed(id), K.presenceZ, K.presenceUser(userId), K.aggCountry, K.aggSession, id, '');
        else await this.redis.zrem(K.presenceZ, id); // the data is gone: the reconcile fixes the counters
        removed++;
      }
    }
  }

  /**
   * Rebuilds the running counters from the active entries (drift guard, every 60 s). One atomic script: it takes a few
   * hundred milliseconds at 50k entries, which is the price for numbers that are exact even while people start and stop.
   */
  async reconcile(): Promise<{ users: number; sessions: number }> {
    const [users, sessions] = await this.redis.eval(RECONCILE, 3, K.presenceZ, K.aggCountry, K.aggSession) as [number, number];
    return { users, sessions };
  }

  /** People and countries for one session (the player ring). Hidden countries do not count as countries. */
  async sessionLive(sessionId: string): Promise<{ people: number; countries: number }> {
    const [people, perCountry] = await Promise.all([this.redis.hget(K.aggSession, sessionId), this.redis.hgetall(K.presenceSessionCountries(sessionId))]);
    return { people: Number(people) || 0, countries: Object.keys(perCountry).filter((c) => c !== HIDDEN_COUNTRY && Number(perCountry[c]) > 0).length };
  }

  async activeSessions(): Promise<Record<string, number>> {
    return Object.fromEntries(Object.entries(await this.redis.hgetall(K.aggSession)).map(([k, v]) => [k, Number(v)]).filter(([, v]) => (v as number) > 0));
  }
}
