import { CanActivate, createParamDecorator, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type Redis from 'ioredis';
import { env } from '../config/env';
import { K, REDIS } from '../infra/redis';
import { TokensService, type AdminClaims, type AppClaims } from '../modules/auth/tokens.service';
import { ConfigService, type MainConfig } from '../modules/config/config.service';
import { AppError } from './errors';

export interface AppUser { id: string; isGuest: boolean; premium: boolean; installId?: string; country?: string | null }
export interface AdminUser { id: string; role: AdminClaims['role']; name: string }
export type AuthedRequest = FastifyRequest & { user?: AppUser; admin?: AdminUser };

const PUBLIC = 'wh:public', OPTIONAL = 'wh:optional', SCOPE = 'wh:scope', ROLES = 'wh:roles', RATE = 'wh:rate', NO_VERSION = 'wh:noversion';

/** No token needed. */
export const Public = () => SetMetadata(PUBLIC, true);
/** Token read if present (e.g. guest token on login → mergeToken). */
export const OptionalAuth = () => SetMetadata(OPTIONAL, true);
/** CMS routes: admin token + allowed roles. */
export const AdminRoles = (...roles: AdminClaims['role'][]) => (target: object, key?: string | symbol, desc?: PropertyDescriptor) => {
  SetMetadata(SCOPE, 'admin')(target, key!, desc!);
  SetMetadata(ROLES, roles)(target, key!, desc!);
};
/** Per-route rate limit (fixed window, Redis). Keyed by user id when known, else IP. */
export const RateLimit = (bucket: string, limit: number, windowSec: number) => SetMetadata(RATE, { bucket, limit, windowSec });
/** Skip the app-version gate (bootstrap, auth, time). */
export const SkipVersionGate = () => SetMetadata(NO_VERSION, true);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().user);
export const CurrentAdmin = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().admin);

const bearer = (req: FastifyRequest) => {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
};

/** Global guard 1: authentication (app or admin scope). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly tokens: TokensService) {}

  async canActivate(ctx: ExecutionContext) {
    if (ctx.getType() !== 'http') return true;
    const meta = <T>(k: string) => this.reflector.getAllAndOverride<T>(k, [ctx.getHandler(), ctx.getClass()]);
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = bearer(req);
    const isPublic = meta<boolean>(PUBLIC);
    const optional = meta<boolean>(OPTIONAL);

    if (meta<string>(SCOPE) === 'admin') {
      if (!token) throw new AppError('AUTH_REQUIRED');
      const c = await this.tokens.verify<AdminClaims>(token, 'wehum-cms');
      const roles = meta<AdminClaims['role'][]>(ROLES) ?? [];
      if (roles.length && !roles.includes(c.role)) throw new AppError('FORBIDDEN');
      req.admin = { id: c.sub, role: c.role, name: c.name };
      return true;
    }
    if (isPublic && !optional) return true;
    if (!token) { if (isPublic || optional) return true; throw new AppError('AUTH_REQUIRED'); }
    try {
      const c = await this.tokens.verify<AppClaims>(token, 'wehum-app');
      if ((await this.tokens.tokenVersion(c.sub)) !== c.ver) throw new AppError('TOKEN_INVALID');
      req.user = { id: c.sub, isGuest: c.gst, premium: c.prm, installId: c.iid, country: c.cty };
    } catch (e) {
      if (optional) return true;
      throw e;
    }
    return true;
  }
}

/** Global guard 2: rate limiting (spec §5.1). Default bucket: general 120/min. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, @Inject(REDIS) private readonly redis: Redis) {}

  async canActivate(ctx: ExecutionContext) {
    if (ctx.getType() !== 'http' || env.RATE_LIMIT_DISABLED) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (req.url.startsWith('/healthz') || req.url.startsWith('/readyz') || req.url.startsWith('/webhooks')) return true;
    const rule = this.reflector.getAllAndOverride<{ bucket: string; limit: number; windowSec: number }>(RATE, [ctx.getHandler(), ctx.getClass()])
      ?? (req.admin ? { bucket: 'admin', limit: 600, windowSec: 60 } : req.method === 'GET' ? { bucket: 'general', limit: 120, windowSec: 60 } : { bucket: 'writes', limit: 60, windowSec: 60 });
    const id = req.user?.id ?? req.admin?.id ?? req.ip;
    const key = K.rate(rule.bucket, id);
    const n = await this.redis.incr(key).catch(() => 0);
    if (n === 1) await this.redis.expire(key, rule.windowSec).catch(() => null);
    if (n > rule.limit) {
      const ttl = await this.redis.ttl(key).catch(() => rule.windowSec);
      throw new AppError('RATE_LIMITED', 'Too many requests', undefined, { 'retry-after': String(Math.max(1, ttl)) });
    }
    return true;
  }
}

const cmp = (a: string, b: string) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
};

/** Global guard 3: app-version gate + maintenance (426 UPDATE_REQUIRED / 503 MAINTENANCE) on app routes. */
@Injectable()
export class AppGateGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly config: ConfigService) {}

  async canActivate(ctx: ExecutionContext) {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.url.startsWith('/v1/') || req.url.startsWith('/v1/admin')) return true;
    if (this.reflector.getAllAndOverride<boolean>(NO_VERSION, [ctx.getHandler(), ctx.getClass()])) return true;
    const main = await this.config.value<MainConfig>('main');
    if (main.maintenance) throw new AppError('MAINTENANCE', 'WeHum is being updated. Back soon.');
    const v = req.headers['x-app-version'] as string | undefined;
    const p = req.headers['x-platform'] as 'ios' | 'android' | undefined;
    if (v && p && main.minVersion[p] && cmp(v, main.minVersion[p]) < 0) throw new AppError('UPDATE_REQUIRED', 'Please update WeHum to continue.');
    return true;
  }
}

export { cmp as compareVersions };
