import { describe, expect, it } from 'vitest';
import { CdnSigner } from './cdn';

describe('CdnSigner', () => {
  const cdn = new CdnSigner();

  it('resolves keys against the CDN and passes absolute URLs through', () => {
    expect(cdn.publicUrl('img/a.jpg')).toMatch(/\/img\/a\.jpg$/);
    expect(cdn.publicUrl('/img/a.jpg')).toBe(cdn.publicUrl('img/a.jpg'));
    expect(cdn.publicUrl('https://x.test/a.jpg')).toBe('https://x.test/a.jpg');
    expect(cdn.publicUrl(null)).toBeNull();
  });

  it('signs key + expiry deterministically and expires at now + ttl', () => {
    const now = Date.UTC(2026, 0, 1);
    const a = cdn.signedUrl('media/1/audio.m4a', 3600, now);
    const u = new URL(a.url);
    expect(u.searchParams.get('exp')).toBe(String(now / 1000 + 3600));
    expect(u.searchParams.get('sig')).toBe(cdn.signature('media/1/audio.m4a', now / 1000 + 3600));
    expect(a.expiresAt).toBe('2026-01-01T01:00:00.000Z');
    expect(cdn.signature('media/2/audio.m4a', now / 1000 + 3600)).not.toBe(u.searchParams.get('sig'));
  });
});
