import { Inject, Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { generateSecret, generateURI, verifySync } from 'otplib';
import { randomBytes } from 'node:crypto';
import { v7 as uuid } from 'uuid';
import { AppError } from '../../common/errors';
import { env } from '../../config/env';
import { adminSessions, adminUsers, emailTokens } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { Mailer } from '../../infra/mailer';
import { K, REDIS } from '../../infra/redis';
import { opaqueToken, sha256, TokensService } from '../auth/tokens.service';
import { permissionsFor } from './rbac';
import { decryptSecret, encryptSecret } from './totp-crypto';

type Admin = typeof adminUsers.$inferSelect;
export interface Ctx { ip: string; userAgent?: string }

const LOCK_LIMIT = 5, LOCK_MIN = 15, STEP_TTL = 300, ABSOLUTE_DAYS = 7;
const RESET_TTL_MIN = 30, INVITE_TTL_DAYS = 7;

export const adminView = (a: Pick<Admin, 'id' | 'email' | 'name' | 'role' | 'mfaEnabled'>) => ({
  id: a.id, email: a.email, name: a.name, role: a.role, mfaEnabled: a.mfaEnabled, permissions: permissionsFor(a.role),
});

@Injectable()
export class AdminAuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly tokens: TokensService,
    private readonly mailer: Mailer,
  ) {}

  // ───────────── step 1: password ─────────────
  async login(email: string, password: string, ctx: Ctx) {
    const [a] = await this.db.select().from(adminUsers).where(eq(adminUsers.email, email));
    if (a?.lockedUntil && a.lockedUntil > new Date()) this.locked(a.lockedUntil);
    const ok = a?.passwordHash && a.status === 'active' ? await argon2.verify(a.passwordHash, password).catch(() => false) : (await argon2.hash('timing-equaliser'), false);
    if (!a || !ok) {
      if (a) await this.fail(a);
      throw new AppError('INVALID_CREDENTIALS', 'Email or password is wrong');
    }
    await this.db.update(adminUsers).set({ failedLogins: 0, lockedUntil: null }).where(eq(adminUsers.id, a.id));
    return this.stepFor(a);
  }

  private async stepFor(a: Admin) {
    const token = opaqueToken();
    const purpose = a.mfaEnabled ? 'mfa' : 'enroll';
    await this.redis.set(K.mfaToken(token), JSON.stringify({ adminId: a.id, purpose }), 'EX', STEP_TTL);
    return a.mfaEnabled ? { step: 'mfa' as const, mfaToken: token } : { step: 'enroll' as const, enrollToken: token };
  }

  private async stepToken(token: string, purpose: 'mfa' | 'enroll') {
    const raw = await this.redis.get(K.mfaToken(token));
    const v = raw ? (JSON.parse(raw) as { adminId: string; purpose: string; pendingSecret?: string }) : null;
    if (!v || v.purpose !== purpose) throw new AppError('TOKEN_INVALID', 'This sign-in step expired. Start again.');
    const [a] = await this.db.select().from(adminUsers).where(eq(adminUsers.id, v.adminId));
    if (!a || a.status !== 'active') throw new AppError('TOKEN_INVALID');
    if (a.lockedUntil && a.lockedUntil > new Date()) this.locked(a.lockedUntil);
    return { admin: a, state: v };
  }

  private locked(until: Date): never {
    const sec = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000));
    throw new AppError('RATE_LIMITED', 'Too many attempts. Try again in 15 minutes.', { retryAfterSec: sec }, { 'retry-after': String(sec) });
  }

  /** Every wrong password or code counts; 5 in a row lock the account for 15 minutes. */
  private async fail(a: Admin) {
    const [u] = await this.db.update(adminUsers).set({ failedLogins: sql`${adminUsers.failedLogins} + 1` }).where(eq(adminUsers.id, a.id)).returning({ n: adminUsers.failedLogins });
    if ((u?.n ?? 0) >= LOCK_LIMIT) {
      await this.db.update(adminUsers).set({ lockedUntil: new Date(Date.now() + LOCK_MIN * 60_000), failedLogins: 0 }).where(eq(adminUsers.id, a.id));
    }
  }

  // ───────────── step 2: TOTP / recovery code ─────────────
  private async totpValid(a: Admin, secret: string, code: string) {
    if (!verifySync({ secret, token: code, epochTolerance: 30 }).valid) return false;
    return (await this.redis.set(K.totpUsed(a.id, code), '1', 'EX', 90, 'NX')) === 'OK'; // a code works once
  }

  async verifyMfa(body: { mfaToken: string; code?: string; recoveryCode?: string }, ctx: Ctx) {
    const { admin: a } = await this.stepToken(body.mfaToken, 'mfa');
    let ok = false;
    if (body.code && a.totpSecret) ok = await this.totpValid(a, decryptSecret(a.totpSecret), body.code);
    else if (body.recoveryCode) {
      const h = sha256(body.recoveryCode.trim().toLowerCase());
      if (a.recoveryCodes.includes(h)) {
        const used = await this.db.update(adminUsers).set({ recoveryCodes: sql`array_remove(${adminUsers.recoveryCodes}, ${h})` })
          .where(and(eq(adminUsers.id, a.id), sql`${h} = ANY(${adminUsers.recoveryCodes})`)).returning({ id: adminUsers.id });
        ok = used.length === 1;
      }
    }
    if (!ok) { await this.fail(a); throw new AppError('MFA_REQUIRED', 'That code is not valid'); }
    await this.redis.del(K.mfaToken(body.mfaToken));
    await this.db.update(adminUsers).set({ failedLogins: 0 }).where(eq(adminUsers.id, a.id));
    return this.issueSession(a, ctx);
  }

  /** First call → secret + otpauth URI for the QR code. Second call with `code` → enables MFA, returns recovery codes + session. */
  async enroll(body: { enrollToken: string; code?: string }, ctx: Ctx) {
    const { admin: a, state } = await this.stepToken(body.enrollToken, 'enroll');
    if (!body.code) {
      const secret = state.pendingSecret ?? generateSecret();
      await this.redis.set(K.mfaToken(body.enrollToken), JSON.stringify({ ...state, pendingSecret: secret }), 'EX', STEP_TTL);
      return { secret, otpauthUri: generateURI({ issuer: 'WeHum CMS', label: a.email, secret }) };
    }
    if (!state.pendingSecret) throw new AppError('INVALID_STATE', 'Start enrollment first');
    if (!(await this.totpValid(a, state.pendingSecret, body.code))) { await this.fail(a); throw new AppError('MFA_REQUIRED', 'That code is not valid'); }
    const codes = Array.from({ length: 10 }, () => { const r = randomBytes(10).toString('hex'); return `${r.slice(0, 5)}-${r.slice(5, 10)}`; });
    await this.db.update(adminUsers).set({
      totpSecret: encryptSecret(state.pendingSecret), mfaEnabled: true, failedLogins: 0, recoveryCodes: codes.map((c) => sha256(c)),
    }).where(eq(adminUsers.id, a.id));
    await this.redis.del(K.mfaToken(body.enrollToken));
    const session = await this.issueSession({ ...a, mfaEnabled: true }, ctx);
    return { ...session, recoveryCodes: codes };
  }

  // ───────────── sessions ─────────────
  private async issueSession(a: Admin, ctx: Ctx, keep?: { expiresAt: Date }) {
    const refreshToken = opaqueToken();
    const expiresAt = keep?.expiresAt ?? new Date(Date.now() + ABSOLUTE_DAYS * 86_400_000);
    await this.db.insert(adminSessions).values({ id: uuid(), adminId: a.id, tokenHash: sha256(refreshToken), userAgent: ctx.userAgent?.slice(0, 300), ip: ctx.ip, expiresAt });
    await this.db.update(adminUsers).set({ lastSignInAt: new Date() }).where(eq(adminUsers.id, a.id));
    const accessToken = await this.tokens.signAccess({ sub: a.id, role: a.role, name: a.name, ver: await this.tokens.adminVersion(a.id) }, 'wehum-cms');
    return { accessToken, expiresIn: env.ADMIN_ACCESS_TTL_SEC, csrfToken: randomBytes(24).toString('base64url'), refreshToken, refreshExpiresAt: expiresAt, admin: adminView(a) };
  }

  /** Rotates the refresh cookie. 12 h idle / 7 d absolute; a rotated, revoked or unknown token is simply invalid. */
  async refresh(token: string, ctx: Ctx) {
    const [s] = await this.db.select().from(adminSessions).where(eq(adminSessions.tokenHash, sha256(token)));
    const idleMs = env.ADMIN_REFRESH_IDLE_HOURS * 3_600_000;
    if (!s || s.revokedAt || s.expiresAt < new Date() || s.lastUsedAt.getTime() + idleMs < Date.now()) throw new AppError('TOKEN_INVALID', 'Session expired. Sign in again.');
    const claimed = await this.db.update(adminSessions).set({ revokedAt: new Date() }).where(and(eq(adminSessions.id, s.id), isNull(adminSessions.revokedAt))).returning({ id: adminSessions.id });
    if (!claimed.length) throw new AppError('TOKEN_INVALID', 'Session expired. Sign in again.');
    const [a] = await this.db.select().from(adminUsers).where(eq(adminUsers.id, s.adminId));
    if (!a || a.status !== 'active') throw new AppError('TOKEN_INVALID', 'Session expired. Sign in again.');
    return this.issueSession(a, ctx, { expiresAt: s.expiresAt });
  }

  async logout(token: string | undefined) {
    if (token) await this.db.update(adminSessions).set({ revokedAt: new Date() }).where(and(eq(adminSessions.tokenHash, sha256(token)), isNull(adminSessions.revokedAt)));
  }

  /** Sign an admin out everywhere (disable, role change, password reset): refresh cookies die now, access tokens at their next check. */
  async revokeAll(adminId: string) {
    await this.db.update(adminSessions).set({ revokedAt: new Date() }).where(and(eq(adminSessions.adminId, adminId), isNull(adminSessions.revokedAt)));
    await this.tokens.revokeAdminAccess(adminId);
  }

  async me(adminId: string) {
    const [a] = await this.db.select().from(adminUsers).where(eq(adminUsers.id, adminId));
    if (!a || a.status !== 'active') throw new AppError('TOKEN_INVALID');
    return adminView(a);
  }

  // ───────────── email links: reset password, accept invite ─────────────
  async sendLink(a: Pick<Admin, 'id' | 'email' | 'name'>, purpose: 'admin_reset' | 'admin_invite', invitedBy?: string) {
    const token = opaqueToken();
    const ttlMs = purpose === 'admin_reset' ? RESET_TTL_MIN * 60_000 : INVITE_TTL_DAYS * 86_400_000;
    await this.db.insert(emailTokens).values({ id: uuid(), purpose, email: a.email, adminId: a.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) });
    const path = purpose === 'admin_reset' ? 'reset-password' : 'accept-invite';
    const link = `${env.ADMIN_APP_URL}/${path}?token=${token}`;
    const subject = purpose === 'admin_reset' ? 'Reset your WeHum CMS password' : 'You are invited to the WeHum CMS';
    const when = purpose === 'admin_reset' ? `${RESET_TTL_MIN} minutes` : `${INVITE_TTL_DAYS} days`;
    await this.mailer.send({ to: a.email, subject, text: `${subject}\n\n${link}\n\nThis link expires in ${when}.${invitedBy ? '' : " If you didn't ask for it, ignore this email."}` });
  }

  private async consume(purpose: 'admin_reset' | 'admin_invite', token: string) {
    const [row] = await this.db.update(emailTokens).set({ usedAt: new Date() })
      .where(and(eq(emailTokens.tokenHash, sha256(token)), eq(emailTokens.purpose, purpose), isNull(emailTokens.usedAt), sql`${emailTokens.expiresAt} > now()`)).returning();
    if (!row?.adminId) throw new AppError('TOKEN_INVALID', 'This link is invalid or has expired');
    return row.adminId;
  }

  async forgot(email: string) {
    const [a] = await this.db.select().from(adminUsers).where(and(eq(adminUsers.email, email), eq(adminUsers.status, 'active')));
    if (a) await this.sendLink(a, 'admin_reset');
  }

  async reset(token: string, password: string) {
    const adminId = await this.consume('admin_reset', token);
    await this.db.update(adminUsers).set({ passwordHash: await argon2.hash(password, { type: argon2.argon2id }), failedLogins: 0, lockedUntil: null }).where(eq(adminUsers.id, adminId));
    await this.revokeAll(adminId);
  }

  /** Invite link: sets name + password, then MFA enrollment is mandatory before the first session. */
  async acceptInvite(token: string, name: string, password: string) {
    const adminId = await this.consume('admin_invite', token);
    const [a] = await this.db.update(adminUsers).set({ name, passwordHash: await argon2.hash(password, { type: argon2.argon2id }), status: 'active' })
      .where(and(eq(adminUsers.id, adminId), eq(adminUsers.status, 'invited'))).returning();
    if (!a) throw new AppError('TOKEN_INVALID', 'This invitation is no longer valid');
    return this.stepFor(a);
  }
}
