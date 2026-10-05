import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { env } from '../config/env';

/**
 * CDN URLs. Public assets (covers) are plain URLs; premium media gets an expiring HMAC signature
 * (`?exp=<unix>&sig=<base64url hmac(secret, "<key>:<exp>")>`) that the CDN edge verifies (spec §8.5).
 * Keys are versioned and immutable, so a signed URL can be cached until it expires.
 */
@Injectable()
export class CdnSigner {
  private readonly base = env.CDN_BASE_URL.replace(/\/$/, '');

  /** Absolute URLs pass through; storage keys are resolved against the CDN. */
  publicUrl(keyOrUrl: string | null | undefined): string | null {
    if (!keyOrUrl) return null;
    return /^https?:\/\//.test(keyOrUrl) ? keyOrUrl : `${this.base}/${keyOrUrl.replace(/^\//, '')}`;
  }

  signature(key: string, exp: number) {
    return createHmac('sha256', env.CDN_SIGNING_SECRET).update(`${key}:${exp}`).digest('base64url');
  }

  signedUrl(key: string, ttlSec: number, now = Date.now()) {
    const exp = Math.floor(now / 1000) + ttlSec;
    const k = key.replace(/^\//, '');
    return { url: `${this.base}/${k}?exp=${exp}&sig=${this.signature(k, exp)}`, expiresAt: new Date(exp * 1000).toISOString() };
  }
}
