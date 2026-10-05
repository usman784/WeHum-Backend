import { Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import { sha256 } from './tokens.service';

export interface SocialIdentity { provider: 'apple' | 'google'; sub: string; email: string | null; emailVerified: boolean; firstName: string | null }

const CFG = {
  apple: { jwks: 'https://appleid.apple.com/auth/keys', iss: ['https://appleid.apple.com'], aud: () => env.APPLE_BUNDLE_IDS.split(',').map((s) => s.trim()).filter(Boolean) },
  google: { jwks: 'https://www.googleapis.com/oauth2/v3/certs', iss: ['accounts.google.com', 'https://accounts.google.com'], aud: () => env.GOOGLE_CLIENT_IDS.split(',').map((s) => s.trim()).filter(Boolean) },
} as const;

/** Verifies Apple / Google id tokens against their JWKS (spec §5.2). Never trusts client-sent profile data except Apple's first-login name. */
@Injectable()
export class SocialVerifier {
  private keys: Record<'apple' | 'google', JWTVerifyGetKey> = {
    apple: createRemoteJWKSet(new URL(CFG.apple.jwks), { cooldownDuration: 60_000, cacheMaxAge: 3_600_000 }),
    google: createRemoteJWKSet(new URL(CFG.google.jwks), { cooldownDuration: 60_000, cacheMaxAge: 3_600_000 }),
  };

  /** Tests only: swap the JWKS getter. */
  useKeys(provider: 'apple' | 'google', getKey: JWTVerifyGetKey) { this.keys[provider] = getKey; }

  async verify(provider: 'apple' | 'google', idToken: string, opts: { rawNonce?: string; firstName?: string | null } = {}): Promise<SocialIdentity> {
    const c = CFG[provider];
    const aud = c.aud();
    if (!aud.length) throw new AppError('INVALID_STATE', `${provider} sign-in is not configured`);
    let p: Record<string, unknown>;
    try {
      ({ payload: p } = await jwtVerify(idToken, this.keys[provider], { issuer: [...c.iss], audience: aud }));
    } catch {
      throw new AppError('TOKEN_INVALID', `Invalid ${provider} token`);
    }
    if (provider === 'apple' && opts.rawNonce && p.nonce !== sha256(opts.rawNonce)) throw new AppError('TOKEN_INVALID', 'Nonce mismatch');
    const email = typeof p.email === 'string' ? p.email.toLowerCase() : null;
    const verified = p.email_verified === true || p.email_verified === 'true';
    const first = provider === 'google' ? (p.given_name as string | undefined) ?? null : opts.firstName ?? null;
    return { provider, sub: String(p.sub), email, emailVerified: verified, firstName: first ? first.slice(0, 30) : null };
  }
}
