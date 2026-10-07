import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { CurrentUser, type AppUser } from '../../common/auth';
import { AppError } from '../../common/errors';
import { clampLimit, decodeCursor, encodeCursor } from '../../common/pagination';
import { Zod } from '../../common/zod';
import { devices, inboxItems } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { REDIS } from '../../infra/redis';
import { GroupService } from '../today/group.service';
import { PushTransport } from './push.transport';

const DeviceDto = z.object({
  installId: z.string().min(8).max(64), platform: z.enum(['ios', 'android']), pushToken: z.string().min(10).max(512).nullable().optional(),
  appVersion: z.string().regex(/^\d+\.\d+\.\d+/).max(20), osVersion: z.string().max(40).optional(), model: z.string().max(80).optional(),
}).strict();
const InboxQuery = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });
const ReadDto = z.object({ ids: z.array(z.string().uuid()).min(1).max(100).optional(), all: z.literal(true).optional() }).strict().refine((b) => !!b.ids !== !!b.all, 'Send ids or all');
const Id = new Zod(z.string().uuid());

@ApiTags('Push & inbox')
@ApiBearerAuth()
@Controller('v1')
export class PushController {
  constructor(@Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis, private readonly group: GroupService, private readonly transport: PushTransport) {}

  /** Register or update this phone and its push token. A token belongs to one device: an older owner loses it. */
  @Post('me/devices')
  async register(@CurrentUser() u: AppUser, @Body(new Zod(DeviceDto)) b: z.infer<typeof DeviceDto>) {
    const [prev] = await this.db.select({ userId: devices.userId, token: devices.pushToken }).from(devices).where(eq(devices.installId, b.installId));
    if (b.pushToken) await this.db.update(devices).set({ pushToken: null }).where(and(eq(devices.pushToken, b.pushToken), sql`${devices.installId} <> ${b.installId}`));
    const [row] = await this.db.insert(devices).values({ id: uuidv7(), userId: u.id, installId: b.installId, platform: b.platform, pushToken: b.pushToken ?? null, appVersion: b.appVersion, osVersion: b.osVersion, model: b.model })
      .onConflictDoUpdate({ target: devices.installId, set: { userId: u.id, platform: b.platform, appVersion: b.appVersion, osVersion: b.osVersion, model: b.model, lastSeenAt: new Date(), ...(b.pushToken !== undefined && { pushToken: b.pushToken }) } })
      .returning({ id: devices.id });
    // topic user_<id>: leave the old owner's / old token's topic, join this user's
    if (prev?.token && (prev.userId !== u.id || prev.token !== b.pushToken) && b.pushToken !== undefined) await this.transport.unsubscribe(prev.userId, [prev.token]);
    if (b.pushToken) await this.transport.subscribe(u.id, [b.pushToken]);
    return { id: row!.id, pushEnabled: !!b.pushToken };
  }

  @HttpCode(204) @Delete('me/devices/:id')
  async unregister(@CurrentUser() u: AppUser, @Param('id', Id) id: string) {
    const [old] = await this.db.select({ token: devices.pushToken }).from(devices).where(and(eq(devices.id, id), eq(devices.userId, u.id)));
    const r = await this.db.update(devices).set({ pushToken: null }).where(and(eq(devices.id, id), eq(devices.userId, u.id))).returning({ id: devices.id });
    if (!r.length) throw new AppError('NOT_FOUND', 'Device not found');
    if (old?.token) await this.transport.unsubscribe(u.id, [old.token]);
  }

  @Get('me/inbox')
  async inbox(@CurrentUser() u: AppUser, @Query(new Zod(InboxQuery)) q: z.infer<typeof InboxQuery>) {
    const limit = clampLimit(q.limit, 20);
    const c = decodeCursor(q.cursor);
    const cond = and(eq(inboxItems.userId, u.id), c ? or(lt(inboxItems.createdAt, new Date(String(c.k))), and(eq(inboxItems.createdAt, new Date(String(c.k))), lt(inboxItems.id, c.id))) : undefined);
    const rows = await this.db.select().from(inboxItems).where(cond).orderBy(desc(inboxItems.createdAt), desc(inboxItems.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const [unread] = await this.db.select({ n: sql<number>`count(*)::int` }).from(inboxItems).where(and(eq(inboxItems.userId, u.id), sql`${inboxItems.readAt} is null`));
    return {
      data: page.map((i) => ({ id: i.id, type: i.type, title: i.title, body: i.body, deepLink: i.deepLink, createdAt: i.createdAt.toISOString(), read: !!i.readAt })),
      meta: { nextCursor: rows.length > limit ? encodeCursor(page.at(-1)!.createdAt.toISOString(), page.at(-1)!.id) : null, unread: unread?.n ?? 0 },
    };
  }

  @HttpCode(200) @Post('me/inbox/read')
  async read(@CurrentUser() u: AppUser, @Body(new Zod(ReadDto)) b: z.infer<typeof ReadDto>) {
    const r = await this.db.update(inboxItems).set({ readAt: new Date() })
      .where(and(eq(inboxItems.userId, u.id), sql`${inboxItems.readAt} is null`, b.ids ? inArray(inboxItems.id, b.ids) : undefined)).returning({ id: inboxItems.id });
    return { read: r.length };
  }

  /** "Remind me" on the lobby: this person gets the group warning for the next start. */
  @HttpCode(200) @Put('group/remind')
  async remind(@CurrentUser() u: AppUser) {
    const g = await this.group.next();
    await this.redis.sadd(`lobby:remind:${g.date}`, u.id);
    await this.redis.expire(`lobby:remind:${g.date}`, 3 * 86_400);
    return { date: g.date, startsAt: g.startsAt, reminding: true };
  }

  @HttpCode(200) @Delete('group/remind')
  async unremind(@CurrentUser() u: AppUser) {
    const g = await this.group.next();
    await this.redis.srem(`lobby:remind:${g.date}`, u.id);
    return { date: g.date, startsAt: g.startsAt, reminding: false };
  }
}
