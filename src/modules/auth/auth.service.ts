import { Inject, Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuid } from 'uuid';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import type { AppUser } from '../../common/auth';
import {
  authIdentities, dedicationHolds, dedications, devices, emailTokens, entitlements, meditations,
  programProgress, recipes, userDailyStats, users, userStats,
} from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { Mailer } from '../../infra/mailer';
import { K, REDIS } from '../../infra/redis';
import { toMe } from '../me/me.mapper';
import { SocialVerifier } from './social.verifier';
import { opaqueToken, sha256, TokensService } from './tokens.service';

export interface DeviceInfo { installId: string; platform: 'ios' | 'android'; appVersion: string; osVersion?: string; model?: string }
type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

const MERGE_TTL = 600;
const LOCK_LIMIT = 5, LOCK_SEC = 900;

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly tokens: TokensService,
    private readonly social: SocialVerifier,
    private readonly mailer: Mailer,
  ) {}

  // ───────────── sessions ─────────────

  async me(userId: string) {
    const u = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!u || u.deletedAt) throw new AppError('GONE', 'Account no longer exists');
    const [ids, ent] = await Promise.all([
      this.db.select({ provider: authIdentities.provider }).from(authIdentities).where(eq(authIdentities.userId, userId)),
      this.db.query.entitlements.findFirst({ where: eq(entitlements.userId, userId) }),
    ]);
    return toMe(u, ids, ent);
  }

  /** Access + refresh for a user on a device. */
  async session(userId: string, deviceId: string | null, installId?: string) {
    const me = await this.me(userId);
    const ver = await this.tokens.tokenVersion(userId);
    const accessToken = await this.tokens.signAccess({ sub: userId, gst: me.isGuest, prm: me.entitlement.active, iid: installId, ver, cty: me.country }, 'wehum-app');
    const refreshToken = await this.tokens.issueRefresh(userId, deviceId);
    return { accessToken, refreshToken, expiresIn: env.ACCESS_TTL_SEC, me };
  }

  private async upsertDevice(tx: Tx | DB, userId: string, d: DeviceInfo) {
    const [row] = await tx.insert(devices).values({ id: uuid(), userId, installId: d.installId, platform: d.platform, appVersion: d.appVersion, osVersion: d.osVersion, model: d.model })
      .onConflictDoUpdate({ target: devices.installId, set: { userId, platform: d.platform, appVersion: d.appVersion, osVersion: d.osVersion, model: d.model, lastSeenAt: new Date() } })
      .returning({ id: devices.id });
    return row!.id;
  }

  /** POST /v1/auth/guest — idempotent per install id. A device that belonged to a signed-in account gets a fresh guest. */
  async guest(d: DeviceInfo & { timezone: string; locale: string }, country: string | null) {
    const out = await this.db.transaction(async (tx) => {
      const [ident] = await tx.select({ userId: authIdentities.userId, isGuest: users.isGuest, deleted: users.deletedAt })
        .from(authIdentities).innerJoin(users, eq(users.id, authIdentities.userId))
        .where(and(eq(authIdentities.provider, 'device'), eq(authIdentities.providerUid, d.installId)));
      let userId = ident && ident.isGuest && !ident.deleted ? ident.userId : null;
      let created = false;
      if (!userId) {
        userId = uuid(); created = true;
        await tx.insert(users).values({ id: userId, isGuest: true, timezone: d.timezone, locale: d.locale, country });
        await tx.insert(userStats).values({ userId });
        await tx.insert(authIdentities).values({ id: uuid(), userId, provider: 'device', providerUid: d.installId })
          .onConflictDoUpdate({ target: [authIdentities.provider, authIdentities.providerUid], set: { userId } });
      } else {
        await tx.update(users).set({ lastActiveAt: new Date(), timezone: d.timezone }).where(eq(users.id, userId));
      }
      const deviceId = await this.upsertDevice(tx, userId, d);
      return { userId, deviceId, created };
    });
    // the CMS Users list shows "N new"; after the commit, so the person exists when the screen reloads
    if (out.created) void this.redis.publish('events', JSON.stringify({ topic: 'users:new', payload: { count: 1 } })).catch(() => null);
    return { ...(await this.session(out.userId, out.deviceId, d.installId)), created: out.created };
  }

  async refresh(refreshToken: string) {
    const r = await this.tokens.rotate(refreshToken);
    const me = await this.me(r.userId);
    const ver = await this.tokens.tokenVersion(r.userId);
    const [dev] = r.deviceId ? await this.db.select({ iid: devices.installId }).from(devices).where(eq(devices.id, r.deviceId)) : [];
    const accessToken = await this.tokens.signAccess({ sub: r.userId, gst: me.isGuest, prm: me.entitlement.active, iid: dev?.iid, ver, cty: me.country }, 'wehum-app');
    return { accessToken, refreshToken: r.refreshToken, expiresIn: env.ACCESS_TTL_SEC, me };
  }

  async logout(user: AppUser, refreshToken?: string) {
    if (refreshToken) await this.tokens.revokeFamilyOf(refreshToken);
    if (user.installId) {
      const [dev] = await this.db.update(devices).set({ pushToken: null }).where(and(eq(devices.installId, user.installId), eq(devices.userId, user.id))).returning({ id: devices.id });
      if (dev) await this.tokens.revokeDevice(user.id, dev.id);
    }
  }

  // ───────────── identities ─────────────

  private async findIdentity(provider: 'apple' | 'google' | 'email', providerUid: string) {
    const [row] = await this.db.select({ userId: authIdentities.userId, hash: authIdentities.passwordHash, deleted: users.deletedAt })
      .from(authIdentities).innerJoin(users, eq(users.id, authIdentities.userId))
      .where(and(eq(authIdentities.provider, provider), eq(authIdentities.providerUid, providerUid)));
    return row && !row.deleted ? row : null;
  }

  /** Turn the caller (guest) into an account by attaching an identity. */
  private async attach(tx: Tx, userId: string, provider: 'apple' | 'google' | 'email', providerUid: string, extra: { email?: string | null; emailVerified?: boolean; firstName?: string | null; passwordHash?: string }) {
    await tx.insert(authIdentities).values({ id: uuid(), userId, provider, providerUid, passwordHash: extra.passwordHash });
    const patch: Partial<typeof users.$inferInsert> = { isGuest: false };
    if (extra.email) {
      const [clash] = await tx.select({ id: users.id }).from(users).where(and(eq(users.email, extra.email), sql`${users.id} <> ${userId}`));
      if (!clash) { patch.email = extra.email; if (extra.emailVerified) patch.emailVerifiedAt = new Date(); }
    }
    const [cur] = await tx.select({ firstName: users.firstName }).from(users).where(eq(users.id, userId));
    if (!cur?.firstName && extra.firstName) patch.firstName = extra.firstName;
    await tx.update(users).set(patch).where(eq(users.id, userId));
  }

  private async newAccount(tx: Tx, extra: { email?: string | null; emailVerified?: boolean; firstName?: string | null; timezone?: string }) {
    const id = uuid();
    await tx.insert(users).values({ id, isGuest: false, email: extra.email ?? null, emailVerifiedAt: extra.emailVerified ? new Date() : null, firstName: extra.firstName ?? null, timezone: extra.timezone ?? 'UTC' });
    await tx.insert(userStats).values({ userId: id });
    return id;
  }

  private async mergeTokenFor(guestId: string) {
    const t = opaqueToken();
    await this.redis.set(K.mergeToken(t), guestId, 'EX', MERGE_TTL);
    return t;
  }

  /**
   * Sign in with Apple/Google. Caller may be a guest (bearer):
   *  - identity unknown → attached to the guest (purchases + history stay)
   *  - identity known  → signs into that account and returns mergeToken for the guest's data
   */
  async socialSignIn(provider: 'apple' | 'google', body: { idToken: string; rawNonce?: string; firstName?: string }, device: DeviceInfo | null, caller?: AppUser) {
    const id = await this.social.verify(provider, body.idToken, { rawNonce: body.rawNonce, firstName: body.firstName });
    const existing = await this.findIdentity(provider, id.sub);
    let userId: string, mergeToken: string | null = null;
    if (existing) {
      userId = existing.userId;
      if (caller?.isGuest && caller.id !== userId) mergeToken = await this.mergeTokenFor(caller.id);
    } else if (caller?.isGuest) {
      userId = caller.id;
      await this.db.transaction((tx) => this.attach(tx, userId, provider, id.sub, id));
    } else {
      userId = await this.db.transaction(async (tx) => {
        const nid = await this.newAccount(tx, id);
        await tx.insert(authIdentities).values({ id: uuid(), userId: nid, provider, providerUid: id.sub });
        return nid;
      });
    }
    return this.loginResult(userId, device, mergeToken);
  }

  /** Link an identity to the current user; 409 ACCOUNT_EXISTS + mergeToken if it belongs to someone else. */
  async linkSocial(user: AppUser, provider: 'apple' | 'google', body: { idToken: string; rawNonce?: string; firstName?: string }) {
    const id = await this.social.verify(provider, body.idToken, { rawNonce: body.rawNonce, firstName: body.firstName });
    const existing = await this.findIdentity(provider, id.sub);
    if (existing && existing.userId !== user.id) throw new AppError('ACCOUNT_EXISTS', 'This account already exists. Log in to merge.', { mergeToken: await this.mergeTokenFor(user.id), provider });
    if (!existing) await this.db.transaction((tx) => this.attach(tx, user.id, provider, id.sub, id));
    return this.reissue(user);
  }

  async linkEmail(user: AppUser, body: { email: string; password: string; firstName?: string }) {
    const email = body.email.toLowerCase();
    if (await this.findIdentity('email', email)) throw new AppError('ACCOUNT_EXISTS', 'This email already has an account. Log in to merge.', { mergeToken: await this.mergeTokenFor(user.id), provider: 'email' });
    const [taken] = await this.db.select({ id: users.id }).from(users).where(and(eq(users.email, email), sql`${users.id} <> ${user.id}`));
    if (taken) throw new AppError('ACCOUNT_EXISTS', 'This email already has an account. Log in to merge.', { mergeToken: await this.mergeTokenFor(user.id), provider: 'email' });
    const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
    await this.db.transaction((tx) => this.attach(tx, user.id, 'email', email, { email, firstName: body.firstName, passwordHash }));
    await this.sendEmailToken('verify', email, user.id);
    return this.reissue(user);
  }

  /** New tokens after the user's state changed (guest → account). */
  private async reissue(user: AppUser) {
    const [dev] = user.installId ? await this.db.select({ id: devices.id }).from(devices).where(eq(devices.installId, user.installId)) : [];
    return this.session(user.id, dev?.id ?? null, user.installId);
  }

  private async loginResult(userId: string, device: DeviceInfo | null, mergeToken: string | null) {
    const deviceId = device ? await this.upsertDevice(this.db, userId, device) : null;
    await this.db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, userId));
    return { ...(await this.session(userId, deviceId, device?.installId)), mergeToken };
  }

  async emailLogin(body: { email: string; password: string }, ip: string, device: DeviceInfo | null, caller?: AppUser) {
    const email = body.email.toLowerCase();
    const lockKey = K.loginFail(`${email}|${ip}`);
    if (Number(await this.redis.get(lockKey)) >= LOCK_LIMIT) throw new AppError('RATE_LIMITED', 'Too many attempts. Try again in 15 minutes.', undefined, { 'retry-after': String(LOCK_SEC) });
    const ident = await this.findIdentity('email', email);
    const ok = ident?.hash ? await argon2.verify(ident.hash, body.password) : (await argon2.hash('timing-equaliser'), false);
    if (!ok || !ident) {
      const n = await this.redis.incr(lockKey);
      if (n === 1) await this.redis.expire(lockKey, LOCK_SEC);
      throw new AppError('INVALID_CREDENTIALS', 'Email or password is wrong');
    }
    await this.redis.del(lockKey);
    const mergeToken = caller?.isGuest && caller.id !== ident.userId ? await this.mergeTokenFor(caller.id) : null;
    return this.loginResult(ident.userId, device, mergeToken);
  }

  // ───────────── email tokens (magic link, verify, reset) ─────────────

  private async sendEmailToken(purpose: 'verify' | 'magic_link' | 'password_reset', email: string, userId?: string) {
    const cool = K.emailCooldown(email, purpose);
    if (!(await this.redis.set(cool, '1', 'EX', 60, 'NX'))) return; // 60 s resend cooldown (silent)
    const token = opaqueToken();
    const ttlMin = purpose === 'password_reset' ? 60 : 15;
    await this.db.insert(emailTokens).values({ id: uuid(), purpose, email, userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMin * 60_000) });
    const path = { verify: 'verify-email', magic_link: 'sign-in', password_reset: 'reset-password' }[purpose];
    const link = `${env.APP_LINK_BASE}/auth/${path}?token=${token}`;
    const subject = { verify: 'Confirm your email for WeHum', magic_link: 'Your WeHum sign-in link', password_reset: 'Reset your WeHum password' }[purpose];
    await this.mailer.send({ to: email, subject, text: `${subject}\n\n${link}\n\nThis link expires in ${ttlMin} minutes. If you didn't ask for it, ignore this email.` });
  }

  private async consumeEmailToken(purpose: 'verify' | 'magic_link' | 'password_reset', token: string) {
    const [row] = await this.db.update(emailTokens).set({ usedAt: new Date() })
      .where(and(eq(emailTokens.tokenHash, sha256(token)), eq(emailTokens.purpose, purpose), isNull(emailTokens.usedAt), sql`${emailTokens.expiresAt} > now()`))
      .returning();
    if (!row) throw new AppError('TOKEN_INVALID', 'This link has expired or was already used');
    return row;
  }

  /** Always 202 — never reveals whether an account exists. */
  async magicLink(email: string) { await this.sendEmailToken('magic_link', email.toLowerCase()); }

  async verifyLink(token: string, device: DeviceInfo | null, caller?: AppUser) {
    const row = await this.consumeEmailToken('magic_link', token);
    const ident = await this.findIdentity('email', row.email);
    let userId: string, mergeToken: string | null = null;
    if (ident) {
      userId = ident.userId;
      await this.db.update(users).set({ emailVerifiedAt: new Date() }).where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
      if (caller?.isGuest && caller.id !== userId) mergeToken = await this.mergeTokenFor(caller.id);
    } else if (caller?.isGuest) {
      userId = caller.id;
      await this.db.transaction((tx) => this.attach(tx, userId, 'email', row.email, { email: row.email, emailVerified: true }));
    } else {
      userId = await this.db.transaction(async (tx) => {
        const nid = await this.newAccount(tx, { email: row.email, emailVerified: true });
        await tx.insert(authIdentities).values({ id: uuid(), userId: nid, provider: 'email', providerUid: row.email });
        return nid;
      });
    }
    return this.loginResult(userId, device, mergeToken);
  }

  async verifyEmail(token: string) {
    const row = await this.consumeEmailToken('verify', token);
    await this.db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.email, row.email));
  }

  async forgot(email: string) {
    const e = email.toLowerCase();
    if (await this.findIdentity('email', e)) await this.sendEmailToken('password_reset', e);
  }

  async reset(token: string, password: string) {
    const row = await this.consumeEmailToken('password_reset', token);
    const ident = await this.findIdentity('email', row.email);
    if (!ident) throw new AppError('TOKEN_INVALID');
    await this.db.update(authIdentities).set({ passwordHash: await argon2.hash(password, { type: argon2.argon2id }) })
      .where(and(eq(authIdentities.provider, 'email'), eq(authIdentities.providerUid, row.email)));
    await this.tokens.bumpTokenVersion(ident.userId); // signs out every device
  }

  // ───────────── merge ─────────────

  /** POST /v1/auth/merge — move a guest's data into the signed-in account, then delete the guest (spec §5.2). */
  async merge(account: AppUser, mergeToken: string) {
    if (account.isGuest) throw new AppError('ACCOUNT_REQUIRED', 'Sign in to an account first');
    const guestId = await this.redis.getdel(K.mergeToken(mergeToken));
    if (!guestId) throw new AppError('TOKEN_INVALID', 'Merge link expired');
    if (guestId === account.id) return { merged: false };
    const a = account.id;
    const moved = await this.db.transaction(async (tx) => {
      const [g] = await tx.select().from(users).where(eq(users.id, guestId)).for('update');
      if (!g || !g.isGuest) throw new AppError('INVALID_STATE', 'Nothing to merge');
      const m = await tx.update(meditations).set({ userId: a }).where(eq(meditations.userId, guestId)).returning({ id: meditations.id });
      await tx.update(recipes).set({ userId: a }).where(eq(recipes.userId, guestId));
      await tx.update(dedications).set({ userId: a }).where(eq(dedications.userId, guestId));
      await tx.execute(sql`INSERT INTO program_progress (user_id, program_id, started_at, current_day, completed_days, completed_at)
        SELECT ${a}, program_id, started_at, current_day, completed_days, completed_at FROM program_progress WHERE user_id = ${guestId}
        ON CONFLICT (user_id, program_id) DO NOTHING`);
      await tx.execute(sql`INSERT INTO user_daily_stats (user_id, local_date, minutes, meditations, group_count)
        SELECT ${a}, local_date, minutes, meditations, group_count FROM user_daily_stats WHERE user_id = ${guestId}
        ON CONFLICT (user_id, local_date) DO UPDATE SET minutes = user_daily_stats.minutes + EXCLUDED.minutes,
          meditations = user_daily_stats.meditations + EXCLUDED.meditations, group_count = user_daily_stats.group_count + EXCLUDED.group_count`);
      await tx.execute(sql`UPDATE user_stats s SET minutes_total = s.minutes_total + g.minutes_total, meditations_total = s.meditations_total + g.meditations_total,
          group_total = s.group_total + g.group_total, dedications_total = s.dedications_total + g.dedications_total,
          first_meditation_at = LEAST(s.first_meditation_at, g.first_meditation_at), last_meditation_at = GREATEST(s.last_meditation_at, g.last_meditation_at)
        FROM user_stats g WHERE s.user_id = ${a} AND g.user_id = ${guestId}`);
      await tx.execute(sql`INSERT INTO dedication_holds (dedication_id, user_id, created_at) SELECT dedication_id, ${a}, created_at FROM dedication_holds WHERE user_id = ${guestId} ON CONFLICT DO NOTHING`);
      // Guest's purchase moves only if the account has none (RevenueCat transfer will confirm via webhook).
      const [ge] = await tx.select().from(entitlements).where(eq(entitlements.userId, guestId));
      const [ae] = await tx.select().from(entitlements).where(eq(entitlements.userId, a));
      if (ge?.active && !ae?.active) {
        const { userId: _u, updatedAt: _t, ...rest } = ge;
        await tx.insert(entitlements).values({ ...rest, userId: a }).onConflictDoUpdate({ target: entitlements.userId, set: rest });
      }
      await tx.update(devices).set({ userId: a }).where(eq(devices.userId, guestId));
      await tx.update(authIdentities).set({ userId: a }).where(and(eq(authIdentities.userId, guestId), eq(authIdentities.provider, 'device')));
      await tx.delete(users).where(eq(users.id, guestId));
      return m.length;
    });
    await this.redis.set(K.tokenVersion(guestId), -1, 'EX', 86400);
    return { merged: true, meditationsMoved: moved };
  }
}

// keep tree-shakers honest about tables used only in raw SQL
void programProgress; void userDailyStats; void dedicationHolds;
