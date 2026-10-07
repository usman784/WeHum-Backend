import { Injectable } from '@nestjs/common';
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import { sha256 } from './tokens.service';

export interface SocialIdentity { provider: 'apple' | 'google'; sub: string; email: string | null; emailVerified: boolean; firstName: string | null }

const CFG = {
  apple: { jwks: 'https://appleid.apple.com/auth/keys', iss: ['https://appleid.apple.com'], aud: () => env.APPLE_BUNDLE_IDS.split(',').map((s) => s.trim()).filter(Boolean) },
  google: { jwks: 'https://www.googleapis.com/oauth2/v3/certs', iss: ['accounts.google.com', 'https://accounts.google.com'], aud: () => env.GOOGLE_CLIENT_IDS.split(',').map((s) => s.trim()).filter(Boolean) },
} as const;

const FIREBASE_JWKS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const FIREBASE_PROVIDER = { apple: 'apple.com', google: 'google.com' } as const;

/** Verifies Apple / Google id tokens against their JWKS (spec §5.2). Never trusts client-sent profile data except Apple's first-login name. */
@Injectable()
export class SocialVerifier {
  private keys: Record<'apple' | 'google', JWTVerifyGetKey> = {
    apple: createRemoteJWKSet(new URL(CFG.apple.jwks), { cooldownDuration: 60_000, cacheMaxAge: 3_600_000 }),
    google: createRemoteJWKSet(new URL(CFG.google.jwks), { cooldownDuration: 60_000, cacheMaxAge: 3_600_000 }),
  };
  private firebaseKeys: JWTVerifyGetKey = createRemoteJWKSet(new URL(FIREBASE_JWKS), { cooldownDuration: 60_000, cacheMaxAge: 3_600_000 });

  /** Tests only: swap the JWKS getter. */
  useKeys(provider: 'apple' | 'google', getKey: JWTVerifyGetKey) { this.keys[provider] = getKey; }

  /** Tests only: swap the Firebase JWKS getter. */
  useFirebaseKeys(getKey: JWTVerifyGetKey) { this.firebaseKeys = getKey; }

  /**
   * Firebase Auth id token (the app signs in with Firebase). The identity is the Apple/Google subject that Firebase
   * carries in `firebase.identities`, so accounts made with direct Apple/Google tokens keep matching.
   */
  private async verifyFirebase(provider: 'apple' | 'google', idToken: string, opts: { firstName?: string | null }): Promise<SocialIdentity> {
    const project = env.FIREBASE_PROJECT_ID;
    let p: Record<string, unknown>;
    try {
      ({ payload: p } = await jwtVerify(idToken, this.firebaseKeys, { issuer: `https://securetoken.google.com/${project}`, audience: project }));
    } catch {
      throw new AppError('TOKEN_INVALID', `Invalid ${provider} token`);
    }
    const fb = (p.firebase ?? {}) as { sign_in_provider?: string; identities?: Record<string, unknown> };
    const fbProvider = FIREBASE_PROVIDER[provider];
    const subs = fb.identities?.[fbProvider];
    const sub = Array.isArray(subs) && typeof subs[0] === 'string' ? subs[0] : null;
    if (fb.sign_in_provider !== fbProvider || !sub) throw new AppError('TOKEN_INVALID', `Not a ${provider} sign-in`);
    const email = typeof p.email === 'string' ? p.email.toLowerCase() : null;
    const first = (typeof p.name === 'string' ? p.name.split(' ')[0] : null) || opts.firstName || null;
    return { provider, sub, email, emailVerified: p.email_verified === true, firstName: first ? first.slice(0, 30) : null };
  }

  async verify(provider: 'apple' | 'google', idToken: string, opts: { rawNonce?: string; firstName?: string | null } = {}): Promise<SocialIdentity> {
    let iss: unknown;
    try { iss = decodeJwt(idToken).iss; } catch { throw new AppError('TOKEN_INVALID', `Invalid ${provider} token`); }
    if (typeof iss === 'string' && iss.startsWith('https://securetoken.google.com/')) return this.verifyFirebase(provider, idToken, opts);
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
