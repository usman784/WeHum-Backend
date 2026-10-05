import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { K, REDIS } from '../../infra/redis';
import { appConfig } from '../../db/schema';
import { CONFIG_DEFAULTS } from '../../db/config-defaults';

export interface MainConfig { minVersion: { ios: string; android: string }; maintenance: boolean; features: Record<string, boolean>; supportEmail: string; defaultReminderTime: string; languages: string[] }
export interface TodayConfig { emptyRoomThreshold: number; freeHomePick: 'random' | 'newest'; showDailyMessage: boolean; sections: Record<string, boolean> }
export interface GroupConfig { startUtc: string; lengthMin: number; lobbyOpenMin: number; reminderMin: number }

/** app_config read-through cache (Redis, invalidated on write). Spec §4.2. */
@Injectable()
export class ConfigService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis) {}

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
