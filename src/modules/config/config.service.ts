import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { K, REDIS } from '../../infra/redis';
import { env } from '../../config/env';
import { appConfig, mediaAssets } from '../../db/schema';
import { CONFIG_DEFAULTS } from '../../db/config-defaults';

export interface MainConfig { minVersion: { ios: string; android: string }; latestVersion?: { ios: string; android: string }; storeUrls?: { ios: string; android: string }; maintenance: boolean; features: Record<string, boolean>; supportEmail: string; defaultReminderTime: string; languages: string[] }
export interface TodayConfig { emptyRoomThreshold: number; freeHomePick: 'random' | 'newest'; showDailyMessage: boolean; sections: Record<string, boolean> }
export interface GlobalSitConfig { enabled: boolean; weekday: number; startUtc: string; lengthMin: number; lobbyOpenMin: number; reminderMin: number; title: string }
export interface GroupConfig {
  startUtc: string; lengthMin: number; lobbyOpenMin: number; reminderMin: number;
  cadence?: 'daily' | 'hourly';
  /** Group sits through the day: from the first hour to the last, every `stepHours` (default 1; 4 = 00, 04, 08, 12, 16, 20 UTC). */
  hourly?: { fromHourUtc: number; toHourUtc: number; lengthMin: number; stepHours?: number };
  /** The Global meditation: once a week, everyone at the same time (a different thing from the group sits). */
  global?: GlobalSitConfig;
  intentions?: string[]; focus?: { title: string; summary: string; quote: string; attribution: string }; doorsOpenSec?: number;
}
export interface BrandingConfig { appName: string; tagline: string; logoMediaId: string | null }
export interface SilenceConfig { durations: number[]; cadence: { inhaleSec: number; exhaleSec: number }; extendMin: number }
export interface CrisisLine { id: string; name: string; kind: string; description: string; actions: { type: 'call' | 'sms'; label: string; value: string }[] }
export interface CrisisConfig {
  defaultRegion: string; tip: string;
  regions: { code: string; name: string; countries: string[]; lines: CrisisLine[] }[];
  international: { country: string; line: string; value: string }[];
}
export interface SitTimesConfig { blocks: { time: string; label: string }[] }

/** app_config read-through cache (Redis, invalidated on write). Spec §4.2. */
@Injectable()
export class ConfigService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis) {}

  /** App name, tagline and logo URL (the logo is a ready image in the media library). Read by the app on launch and by the CMS shell. */
  async branding(): Promise<{ appName: string; tagline: string; logoUrl: string | null; version: number }> {
    const { value, version } = await this.get<BrandingConfig>('branding');
    let logoUrl: string | null = null;
    if (value.logoMediaId) {
      const [m] = await this.db.select({ key: mediaAssets.storageKey, status: mediaAssets.status }).from(mediaAssets).where(eq(mediaAssets.id, value.logoMediaId));
      if (m && m.status === 'ready') logoUrl = `${env.CDN_BASE_URL.replace(/\/$/, '')}/${m.key.replace(/^\//, '')}`;
    }
    return { appName: value.appName, tagline: value.tagline, logoUrl, version };
  }

  async get<T = Record<string, unknown>>(key: string): Promise<{ value: T; version: number }> {
    const cached = await this.redis.get(K.config(key)).catch(() => null);
    if (cached) return JSON.parse(cached);
    const [row] = await this.db.select().from(appConfig).where(eq(appConfig.key, key));
    const out = row ? { value: row.value as T, version: row.version } : { value: CONFIG_DEFAULTS[key] as T, version: 0 };
    await this.redis.set(K.config(key), JSON.stringify(out), 'EX', 3600).catch(() => null);
    return out;
  }

  async value<T>(key: string): Promise<T> { return (await this.get<T>(key)).value; }

  async set(key: string, value: unknown, by?: string) {
    const [row] = await this.db.insert(appConfig).values({ key, value, updatedBy: by })
      .onConflictDoUpdate({ target: appConfig.key, set: { value, version: sql`${appConfig.version} + 1`, updatedBy: by, updatedAt: new Date() } })
      .returning();
    await this.redis.del(K.config(key));
    return row!;
  }
}
