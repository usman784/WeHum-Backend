import { Body, Controller, Get, Headers, Inject, Injectable, Param, Put, Res } from '@nestjs/common';
import type Redis from 'ioredis';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { eq, sql } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AdminRoles } from '../../../common/auth';
import { AppError } from '../../../common/errors';
import { Zod } from '../../../common/zod';
import { CONFIG_DEFAULTS } from '../../../db/config-defaults';
import { appConfig } from '../../../db/schema';
import { DRIZZLE, type DB } from '../../../infra/core.module';
import { K, REDIS } from '../../../infra/redis';
import { CONTENT_ROLES, MANAGER_ROLES } from '../../admin-auth/rbac';
import { AdminWriter, assertVersion, CurrentActor, etag, type Actor } from '../admin-writer';
import { hhmm, url } from '../dto';

const semver = z.string().regex(/^\d+\.\d+\.\d+$/, 'x.y.z');
const flag = z.boolean();

/** One strict schema per `app_config` key (spec §4.2). */
export const CONFIG_SCHEMAS = {
  main: z.object({
    minVersion: z.object({ ios: semver, android: semver }).strict(), maintenance: flag,
    /** Newest release per store: older apps get a dismissible "update available" prompt (below `minVersion`, which blocks). */
    latestVersion: z.object({ ios: semver, android: semver }).strict().optional(),
    storeUrls: z.object({ ios: z.string().url().max(300).or(z.literal('')), android: z.string().url().max(300).or(z.literal('')) }).strict().optional(),
    features: z.object({ challenges: flag, gratitude: flag, breathwork: flag, milestones: flag, intent: flag }).strict(),
    supportEmail: z.string().email(), defaultReminderTime: hhmm, languages: z.array(z.string().max(10)).min(1).max(20),
  }).strict(),
  today: z.object({
    emptyRoomThreshold: z.number().int().min(0).max(1000), freeHomePick: z.enum(['random', 'newest']), showDailyMessage: flag,
    sections: z.object({ progress: flag, liveCounter: flag, worldMap: flag }).strict(),
  }).strict(),
  group: z.object({ startUtc: hhmm, lengthMin: z.union([z.literal(10), z.literal(30), z.literal(45)]), lobbyOpenMin: z.number().int().min(1).max(60), reminderMin: z.number().int().min(1).max(60) }).strict(),
  sos: z.object({
    title: z.string().trim().min(1).max(60), subtitle: z.string().trim().max(120),
    help: z.object({ title: z.string().trim().min(1).max(60), body: z.string().trim().max(400), bookingUrl: url, contactEmail: z.string().email() }).strict(),
  }).strict(),
  moderation: z.object({
    dailyLimit: z.number().int().min(1).max(20), autoHideReports: z.number().int().min(1).max(50), blockLinks: flag, profanity: flag,
    crisisWords: z.array(z.string().trim().min(2).max(40)).max(100), muteAfterHides: z.number().int().min(1).max(20),
  }).strict(),
  /** Breathwork (P11): the lessons with Raphael, in order (published sessions). */
  breathwork: z.object({ lessons: z.array(z.string().uuid()).max(20) }).strict(),
  legal: z.object({ privacyUrl: url, termsUrl: url, healthDisclaimer: z.string().max(1000), deleteInactiveGuestsMonths: z.number().int().min(1).max(60) }).strict(),
} as const;
export type ConfigKey = keyof typeof CONFIG_SCHEMAS;
/** Keys the app reads from the catalog snapshot, so a change must bump the catalog version. */
const IN_CATALOG: ConfigKey[] = ['sos'];

@Injectable()
export class ConfigAdminService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis, private readonly writer: AdminWriter) {}

  async get(key: ConfigKey) {
    const [row] = await this.db.select().from(appConfig).where(eq(appConfig.key, key));
    return { key, value: row?.value ?? CONFIG_DEFAULTS[key], version: row?.version ?? 0, updatedAt: row?.updatedAt?.toISOString() ?? null };
  }

  async all() { return Object.fromEntries(await Promise.all((Object.keys(CONFIG_SCHEMAS) as ConfigKey[]).map(async (k) => [k, await this.get(k)]))); }

  /** Validated save: bumps the key's version, audits, emits `config:changed` (+ `catalog:changed` for SoS). */
  async put(actor: Actor, key: ConfigKey, value: unknown, ifMatch?: string) {
    const out = await this.writer.run(actor, { action: 'config.update', type: 'config', id: key, catalog: IN_CATALOG.includes(key), invalidate: [K.config(key)] }, async (tx) => {
      const [cur] = await tx.select().from(appConfig).where(eq(appConfig.key, key)).for('update');
      if (cur) assertVersion(ifMatch, cur);
      const [row] = await tx.insert(appConfig).values({ key, value, updatedBy: actor.id, version: 1 })
        .onConflictDoUpdate({ target: appConfig.key, set: { value, version: sql`${appConfig.version} + 1`, updatedBy: actor.id, updatedAt: new Date() } }).returning();
      return {
        result: { key, value: row!.value, version: row!.version, updatedAt: row!.updatedAt.toISOString() },
        before: cur?.value ?? CONFIG_DEFAULTS[key], after: value, version: row!.version,
        events: [{ topic: 'config:changed', payload: { key, version: row!.version } }],
      };
    });
    // the MOTD payload embeds the group time, so cached copies must go
    if (key === 'group') { const keys = await this.redis.keys('motd:????-??-??'); if (keys.length) await this.redis.del(...keys); }
    return out;
  }
}

const ConfigKeys = new Zod(z.enum(['main', 'legal', 'moderation', 'today', 'group', 'sos']));

@ApiTags('Admin Settings')
@ApiBearerAuth()
@Controller('v1/admin')
export class ConfigAdminController {
  constructor(private readonly config: ConfigAdminService) {}

  private async save(a: Actor, key: ConfigKey, body: unknown, ifMatch: string | undefined, res: FastifyReply) {
    const out = await this.config.put(a, key, (CONFIG_SCHEMAS[key] as z.ZodTypeAny).parse(body ?? {}), ifMatch);
    res.header('etag', etag(out.version));
    return out;
  }

  // Today screen rules and group meditation are content (editors); everything else is owner/admin.
  @AdminRoles(...CONTENT_ROLES) @Get('config/today')
  async today(@Res({ passthrough: true }) res: FastifyReply) { const c = await this.config.get('today'); res.header('etag', etag(c.version)); return c; }

  @AdminRoles(...CONTENT_ROLES) @Put('config/today')
  putToday(@CurrentActor() a: Actor, @Body() b: unknown, @Headers('if-match') m: string | undefined, @Res({ passthrough: true }) res: FastifyReply) { return this.save(a, 'today', b, m, res); }

  @AdminRoles(...MANAGER_ROLES) @Get('config')
  all() { return this.config.all(); }

  @AdminRoles(...MANAGER_ROLES) @Put('config/:key')
  put(@CurrentActor() a: Actor, @Param('key', ConfigKeys) key: ConfigKey, @Body() b: unknown, @Headers('if-match') m: string | undefined, @Res({ passthrough: true }) res: FastifyReply) {
    if (key === 'today' || key === 'group' || key === 'breathwork') throw new AppError('FORBIDDEN', `Use the ${key} screen`); // owners/admins can still use /config/today and /group
    return this.save(a, key, b, m, res);
  }

  @AdminRoles(...CONTENT_ROLES) @Get('breathwork')
  async breathwork(@Res({ passthrough: true }) res: FastifyReply) { const c = await this.config.get('breathwork'); res.header('etag', etag(c.version)); return c; }

  @AdminRoles(...CONTENT_ROLES) @Put('breathwork')
  putBreathwork(@CurrentActor() a: Actor, @Body() b: unknown, @Headers('if-match') m: string | undefined, @Res({ passthrough: true }) res: FastifyReply) { return this.save(a, 'breathwork', b, m, res); }

  @AdminRoles(...CONTENT_ROLES) @Put('group')
  putGroup(@CurrentActor() a: Actor, @Body() b: unknown, @Headers('if-match') m: string | undefined, @Res({ passthrough: true }) res: FastifyReply) { return this.save(a, 'group', b, m, res); }
}
