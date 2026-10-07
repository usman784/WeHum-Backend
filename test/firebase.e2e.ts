import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SocialVerifier } from '../src/modules/auth/social.verifier';
import { PushTransport, userTopic } from '../src/modules/push/push.transport';
import { bootApp, guest, http, resetTestDb } from './helpers';

let app: NestFastifyApplication;
let sign: (claims: Record<string, unknown>, o?: { aud?: string; iss?: string }) => Promise<string>;
let ops: { op: string; topic: string; tokens: string[] }[] = [];
const PROJECT = 'wehum-a7fc5';

const fb = (provider: 'google.com' | 'apple.com', sub: string, extra: Record<string, unknown> = {}) =>
  ({ sub: `fbuid-${sub}`, email: `${sub}@example.com`, email_verified: true, firebase: { sign_in_provider: provider, identities: { [provider]: [sub] } }, ...extra });

beforeAll(async () => {
  await resetTestDb();
  app = await bootApp();
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  app.get(SocialVerifier).useFirebaseKeys(createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'fb-k', alg: 'RS256', use: 'sig' }] }));
  sign = (c, o = {}) => new SignJWT(c).setProtectedHeader({ alg: 'RS256', kid: 'fb-k' }).setIssuer(o.iss ?? `https://securetoken.google.com/${PROJECT}`).setAudience(o.aud ?? PROJECT).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  app.get(PushTransport).topicImpl = async (op, topic, tokens) => { ops.push({ op, topic, tokens }); return true; };
});
afterAll(async () => { await app?.close(); });
beforeEach(() => { ops = []; });

describe('Firebase sign-in', () => {
  it('Google through Firebase creates an account and is stable per Google subject', async () => {
    const t = await sign(fb('google.com', 'g-111', { name: 'Lena Berg' }));
    const a = await http(app).post('/v1/auth/google', { idToken: t });
    expect(a.status).toBeLessThan(300);
    const b = await http(app).post('/v1/auth/google', { idToken: await sign(fb('google.com', 'g-111')) });
    expect(b.body.data.me.id).toBe(a.body.data.me.id);
    expect(a.body.data.me.firstName).toBe('Lena');
  });

  it('Apple through Firebase works; a Google token cannot be used as Apple', async () => {
    const ok = await http(app).post('/v1/auth/apple', { idToken: await sign(fb('apple.com', 'a-222')) });
    expect(ok.status).toBeLessThan(300);
    const wrong = await http(app).post('/v1/auth/apple', { idToken: await sign(fb('google.com', 'g-333')) });
    expect(wrong.body.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects other projects and issuers', async () => {
    expect((await http(app).post('/v1/auth/google', { idToken: await sign(fb('google.com', 'x'), { aud: 'other-project' }) })).body.error.code).toBe('TOKEN_INVALID');
    expect((await http(app).post('/v1/auth/google', { idToken: await sign(fb('google.com', 'x'), { iss: 'https://securetoken.google.com/other-project' }) })).body.error.code).toBe('TOKEN_INVALID');
    expect((await http(app).post('/v1/auth/google', { idToken: 'not-a-jwt'.repeat(20) })).body.error.code).toBe('TOKEN_INVALID');
  });
});

describe('FCM user topic', () => {
  const reg = (installId: string, tok: string, pushToken: string | null) =>
    http(app).post('/v1/me/devices', { installId, platform: 'ios', appVersion: '1.0.0', pushToken }, { token: tok });

  it('subscribes on register, moves on token change, leaves on unregister and logout', async () => {
    const g = await guest(app, 'topic-inst-0001');
    const topic = userTopic(g.me.id);
    const r = await reg('topic-inst-0001', g.accessToken, 'fcm-token-aaaaaaaa');
    expect(ops).toEqual([{ op: 'subscribe', topic, tokens: ['fcm-token-aaaaaaaa'] }]);
    ops = [];
    await reg('topic-inst-0001', g.accessToken, 'fcm-token-bbbbbbbb');
    expect(ops).toEqual([{ op: 'unsubscribe', topic, tokens: ['fcm-token-aaaaaaaa'] }, { op: 'subscribe', topic, tokens: ['fcm-token-bbbbbbbb'] }]);
    ops = [];
    expect((await http(app).del(`/v1/me/devices/${r.body.data.id}`, { token: g.accessToken })).status).toBe(204);
    expect(ops).toEqual([{ op: 'unsubscribe', topic, tokens: ['fcm-token-bbbbbbbb'] }]);
    ops = [];

    await reg('topic-inst-0001', g.accessToken, 'fcm-token-cccccccc');
    ops = [];
    expect((await http(app).post('/v1/auth/logout', { refreshToken: g.refreshToken }, { token: g.accessToken })).status).toBe(204);
    expect(ops).toEqual([{ op: 'unsubscribe', topic, tokens: ['fcm-token-cccccccc'] }]);
  });

  it('moving a phone to another user leaves the old user topic', async () => {
    const a = await guest(app, 'topic-inst-0002');
    const b = await guest(app, 'topic-inst-0003');
    await reg('topic-inst-0002', a.accessToken, 'fcm-token-dddddddd');
    ops = [];
    await reg('topic-inst-0002', b.accessToken, 'fcm-token-dddddddd');
    expect(ops[0]).toEqual({ op: 'unsubscribe', topic: userTopic(a.me.id), tokens: ['fcm-token-dddddddd'] });
    expect(ops[1]).toEqual({ op: 'subscribe', topic: userTopic(b.me.id), tokens: ['fcm-token-dddddddd'] });
  });

  it('no token means no topic call', async () => {
    const g = await guest(app, 'topic-inst-0004');
    await reg('topic-inst-0004', g.accessToken, null);
    expect(ops).toEqual([]);
  });
});
