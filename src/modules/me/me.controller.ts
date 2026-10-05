import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { CurrentUser, type AppUser } from '../../common/auth';
import { Zod } from '../../common/zod';
import { users } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { AuthService } from '../auth/auth.service';

const tz = z.string().max(64).refine((v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }, 'Unknown time zone');
const PatchMe = z.object({
  firstName: z.string().trim().min(1).max(30).regex(/^[\p{L}\p{M}' -]+$/u, 'Letters and spaces only').optional(),
  timezone: tz.optional(),
  locale: z.string().max(10).optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  theme: z.enum(['dark', 'light', 'system']).optional(),
  reminderEnabled: z.boolean().optional(),
  reminderTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm').optional(),
  groupWarning: z.boolean().optional(),
  dailyMessagePush: z.boolean().optional(),
  showCountry: z.boolean().optional(),
}).strict();

@ApiTags('Me')
@ApiBearerAuth()
@Controller('v1/me')
export class MeController {
  constructor(private readonly auth: AuthService, @Inject(DRIZZLE) private readonly db: DB) {}

  @Get()
  me(@CurrentUser() u: AppUser) { return this.auth.me(u.id); }

  @Patch()
  async update(@CurrentUser() u: AppUser, @Body(new Zod(PatchMe)) b: z.infer<typeof PatchMe>) {
    if (Object.keys(b).length) await this.db.update(users).set({ ...b, lastActiveAt: new Date() }).where(eq(users.id, u.id));
    return this.auth.me(u.id);
  }
}
