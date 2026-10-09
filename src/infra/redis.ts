import Redis from 'ioredis';
import { env } from '../config/env';

export const REDIS = Symbol('REDIS');

export function createRedis(url = env.REDIS_URL) {
  return new Redis(url, { maxRetriesPerRequest: 2, enableAutoPipelining: true, lazyConnect: false });
}

/** All Redis keys in one place (spec §6.2, §7.4). */
export const K = {
  rate: (bucket: string, id: string) => `rl:${bucket}:${id}`,
  entitlement: (userId: string) => `ent:${userId}`,
  tokenVersion: (userId: string) => `tv:${userId}`,
  mergeToken: (t: string) => `merge:${t}`,
  mfaToken: (t: string) => `mfa:${t}`,
  upload: (mediaId: string) => `upload:${mediaId}`,
  adminRevoked: (adminId: string) => `adm:ver:${adminId}`,
  totpUsed: (adminId: string, code: string) => `totp:${adminId}:${code}`,
  loginFail: (key: string) => `lf:${key}`,
  emailCooldown: (email: string, purpose: string) => `ec:${purpose}:${email}`,
  config: (key: string) => `config:${key}`,
  presenceMed: (medId: string) => `pz:m:${medId}`,
  presenceSessionCountries: (sessionId: string) => `pz:sc:${sessionId}`,
  liveAggLast: 'live:agg:last',
  lobbyCountries: (date: string) => `lobby:c:${date}`,
  minsToday: (date: string) => `min:${date}`,
  dashKpisLast: 'dash:kpis:last',
  editing: (type: string, id: string) => `edit:${type}:${id}`,
  presenceZ: 'pz:z',
  presenceUser: (userId: string) => `pz:u:${userId}`,
  aggCountry: 'pz:agg:country',
  aggSession: 'pz:agg:session',
  lobby: (date: string) => `lobby:${date}`,
  practiced: (date: string) => `motd:${date}:users`,
  medsToday: (date: string) => `med:${date}`,
  medsTodayCountry: (date: string) => `med:${date}:c`, // hash country → people who meditated today (the map's "where")
  dedLimit: (userId: string, localDate: string) => `ded:${userId}:${localDate}`,
  today: (date: string, plan: 'free' | 'member') => `today:${date}:${plan}`,
  catalog: (version: number) => `catalog:v${version}`,
  vibration: 'vibration:now',
  statsDone: (meditationId: string) => `stats:done:${meditationId}`,
  countersPlays: 'counters:plays',
  countersCompletions: 'counters:completions',
  leader: 'scheduler:leader',
} as const;
