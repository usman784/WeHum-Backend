import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type Redis from 'ioredis';
import { createHash, randomBytes } from 'node:crypto';
import { generateKeyPair, importPKCS8, importSPKI, jwtVerify, SignJWT, type CryptoKey, type KeyObject } from 'jose';
import { v7 as uuid } from 'uuid';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import { refreshTokens, users } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { K, REDIS } from '../../infra/redis';

type Key = CryptoKey | KeyObject | Uint8Array;
export type Aud = 'wehum-app' | 'wehum-cms';

export interface AppClaims { sub: string; gst: boolean; prm: boolean; iid?: string; ver: number; cty?: string | null }
export interface AdminClaims { sub: string; role: 'owner' | 'admin' | 'editor' | 'moderator'; name: string; ver: number }

export const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');
export const opaqueToken = () => randomBytes(32).toString('base64url');

/**
 * Access JWT (EdDSA/Ed25519, kid rotation) + rotating opaque refresh tokens with reuse detection (spec §5.2).
 */
@Injectable()
export class TokensService {
  private priv?: Key;
  private kid = env.JWT_KID;
  private pubs = new Map<string, Key>();

  constructor(@Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis) {}

  private async keys() {
    if (this.priv) return this.priv;
    if (env.JWT_PRIVATE_KEY_B64) {
      this.priv = await importPKCS8(Buffer.from(env.JWT_PRIVATE_KEY_B64, 'base64').toString(), 'EdDSA');
      const list = JSON.parse(Buffer.from(env.JWT_PUBLIC_KEYS_B64 || 'W10=', 'base64').toString()) as { kid: string; pem: string }[];
      for (const k of list) this.pubs.set(k.kid, await importSPKI(k.pem, 'EdDSA'));
    } else {
      if (env.NODE_ENV === 'production' || env.NODE_ENV === 'staging') throw new Error('JWT keys missing (run npm run keys)');
      const kp = await generateKeyPair('EdDSA', { crv: 'Ed25519' }); // dev/test only: ephemeral
      this.priv = kp.privateKey; this.kid = 'ephemeral'; this.pubs.set('ephemeral', kp.publicKey);
    }
    return this.priv;
  }

  async signAccess(claims: AppClaims | AdminClaims, aud: Aud, ttlSec = aud === 'wehum-app' ? env.ACCESS_TTL_SEC : env.ADMIN_ACCESS_TTL_SEC) {
    const key = await this.keys();
    return new SignJWT({ ...claims }).setProtectedHeader({ alg: 'EdDSA', kid: this.kid })
      .setIssuer('wehum').setAudience(aud).setSubject(claims.sub).setIssuedAt().setExpirationTime(`${ttlSec}s`).sign(key);
  }

  async verify<T>(token: string, aud: Aud): Promise<T & { exp: number }> {
    await this.keys();
    try {
      const { payload } = await jwtVerify(token, async (h) => {
        const k = this.pubs.get(h.kid ?? '');
        if (!k) throw new AppError('TOKEN_INVALID');
        return k;
      }, { issuer: 'wehum', audience: aud, algorithms: ['EdDSA'] });
      return payload as unknown as T & { exp: number };
    } catch (e) {
      throw new AppError((e as { code?: string }).code === 'ERR_JWT_EXPIRED' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID');
    }
  }

  /** Role change / disable / password reset: bumping the admin's token version invalidates every access token issued before. */
  async revokeAdminAccess(adminId: string) { await this.redis.incr(K.adminRevoked(adminId)); }

  async adminVersion(adminId: string): Promise<number> { return Number(await this.redis.get(K.adminRevoked(adminId)).catch(() => 0)) || 0; }

  /** Current token version for force-logout (Redis, falls back to DB). */
  async tokenVersion(userId: string): Promise<number> {
    const v = await this.redis.get(K.tokenVersion(userId)).catch(() => null);
    if (v !== null) return Number(v);
    const [u] = await this.db.select({ v: users.tokenVersion, del: users.deletedAt }).from(users).where(eq(users.id, userId));
    const ver = !u || u.del ? -1 : u.v;
    await this.redis.set(K.tokenVersion(userId), ver, 'EX', 3600).catch(() => null);
    return ver;
  }

  async bumpTokenVersion(userId: string) {
    const [u] = await this.db.update(users).set({ tokenVersion: sqlInc() }).where(eq(users.id, userId)).returning({ v: users.tokenVersion });
    await this.redis.del(K.tokenVersion(userId));
    await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
    return u?.v ?? 0;
  }

  /** New refresh token (new family unless given). */
  async issueRefresh(userId: string, deviceId: string | null, familyId = uuid()) {
    const token = opaqueToken();
    await this.db.insert(refreshTokens).values({
      id: uuid(), userId, familyId, deviceId, tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + env.REFRESH_TTL_DAYS * 86400_000),
    });
    return token;
  }

  /** Rotate: mark used, issue next in same family. Reuse of a used token revokes the whole family. */
  async rotate(token: string) {
    const [row] = await this.db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, sha256(token)));
    if (!row || row.revokedAt || row.expiresAt < new Date()) throw new AppError('TOKEN_INVALID');
    if (row.usedAt) {
      await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.familyId, row.familyId));
      throw new AppError('TOKEN_REUSED');
    }
    const claimed = await this.db.update(refreshTokens).set({ usedAt: new Date() })
      .where(and(eq(refreshTokens.id, row.id), isNull(refreshTokens.usedAt))).returning({ id: refreshTokens.id });
    if (!claimed.length) { // lost a race → treat as reuse
      await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.familyId, row.familyId));
      throw new AppError('TOKEN_REUSED');
    }
    const next = await this.issueRefresh(row.userId, row.deviceId, row.familyId);
    return { userId: row.userId, deviceId: row.deviceId, refreshToken: next };
  }

  async revokeFamilyOf(token: string) {
    const [row] = await this.db.select({ f: refreshTokens.familyId }).from(refreshTokens).where(eq(refreshTokens.tokenHash, sha256(token)));
    if (row) await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.familyId, row.f));
  }

  async revokeDevice(userId: string, deviceId: string) {
    await this.db.update(refreshTokens).set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), eq(refreshTokens.deviceId, deviceId), isNull(refreshTokens.revokedAt)));
  }
}

import { sql } from 'drizzle-orm';
const sqlInc = () => sql`${users.tokenVersion} + 1`;
