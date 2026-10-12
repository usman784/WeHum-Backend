import { Body, Controller, Delete, Get, HttpCode, Inject, Patch, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { eq } from 'drizzle-orm';
import { v7 as uuid } from 'uuid';
import { z } from 'zod';
import { CurrentUser, RateLimit, type AppUser } from '../../common/auth';
import { AppError } from '../../common/errors';
import { Zod } from '../../common/zod';
import { users } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { S3Service } from '../../infra/s3';
import { AuthService } from '../auth/auth.service';
import { UsernameService, validateUsername } from './username.service';

const tz = z.string().max(64).refine((v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }, 'Unknown time zone');
const name = z.string().trim().min(1).max(30).regex(/^[\p{L}\p{M}' .-]+$/u, 'Letters and spaces only');
const PatchMe = z.object({
  firstName: name.optional(),
  lastName: name.nullable().optional(),
  username: z.string().trim().min(3).max(20).optional(),
  timezone: tz.optional(),
  locale: z.string().max(10).optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  theme: z.enum(['dark', 'light', 'system']).optional(),
  reminderEnabled: z.boolean().optional(),
  reminderTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm').optional(),
  groupWarning: z.boolean().optional(),
  dailyMessagePush: z.boolean().optional(),
  showCountry: z.boolean().optional(),
  weeklyGoal: z.number().int().min(1).max(7).optional(),
}).strict();
const UsernameQuery = z.object({ u: z.string().max(40).optional(), seed: z.string().max(80).optional() });
const AvatarBody = z.object({ contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']), data: z.string().min(100).max(2_000_000) }).strict();
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;

@ApiTags('Me')
@ApiBearerAuth()
@Controller('v1/me')
export class MeController {
  constructor(private readonly auth: AuthService, private readonly usernames: UsernameService, private readonly s3: S3Service, @Inject(DRIZZLE) private readonly db: DB) {}

  @Get()
  me(@CurrentUser() u: AppUser) { return this.auth.me(u.id); }

  /**
   * Profile edits. The e-mail is never changed here. A username can change once every 7 days (the first choice, at sign-up,
   * is free); `429 RATE_LIMITED` carries `nextChangeAt`.
   */
  @Patch()
  async update(@CurrentUser() u: AppUser, @Body(new Zod(PatchMe)) b: z.infer<typeof PatchMe>) {
    const { username, ...rest } = b;
    const patch: Partial<typeof users.$inferInsert> = { ...rest };
    if (username !== undefined) {
      const [cur] = await this.db.select({ username: users.username, usernameChangedAt: users.usernameChangedAt }).from(users).where(eq(users.id, u.id));
      const next = await this.usernames.assertChange(u.id, cur ?? { username: null, usernameChangedAt: null }, username);
      if (next !== cur?.username?.toLowerCase()) { patch.username = next; if (cur?.username) patch.usernameChangedAt = new Date(); }
    }
    if (Object.keys(patch).length) await this.db.update(users).set({ ...patch, lastActiveAt: new Date() }).where(eq(users.id, u.id));
    return this.auth.me(u.id);
  }

  /** Live check while typing: is this name free and allowed? Always returns a few alternatives. */
  @RateLimit('username', 60, 60) @Get('username/check')
  async check(@CurrentUser() u: AppUser, @Query(new Zod(UsernameQuery)) q: z.infer<typeof UsernameQuery>) {
    const v = validateUsername(q.u ?? '');
    const available = v.ok ? await this.usernames.isAvailable(v.value, u.id) : false;
    return { available, reason: v.ok ? (available ? null : 'That username is taken') : v.reason, suggestions: await this.usernames.suggest(q.u || q.seed, 4) };
  }

  /** Instagram-style suggestions from a first name or e-mail. */
  @RateLimit('username', 60, 60) @Get('username/suggest')
  async suggest(@Query(new Zod(UsernameQuery)) q: z.infer<typeof UsernameQuery>) { return { suggestions: await this.usernames.suggest(q.seed ?? q.u, 5) }; }

  /** Profile photo as base64 (the app sends a ~512 px JPEG). Replaces the previous photo. */
  @RateLimit('avatar', 10, 60) @HttpCode(200) @Put('avatar')
  async setAvatar(@CurrentUser() u: AppUser, @Body(new Zod(AvatarBody)) b: z.infer<typeof AvatarBody>) {
    const buf = Buffer.from(b.data, 'base64');
    if (buf.length < 100 || buf.length > 1_500_000) throw new AppError('VALIDATION_FAILED', 'The photo must be under 1.5 MB');
    const ok = (b.contentType === 'image/jpeg' && buf[0] === 0xff && buf[1] === 0xd8) || (b.contentType === 'image/png' && buf[0] === 0x89 && buf[1] === 0x50) || (b.contentType === 'image/webp' && buf.subarray(8, 12).toString() === 'WEBP');
    if (!ok) throw new AppError('VALIDATION_FAILED', 'That is not a valid image');
    const key = `avatars/${u.id}/${uuid()}.${EXT[b.contentType]}`;
    await this.s3.putBuffer(key, buf, b.contentType);
    await this.db.update(users).set({ avatarUrl: key }).where(eq(users.id, u.id));
    return this.auth.me(u.id);
  }

  @HttpCode(200) @Delete('avatar')
  async removeAvatar(@CurrentUser() u: AppUser) { await this.db.update(users).set({ avatarUrl: null }).where(eq(users.id, u.id)); return this.auth.me(u.id); }
}
