import { Body, Controller, Get, Headers, HttpCode, Inject, Injectable, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { desc, eq, sql } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { AdminRoles } from '../../common/auth';
import { AppError } from '../../common/errors';
import { Zod } from '../../common/zod';
import { autoNotifications, notifications, users } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { CONTENT_ROLES, MANAGER_ROLES } from '../admin-auth/rbac';
import { AdminWriter, assertVersion, CurrentActor, etag, type Actor } from '../admin/admin-writer';
import { cursorQuery, IdParam } from '../admin/dto';
import { PushService, type Audience } from './push.service';

const AUDIENCES = ['all', 'members', 'free', 'trial', 'guests', 'country'] as const;
const Fields = {
  title: z.string().trim().min(1).max(50), body: z.string().trim().min(1).max(150), audience: z.enum(AUDIENCES).default('all'),
  countries: z.array(z.string().length(2).regex(/^[A-Z]{2}$/)).max(60).default([]), deepLink: z.string().trim().max(200).regex(/^(wehum:\/\/|https:\/\/)/, 'wehum:// or https://').nullable().optional(),
  sendMode: z.enum(['now', 'user_reminder_time', 'scheduled']).default('now'), sendAt: z.string().datetime().nullable().optional(),
};
const Create = z.object(Fields).strict().refine((b) => b.audience !== 'country' || b.countries.length > 0, { message: 'Choose at least one country', path: ['countries'] });
const PatchDto = z.object({ ...Fields, title: Fields.title.optional(), body: Fields.body.optional(), audience: Fields.audience.optional(), countries: Fields.countries.optional(), sendMode: Fields.sendMode.optional() }).strict();
const AudienceQuery = z.object({ audience: z.enum(AUDIENCES).default('all'), countries: z.string().max(200).default(''), at: z.string().datetime().optional() });
const AutoPatch = z.object({ enabled: z.boolean().optional(), title: z.string().trim().min(1).max(50).optional(), body: z.string().trim().min(1).max(150).optional() }).strict();
const TestDto = z.object({ email: z.string().trim().toLowerCase().email() }).strict();
const List = z.object(cursorQuery);
const IdP = new Zod(IdParam);

@Injectable()
export class NotificationsAdminService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly writer: AdminWriter, private readonly push: PushService) {}

  async list(q: z.infer<typeof List>) {
    const rows = await this.db.select().from(notifications).orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(Math.min(100, q.limit));
    return rows;
  }

  private async get(id: string) {
    const [n] = await this.db.select().from(notifications).where(eq(notifications.id, id));
    if (!n) throw new AppError('NOT_FOUND', 'Notification not found');
    return n;
  }

  private checkSchedule(mode: string, sendAt?: string | null) {
    if (mode === 'scheduled') {
      if (!sendAt) throw new AppError('VALIDATION_FAILED', 'Pick a time', { fields: [{ path: 'sendAt', message: 'Required' }] });
      if (Date.parse(sendAt) < Date.now() + 60_000) throw new AppError('VALIDATION_FAILED', 'Pick a time in the future', { fields: [{ path: 'sendAt', message: 'Must be in the future' }] });
    }
  }

  create(actor: Actor, b: z.infer<typeof Create>) {
    this.checkSchedule(b.sendMode, b.sendAt);
    const id = uuidv7();
    return this.writer.run(actor, { action: 'notification.create', type: 'notification', id }, async (tx) => {
      const [row] = await tx.insert(notifications).values({ id, title: b.title, body: b.body, audience: b.audience, countries: b.countries, deepLink: b.deepLink ?? null, sendMode: b.sendMode, sendAt: b.sendAt ? new Date(b.sendAt) : null, createdBy: actor.id! }).returning();
      return { result: row!, after: b, version: 1 };
    });
  }

  update(actor: Actor, id: string, b: z.infer<typeof PatchDto>, ifMatch?: string) {
    return this.writer.run(actor, { action: 'notification.update', type: 'notification', id }, async (tx) => {
      const [cur] = await tx.select().from(notifications).where(eq(notifications.id, id)).for('update');
      if (!cur) throw new AppError('NOT_FOUND', 'Notification not found');
      if (cur.status !== 'draft' && cur.status !== 'scheduled') throw new AppError('INVALID_STATE', 'Only drafts and scheduled notifications can be edited');
      if (actor.role === 'editor' && cur.status !== 'draft') throw new AppError('FORBIDDEN', 'Editors can change drafts only');
      assertVersion(ifMatch, cur);
      const mode = b.sendMode ?? cur.sendMode;
      this.checkSchedule(mode, b.sendAt !== undefined ? b.sendAt : cur.sendAt?.toISOString());
      const audience = b.audience ?? cur.audience;
      if (audience === 'country' && !(b.countries ?? cur.countries).length) throw new AppError('VALIDATION_FAILED', 'Choose at least one country', { fields: [{ path: 'countries', message: 'Required' }] });
      const { sendAt, ...rest } = b;
      const [row] = await tx.update(notifications).set({ ...rest, ...(sendAt !== undefined && { sendAt: sendAt ? new Date(sendAt) : null }), version: cur.version + 1 }).where(eq(notifications.id, id)).returning();
      return { result: row!, before: cur, after: b, version: row!.version };
    });
  }

  /** Quick answer for the compose screen: how many people, and how many of them are in quiet hours at that moment. */
  async audience(a: Audience, countries: string[], at?: string) {
    const when = at ? Date.parse(at) : Date.now();
    const [targeted, quiet] = await Promise.all([this.push.audienceCount(a, countries), this.push.quietCount(a, countries, when)]);
    return { targeted, quiet, quietHours: { start: '22:00', end: '07:00' } };
  }

  async send(actor: Actor, id: string) {
    const n = await this.get(id);
    if (n.status !== 'draft') throw new AppError('INVALID_STATE', 'Only a draft can be sent');
    this.checkSchedule(n.sendMode, n.sendAt?.toISOString());
    const targeted = await this.push.audienceCount(n.audience, n.countries);
    if (targeted === 0) throw new AppError('INVALID_STATE', 'Nobody can receive this: no people with push turned on in this audience');
    const scheduled = n.sendMode === 'scheduled';
    const quiet = await this.push.quietCount(n.audience, n.countries, n.sendAt?.getTime() ?? Date.now());
    const row = await this.writer.run(actor, { action: 'notification.send', type: 'notification', id }, async (tx) => {
      const [r] = await tx.update(notifications).set({ status: scheduled ? 'scheduled' : 'sending', targeted, sendAt: scheduled ? n.sendAt : new Date(), version: n.version + 1 }).where(eq(notifications.id, id)).returning();
      return { result: r!, before: { status: n.status }, after: { status: r!.status, targeted, audience: n.audience }, version: r!.version };
    });
    if (!scheduled) await this.push.announcements(Date.now()); // first batch now; the minute job continues
    return { ...(await this.get(id)), quietCount: quiet, version: row.version };
  }

  cancel(actor: Actor, id: string) {
    return this.writer.run(actor, { action: 'notification.cancel', type: 'notification', id }, async (tx) => {
      const [cur] = await tx.select().from(notifications).where(eq(notifications.id, id)).for('update');
      if (!cur) throw new AppError('NOT_FOUND', 'Notification not found');
      if (cur.status !== 'scheduled' && cur.status !== 'sending') throw new AppError('INVALID_STATE', 'Only scheduled or sending notifications can be cancelled');
      const [r] = await tx.update(notifications).set({ status: 'cancelled', version: cur.version + 1 }).where(eq(notifications.id, id)).returning();
      return { result: r!, before: { status: cur.status }, after: { status: 'cancelled' }, version: r!.version };
    });
  }

  /** "Send test to me": goes to the app account with this email (the admin's own phone). Not counted in the statistics. */
  async test(id: string, email: string) {
    const n = await this.get(id);
    const [u] = await this.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (!u) throw new AppError('NOT_FOUND', 'No app account with this email. Sign in to the app with it first.');
    const r = await this.push.deliver([u.id], { title: `[Test] ${n.title}`, body: n.body, type: 'announcement', deepLink: n.deepLink, notificationId: n.id });
    if (!r.delivered.length) throw new AppError('INVALID_STATE', 'The test could not be delivered. Is push turned on in the app?');
    return { sent: true };
  }

  automatic() { return this.db.select().from(autoNotifications).orderBy(autoNotifications.key); }

  patchAutomatic(actor: Actor, key: string, b: z.infer<typeof AutoPatch>) {
    return this.writer.run(actor, { action: 'notification.automatic', type: 'config', id: `auto:${key}` }, async (tx) => {
      const [cur] = await tx.select().from(autoNotifications).where(eq(autoNotifications.key, key)).for('update');
      if (!cur) throw new AppError('NOT_FOUND', 'Unknown automatic notification');
      const [r] = await tx.update(autoNotifications).set({ ...b, updatedAt: new Date() }).where(eq(autoNotifications.key, key)).returning();
      return { result: r!, before: cur, after: b };
    });
  }
}

@ApiTags('Admin Notifications')
@ApiBearerAuth()
@Controller('v1/admin/notifications')
export class NotificationsAdminController {
  constructor(private readonly svc: NotificationsAdminService) {}

  @AdminRoles(...CONTENT_ROLES) @Get() list(@Query(new Zod(List)) q: z.infer<typeof List>) { return this.svc.list(q); }
  @AdminRoles(...CONTENT_ROLES) @Get('audience') audience(@Query(new Zod(AudienceQuery)) q: z.infer<typeof AudienceQuery>) { return this.svc.audience(q.audience, q.countries ? q.countries.split(',').filter(Boolean) : [], q.at); }
  @AdminRoles(...CONTENT_ROLES) @Get('automatic') automatic() { return this.svc.automatic(); }
  @AdminRoles(...MANAGER_ROLES) @Patch('automatic/:key') patchAuto(@CurrentActor() a: Actor, @Param('key') key: string, @Body(new Zod(AutoPatch)) b: z.infer<typeof AutoPatch>) { return this.svc.patchAutomatic(a, key, b); }

  @AdminRoles(...CONTENT_ROLES) @Post()
  async create(@CurrentActor() a: Actor, @Body(new Zod(Create)) b: z.infer<typeof Create>, @Res({ passthrough: true }) res: FastifyReply) { const r = await this.svc.create(a, b); res.header('etag', etag(r.version)); return r; }

  @AdminRoles(...CONTENT_ROLES) @Patch(':id')
  async patch(@CurrentActor() a: Actor, @Param('id', IdP) id: string, @Body(new Zod(PatchDto)) b: z.infer<typeof PatchDto>, @Headers('if-match') m: string | undefined, @Res({ passthrough: true }) res: FastifyReply) {
    const r = await this.svc.update(a, id, b, m); res.header('etag', etag(r.version)); return r;
  }

  @AdminRoles(...CONTENT_ROLES) @HttpCode(200) @Post(':id/test') test(@Param('id', IdP) id: string, @Body(new Zod(TestDto)) b: z.infer<typeof TestDto>) { return this.svc.test(id, b.email); }
  @AdminRoles(...MANAGER_ROLES) @HttpCode(200) @Post(':id/send') send(@CurrentActor() a: Actor, @Param('id', IdP) id: string) { return this.svc.send(a, id); }
  @AdminRoles(...MANAGER_ROLES) @HttpCode(200) @Post(':id/cancel') cancel(@CurrentActor() a: Actor, @Param('id', IdP) id: string) { return this.svc.cancel(a, id); }
}
