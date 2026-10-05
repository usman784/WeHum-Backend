import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AdminRoles, CurrentAdmin, Public, RateLimit, type AdminUser } from '../../common/auth';
import { AppError } from '../../common/errors';
import { Zod } from '../../common/zod';
import { env, isProd } from '../../config/env';
import { AdminAuthService, type Ctx } from './admin-auth.service';
import { ALL_ROLES } from './rbac';

const COMMON = new Set(['password', 'password1', 'password123', '1234567890', 'qwertyuiop', 'letmein123', 'wehum12345', 'meditation1']);
const email = z.string().trim().toLowerCase().email().max(254);
export const adminPassword = z.string().min(10, 'At least 10 characters').max(128).refine((p) => !COMMON.has(p.toLowerCase()), 'This password is too common');
const code = z.string().regex(/^\d{6}$/, '6 digits');

const LoginDto = z.object({ email, password: z.string().min(1).max(128) });
const MfaVerifyDto = z.object({ mfaToken: z.string().min(20), code: code.optional(), recoveryCode: z.string().min(5).max(20).optional() })
  .refine((v) => !!v.code !== !!v.recoveryCode, 'Send either code or recoveryCode');
const EnrollDto = z.object({ enrollToken: z.string().min(20), code: code.optional() });
const ForgotDto = z.object({ email });
const ResetDto = z.object({ token: z.string().min(20), password: adminPassword });
const InviteDto = z.object({ token: z.string().min(20), name: z.string().trim().min(1).max(80), password: adminPassword });

const RT = 'wh_rt', CSRF = 'wh_csrf';
const ctx = (req: FastifyRequest): Ctx => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

@ApiTags('Admin Auth')
@Controller('v1/admin')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  @Public() @RateLimit('auth', 10, 60) @HttpCode(200) @Post('auth/login')
  login(@Body(new Zod(LoginDto)) b: z.infer<typeof LoginDto>, @Req() req: FastifyRequest) { return this.auth.login(b.email, b.password, ctx(req)); }

  @Public() @RateLimit('auth', 10, 60) @HttpCode(200) @Post('auth/mfa/verify')
  async verify(@Body(new Zod(MfaVerifyDto)) b: z.infer<typeof MfaVerifyDto>, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    return this.withCookies(res, await this.auth.verifyMfa(b, ctx(req)));
  }

  @Public() @RateLimit('auth', 10, 60) @HttpCode(200) @Post('auth/mfa/enroll')
  async enroll(@Body(new Zod(EnrollDto)) b: z.infer<typeof EnrollDto>, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const out = await this.auth.enroll(b, ctx(req));
    return 'refreshToken' in out ? this.withCookies(res, out) : out;
  }

  /** Cookie + double-submit CSRF (readable `wh_csrf` cookie echoed in `X-CSRF`) + origin allowlist. */
  @Public() @RateLimit('refresh', 30, 60) @HttpCode(200) @Post('auth/refresh')
  async refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const origin = req.headers.origin;
    if (origin && !env.CMS_ORIGINS.split(',').map((s) => s.trim()).includes(origin)) throw new AppError('FORBIDDEN', 'Origin not allowed');
    const rt = req.cookies?.[RT], cookieCsrf = req.cookies?.[CSRF], header = req.headers['x-csrf'];
    if (!rt) throw new AppError('AUTH_REQUIRED', 'No session');
    if (typeof header !== 'string' || !cookieCsrf || !safeEq(header, cookieCsrf)) throw new AppError('FORBIDDEN', 'CSRF check failed');
    try {
      return this.withCookies(res, await this.auth.refresh(rt, ctx(req)));
    } catch (e) {
      this.clearCookies(res);
      throw e;
    }
  }

  @AdminRoles(...ALL_ROLES) @HttpCode(204) @Post('auth/logout')
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    await this.auth.logout(req.cookies?.[RT]);
    this.clearCookies(res);
  }

  @Public() @RateLimit('auth', 10, 60) @HttpCode(202) @Post('auth/forgot')
  async forgot(@Body(new Zod(ForgotDto)) b: z.infer<typeof ForgotDto>) { await this.auth.forgot(b.email); }

  @Public() @RateLimit('auth', 10, 60) @HttpCode(200) @Post('auth/reset')
  async reset(@Body(new Zod(ResetDto)) b: z.infer<typeof ResetDto>) { await this.auth.reset(b.token, b.password); return { ok: true }; }

  @Public() @RateLimit('auth', 10, 60) @HttpCode(200) @Post('auth/accept-invite')
  acceptInvite(@Body(new Zod(InviteDto)) b: z.infer<typeof InviteDto>) { return this.auth.acceptInvite(b.token, b.name, b.password); }

  @ApiBearerAuth() @AdminRoles(...ALL_ROLES) @Get('me')
  me(@CurrentAdmin() a: AdminUser) { return this.auth.me(a.id); }

  // ───────────── cookies ─────────────
  private withCookies(res: FastifyReply, s: Awaited<ReturnType<AdminAuthService['refresh']>>) {
    const { refreshToken, refreshExpiresAt, ...body } = s;
    const base = { secure: isProd || env.NODE_ENV === 'test', sameSite: 'strict' as const, expires: refreshExpiresAt };
    res.setCookie(RT, refreshToken, { ...base, httpOnly: true, path: '/v1/admin/auth' });
    res.setCookie(CSRF, body.csrfToken, { ...base, httpOnly: false, path: '/' });
    res.header('cache-control', 'no-store');
    return body;
  }

  private clearCookies(res: FastifyReply) {
    res.clearCookie(RT, { path: '/v1/admin/auth' });
    res.clearCookie(CSRF, { path: '/' });
  }
}
