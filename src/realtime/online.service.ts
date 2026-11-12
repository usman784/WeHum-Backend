import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { K, REDIS } from '../infra/redis';
import { HIDDEN_COUNTRY, PRESENCE_STALE_MS } from './presence.service';

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

// KEYS: 1 on:z  2 on:c  3 pz:z   ARGV: 1 onlineSince  2 meditatingSince  3 limit
// Cities of everyone online and of everyone meditating (a person counts once), top `limit` each. O(online + meditating).
const CITIES = `
local function tally(ids, ckey, limit, uid)
  local per, sla, sln, seen = {}, {}, {}, {}
  for _, id in ipairs(ids) do
    local u = uid(id)
    if u and not seen[u] then
      seen[u] = true
      local v = redis.call('HGET', ckey, u)
      if v then
        local c, name, lat, lng = string.match(v, '^(%w+)|([^|]*)|([^|]*)|([^|]*)$')
        if c then
          local k = c .. '|' .. name
          per[k] = (per[k] or 0) + 1
          sla[k] = (sla[k] or 0) + tonumber(lat); sln[k] = (sln[k] or 0) + tonumber(lng) -- the dot sits at the average of its people
        end
      end
    end
  end
  local rows = {}
  for k, n in pairs(per) do table.insert(rows, {k, n}) end
  table.sort(rows, function(a, b) if a[2] ~= b[2] then return a[2] > b[2] end return a[1] < b[1] end)
  local out = {}
  for i = 1, math.min(#rows, limit) do local k = rows[i][1]; local n = rows[i][2]; table.insert(out, k .. '|' .. string.format('%.1f', sla[k] / n) .. '|' .. string.format('%.1f', sln[k] / n) .. '|' .. n) end
  return out
end
local limit = tonumber(ARGV[3])
local online = tally(redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], '+inf'), KEYS[2], limit, function(id) return id end)
local med = tally(redis.call('ZRANGEBYSCORE', KEYS[3], ARGV[2], '+inf'), KEYS[2], limit, function(id) return redis.call('HGET', 'pz:m:' .. id, 'userId') end)
return { online, med }`;

export interface OnlineCounts { total: number; guests: number; countries: { c: string; n: number }[] }
/** The app's maps show a city only with at least this many people meditating there (a single person is never a dot). */
export const PUBLIC_CITY_MIN = 3;
/** A city on the CMS map: name, country, position rounded to ~10 km, and how many people. Never who. */
export interface CityCount { c: string; name: string; lat: number; lng: number; n: number }
export interface OnlineUser { id: string; isGuest: boolean; country: string | null; city?: { name: string; lat: number; lng: number } | null }
/** From a users row: the country and the city are both off when the person hides their country. */
export const onlineUserOf = (r: { id: string; isGuest: boolean; country: string | null; showCountry: boolean; city: string | null; cityLat: number | null; cityLng: number | null }): OnlineUser => ({
  id: r.id, isGuest: r.isGuest, country: r.showCountry ? r.country : null,
  city: r.showCountry && r.country && r.city && r.cityLat !== null && r.cityLng !== null ? { name: r.city, lat: r.cityLat, lng: r.cityLng } : null,
});
const cityOf = (u: OnlineUser) => (u.country && u.city ? `${u.country}|${u.city.name}|${u.city.lat}|${u.city.lng}` : null);
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
    const came = (await this.redis.eval(TOUCH, 3, K.onlineZ, K.onlineMeta, K.onlineSockets(u.id), u.id, metaOf(u), now, now - ONLINE_STALE_MS, KEEP_SEC, ...socketIds)) === 1;
    await this.setCity(u);
    return came;
  }

  private async setCity(u: OnlineUser) {
    const v = cityOf(u);
    if (v) await this.redis.hset(K.onlineCity, u.id, v);
    else await this.redis.hdel(K.onlineCity, u.id);
  }

  /** One socket closed. `true` when that was the user's last one anywhere: they are offline now. */
  async leave(userId: string, socketId: string, now = Date.now()): Promise<boolean> {
    const gone = (await this.redis.eval(LEAVE, 3, K.onlineZ, K.onlineMeta, K.onlineSockets(userId), userId, socketId, now - ONLINE_STALE_MS)) === 1;
    if (gone) await this.redis.hdel(K.onlineCity, userId);
    return gone;
  }

  /** The user changed "show my country" (or linked an account): the map follows at once, not at the next touch. */
  async setMeta(u: OnlineUser): Promise<void> {
    await this.redis.eval(SET_META, 1, K.onlineMeta, u.id, metaOf(u));
    if (await this.redis.hexists(K.onlineMeta, u.id)) await this.setCity(u);
  }

  /** Drops users whose apps vanished without closing (a pod died); returns them with their last touch. */
  async sweep(now = Date.now()): Promise<{ id: string; lastSeen: number }[]> {
    const flat = (await this.redis.eval(SWEEP, 2, K.onlineZ, K.onlineMeta, now - ONLINE_STALE_MS, 1000)) as string[];
    const out: { id: string; lastSeen: number }[] = [];
    for (let i = 0; i < flat.length; i += 2) out.push({ id: flat[i]!, lastSeen: Number(flat[i + 1]) });
    if (out.length) await this.redis.hdel(K.onlineCity, ...out.map((o) => o.id));
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

  /** The CMS city map: where people are online and meditating, by city (top 50 each), straight from Redis. */
  async cities(now = Date.now(), limit = 50): Promise<{ online: CityCount[]; meditating: CityCount[] }> {
    const [on, med] = (await this.redis.eval(CITIES, 3, K.onlineZ, K.onlineCity, K.presenceZ, now - ONLINE_STALE_MS, now - PRESENCE_STALE_MS, limit)) as [string[], string[]];
    const parse = (rows: string[]): CityCount[] => rows.map((r) => {
      const [c, name, lat, lng, n] = r.split('|');
      return { c: c!, name: name!, lat: Number(lat), lng: Number(lng), n: Number(n) };
    });
    return { online: parse(on), meditating: parse(med) };
  }
}
