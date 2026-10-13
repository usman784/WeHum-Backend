import { Body, Controller, Get, HttpCode, Inject, Injectable, Logger, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createHash } from 'node:crypto';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { AdminRoles } from '../../common/auth';
import { env } from '../../config/env';
import { users } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { MANAGER_ROLES } from '../admin-auth/rbac';
import { ConfigService } from '../config/config.service';

export type NewsletterSettings = { enabled: boolean; listId: string; doubleOptIn: boolean; tags: string[] };

/**
 * E-mail addresses go to the newsletter list (Mailchimp) from this server, never from a client or a mail account:
 * one verified address per person, added once, with the first name. The API key is a secret in the environment;
 * the list, the tags and double opt-in are set in the CMS (Settings → Newsletter).
 */
@Injectable()
export class NewsletterService {
  /** Replaced in tests. */
  static fetchImpl: typeof fetch = (...a) => fetch(...a);
  private readonly log = new Logger('Newsletter');
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly config: ConfigService) {}

  get keyConfigured() { return /^[\w-]+-[a-z]+\d+$/i.test(env.MAILCHIMP_API_KEY) || (!!env.MAILCHIMP_API_KEY && !!env.MAILCHIMP_BASE_URL); }

  private base() {
    if (env.MAILCHIMP_BASE_URL) return env.MAILCHIMP_BASE_URL.replace(/\/$/, '');
    return `https://${env.MAILCHIMP_API_KEY.split('-').pop()}.api.mailchimp.com`;
  }

  async settings(): Promise<NewsletterSettings> {
    return (await this.config.get<NewsletterSettings>('newsletter')).value;
  }

  /** Adds (or updates) one address on the list. Mailchimp's PUT by subscriber hash is idempotent. */
  async subscribe(s: NewsletterSettings, p: { email: string; firstName?: string | null; lastName?: string | null }): Promise<{ ok: true } | { ok: false; error: string; permanent: boolean }> {
    const hash = createHash('md5').update(p.email.toLowerCase()).digest('hex');
    let r: Response;
    try {
      r = await NewsletterService.fetchImpl(`${this.base()}/3.0/lists/${encodeURIComponent(s.listId)}/members/${hash}`, {
        method: 'PUT', signal: AbortSignal.timeout(8000),
        headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`wehum:${env.MAILCHIMP_API_KEY}`).toString('base64')}` },
        body: JSON.stringify({
          email_address: p.email.toLowerCase(), status_if_new: s.doubleOptIn ? 'pending' : 'subscribed', tags: s.tags,
          merge_fields: { ...(p.firstName ? { FNAME: p.firstName } : {}), ...(p.lastName ? { LNAME: p.lastName } : {}) },
        }),
      });
    } catch (e) { return { ok: false, error: (e as Error).message.slice(0, 120), permanent: false }; }
    if (r.ok) return { ok: true };
    const body = (await r.json().catch(() => ({}))) as { title?: string; detail?: string };
    const error = `${r.status} ${body.title ?? ''} ${body.detail ?? ''}`.trim().slice(0, 120);
    // 4xx other than rate limit / auth: this address will never go through (invalid, was removed on purpose); do not retry it forever
    return { ok: false, error, permanent: r.status >= 400 && r.status < 500 && ![401, 403, 429].includes(r.status) };
  }

  /** Every minute: verified, non-guest people who are not on the list yet (this also back-fills everyone who signed up before). */
  async syncPending(limit = 100): Promise<number> {
    const s = await this.settings();
    if (!s.enabled || !s.listId || !this.keyConfigured) return 0;
    const rows = await this.db.select({ id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName }).from(users)
      .where(and(isNull(users.newsletterSyncedAt), isNotNull(users.email), isNotNull(users.emailVerifiedAt), eq(users.isGuest, false), isNull(users.deletedAt), sql`${users.email} not like '%@demo.wehum'`)).limit(limit);
    let done = 0;
    for (const u of rows) {
      const r = await this.subscribe(s, { email: u.email!, firstName: u.firstName, lastName: u.lastName });
      if (r.ok) { await this.db.update(users).set({ newsletterSyncedAt: new Date(), newsletterError: null }).where(eq(users.id, u.id)); done++; }
      else if (r.permanent) await this.db.update(users).set({ newsletterSyncedAt: new Date(), newsletterError: r.error }).where(eq(users.id, u.id));
      else { this.log.warn(`newsletter: ${r.error}`); break; } // Mailchimp is down or limiting us: try again next minute
    }
    return done;
  }

  async status() {
    const s = await this.settings();
    const [c] = (await this.db.execute(sql`SELECT count(*) FILTER (WHERE newsletter_synced_at IS NOT NULL AND newsletter_error IS NULL)::int AS synced,
        count(*) FILTER (WHERE newsletter_synced_at IS NULL AND email IS NOT NULL AND email_verified_at IS NOT NULL AND NOT is_guest AND deleted_at IS NULL AND email NOT LIKE '%@demo.wehum')::int AS pending,
        count(*) FILTER (WHERE newsletter_error IS NOT NULL)::int AS failed FROM users`)).rows as { synced: number; pending: number; failed: number }[];
    return { enabled: s.enabled, keyConfigured: this.keyConfigured, listId: s.listId || null, ...c! };
  }
}

@ApiTags('Admin Settings')
@ApiBearerAuth()
@AdminRoles(...MANAGER_ROLES)
@Controller('v1/admin/newsletter')
export class NewsletterAdminController {
  constructor(private readonly svc: NewsletterService) {}
  @Get('status') status() { return this.svc.status(); }
  /** "Sync now": does not wait for the next minute. */
  @HttpCode(200) @Post('sync') async sync(@Body() _b: unknown) { const added = await this.svc.syncPending(500);
    return { added, ...(await this.svc.status()) }; }
}
