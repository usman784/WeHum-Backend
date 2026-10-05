import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, OptionalAuth, Public, RateLimit, SkipVersionGate, type AppUser, type AuthedRequest } from '../../common/auth';
import { AppError } from '../../common/errors';
import { Zod } from '../../common/zod';
import { AuthService, type DeviceInfo } from './auth.service';

const tz = z.string().min(1).max(64).refine((v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }, 'Unknown time zone');
const GuestDto = z.object({
  installId: z.string().min(8).max(64),
  platform: z.enum(['ios', 'android']),
  appVersion: z.string().regex(/^\d+\.\d+\.\d+/).max(20),
  timezone: tz.default('UTC'),
  locale: z.string().max(10).default('en'),
  osVersion: z.string().max(40).optional(),
  model: z.string().max(80).optional(),
  attestation: z.string().max(4096).optional(),
});
const RefreshDto = z.object({ refreshToken: z.string().min(20) });
const LogoutDto = z.object({ refreshToken: z.string().min(20).optional() });
const SocialDto = z.object({ idToken: z.string().min(20), rawNonce: z.string().max(200).optional(), firstName: z.string().trim().max(30).optional() });
const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8, 'At least 8 characters').max(128).refine((p) => !COMMON.has(p.toLowerCase()), 'This password is too common');
const EmailLoginDto = z.object({ email, password: z.string().min(1).max(128) });
const EmailLinkDto = z.object({ email, password, firstName: z.string().trim().min(1).max(30).optional() });
const EmailOnlyDto = z.object({ email });
const TokenDto = z.object({ token: z.string().min(20) });
const ResetDto = z.object({ token: z.string().min(20), password });
const MergeDto = z.object({ mergeToken: z.string().min(20) });
const COMMON = new Set(['password', 'password1', '12345678', '123456789', 'qwertyui', 'iloveyou', '11111111', 'meditation', 'wehum123']);

const country = (req: AuthedRequest) => {
  const c = (req.headers['cf-ipcountry'] ?? req.headers['cloudfront-viewer-country'] ?? req.headers['x-country']) as string | undefined;
  return c && /^[A-Z]{2}$/.test(c) && c !== 'XX' ? c : null;
};
const deviceFrom = (req: AuthedRequest): DeviceInfo | null => {
  const installId = req.headers['x-install-id'] as string | undefined;
  const platform = req.headers['x-platform'] as 'ios' | 'android' | undefined;
  if (!installId || (platform !== 'ios' && platform !== 'android')) return null;
  return { installId: installId.slice(0, 64), platform, appVersion: String(req.headers['x-app-version'] ?? '0.0.0').slice(0, 20) };
};

@ApiTags('Auth')
@SkipVersionGate()
@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public() @RateLimit('auth', 10, 60) @Post('guest')
  @ApiOperation({ summary: 'Create or resume a guest user for this install' })
  async guest(@Body(new Zod(GuestDto)) b: z.infer<typeof GuestDto>, @Req() req: AuthedRequest) {
    const { created: _created, ...session } = await this.auth.guest(b, country(req));
    return session;
  }

  @Public() @RateLimit('refresh', 30, 60) @HttpCode(200) @Post('refresh')
  @ApiOperation({ summary: 'Rotate refresh token → new access + refresh' })
  refresh(@Body(new Zod(RefreshDto)) b: z.infer<typeof RefreshDto>) { return this.auth.refresh(b.refreshToken); }

  @ApiBearerAuth() @HttpCode(204) @Post('logout')
  async logout(@CurrentUser() u: AppUser, @Body(new Zod(LogoutDto)) b: z.infer<typeof LogoutDto>) { await this.auth.logout(u, b.refreshToken); }

  @Public() @OptionalAuth() @RateLimit('auth', 10, 60) @HttpCode(200) @Post('apple')
  @ApiOperation({ summary: 'Sign in with Apple (guest bearer optional → attach or mergeToken)' })
  apple(@Body(new Zod(SocialDto)) b: z.infer<typeof SocialDto>, @Req() req: AuthedRequest) { return this.auth.socialSignIn('apple', b, deviceFrom(req), req.user); }

  @Public() @OptionalAuth() @RateLimit('auth', 10, 60) @HttpCode(200) @Post('google')
  google(@Body(new Zod(SocialDto)) b: z.infer<typeof SocialDto>, @Req() req: AuthedRequest) { return this.auth.socialSignIn('google', b, deviceFrom(req), req.user); }

  @Public() @OptionalAuth() @RateLimit('auth', 10, 60) @HttpCode(200) @Post('email/login')
  emailLogin(@Body(new Zod(EmailLoginDto)) b: z.infer<typeof EmailLoginDto>, @Req() req: AuthedRequest) { return this.auth.emailLogin(b, req.ip, deviceFrom(req), req.user); }

  @Public() @RateLimit('auth', 10, 60) @HttpCode(202) @Post('email/magic-link')
  async magicLink(@Body(new Zod(EmailOnlyDto)) b: z.infer<typeof EmailOnlyDto>) { await this.auth.magicLink(b.email); return { sent: true }; }

  @Public() @OptionalAuth() @RateLimit('auth', 10, 60) @HttpCode(200) @Post('email/verify-link')
  verifyLink(@Body(new Zod(TokenDto)) b: z.infer<typeof TokenDto>, @Req() req: AuthedRequest) { return this.auth.verifyLink(b.token, deviceFrom(req), req.user); }

  @Public() @RateLimit('auth', 10, 60) @HttpCode(200) @Post('email/verify')
  async verifyEmail(@Body(new Zod(TokenDto)) b: z.infer<typeof TokenDto>) { await this.auth.verifyEmail(b.token); return { verified: true }; }

  @Public() @RateLimit('auth', 10, 60) @HttpCode(202) @Post('password/forgot')
  async forgot(@Body(new Zod(EmailOnlyDto)) b: z.infer<typeof EmailOnlyDto>) { await this.auth.forgot(b.email); return { sent: true }; }

  @Public() @RateLimit('auth', 10, 60) @HttpCode(200) @Post('password/reset')
  async reset(@Body(new Zod(ResetDto)) b: z.infer<typeof ResetDto>) { await this.auth.reset(b.token, b.password); return { reset: true }; }

  @ApiBearerAuth() @RateLimit('auth', 10, 60) @HttpCode(200) @Post('link/apple')
  linkApple(@CurrentUser() u: AppUser, @Body(new Zod(SocialDto)) b: z.infer<typeof SocialDto>) { return this.auth.linkSocial(u, 'apple', b); }

  @ApiBearerAuth() @RateLimit('auth', 10, 60) @HttpCode(200) @Post('link/google')
  linkGoogle(@CurrentUser() u: AppUser, @Body(new Zod(SocialDto)) b: z.infer<typeof SocialDto>) { return this.auth.linkSocial(u, 'google', b); }

  @ApiBearerAuth() @RateLimit('auth', 10, 60) @HttpCode(200) @Post('link/email')
  linkEmail(@CurrentUser() u: AppUser, @Body(new Zod(EmailLinkDto)) b: z.infer<typeof EmailLinkDto>) {
    if (!u.isGuest) throw new AppError('INVALID_STATE', 'Already signed in to an account');
    return this.auth.linkEmail(u, b);
  }

  @ApiBearerAuth() @HttpCode(200) @Post('merge')
  @ApiOperation({ summary: "Merge a guest's data into the signed-in account" })
  merge(@CurrentUser() u: AppUser, @Body(new Zod(MergeDto)) b: z.infer<typeof MergeDto>) { return this.auth.merge(u, b.mergeToken); }
}
