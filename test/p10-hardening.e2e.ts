import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { AttestationService, checkIntegrityVerdict, decodeCbor, verifyAppAttest } from '../src/modules/auth/attestation';
import { bootApp, clearRates, http, resetTestDb } from './helpers';

let app: NestFastifyApplication;
const sha = (b: Buffer) => createHash('sha256').update(b).digest();
const install = () => `inst-${Math.random().toString(36).slice(2, 12)}`;
const guestBody = (platform: 'ios' | 'android', attestation?: unknown, installId = install()) => ({ installId, platform, appVersion: '1.0.0', timezone: 'UTC', attestation });

// ───────────── a tiny CBOR encoder for the test's App Attest object
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) =>
    n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : n < 65536 ? Buffer.from([(major << 5) | 25, n >> 8, n & 255]) : Buffer.concat([Buffer.from([(major << 5) | 26]), Buffer.from([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255])]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const e = Object.entries(v as Record<string, unknown>);
  return Buffer.concat([head(5, e.length), ...e.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

/** A complete App Attest object made with openssl: root → intermediate → credential certificate with the nonce. */
function makeAppAttest(appId: string, challenge: string) {
  const dir = mkdtempSync(join(tmpdir(), 'attest-'));
  const ssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  for (const k of ['root', 'int', 'leaf']) ssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${k}.key`);
  writeFileSync(join(dir, 'ca.ext'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  ssl('req', '-x509', '-new', '-key', 'root.key', '-subj', '/CN=Test App Attestation Root CA', '-days', '30', '-out', 'root.pem');
  ssl('req', '-new', '-key', 'int.key', '-subj', '/CN=Test App Attestation CA 1', '-out', 'int.csr');
  ssl('x509', '-req', '-in', 'int.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-days', '30', '-extfile', 'ca.ext', '-out', 'int.pem');

  const leafPub = createPublicKey(readFileSync(join(dir, 'leaf.key'))).export({ format: 'jwk' }) as { x: string; y: string };
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(leafPub.x, 'base64url'), Buffer.from(leafPub.y, 'base64url')]);
  const keyId = sha(point);
  const authData = Buffer.concat([sha(Buffer.from(appId)), Buffer.from([0x41]), Buffer.alloc(4), Buffer.from('appattestdevelop', 'latin1'), Buffer.from([0, keyId.length]), keyId]);
  const nonce = sha(Buffer.concat([authData, sha(Buffer.from(challenge))]));
  writeFileSync(join(dir, 'leaf.ext'), `1.2.840.113635.100.8.2=DER:3024A1220420${nonce.toString('hex').toUpperCase()}\n`);
  ssl('req', '-new', '-key', 'leaf.key', '-subj', '/CN=credential', '-out', 'leaf.csr');
  ssl('x509', '-req', '-in', 'leaf.csr', '-CA', 'int.pem', '-CAkey', 'int.key', '-CAcreateserial', '-days', '30', '-extfile', 'leaf.ext', '-out', 'leaf.pem');

  const der = (f: string) => new X509Certificate(readFileSync(join(dir, f))).raw;
  const object = cbor({ fmt: 'apple-appattest', attStmt: { x5c: [der('leaf.pem'), der('int.pem')], receipt: Buffer.from('r') }, authData });
  return { root: new X509Certificate(readFileSync(join(dir, 'root.pem'))), keyId: keyId.toString('base64'), object: object.toString('base64') };
}

const verdict = (challenge: string, over: Record<string, unknown> = {}) => ({
  requestDetails: { requestPackageName: env.ANDROID_PACKAGE, requestHash: challenge, timestampMillis: String(Date.now()) },
  appIntegrity: { appRecognitionVerdict: 'PLAY_RECOGNIZED', packageName: env.ANDROID_PACKAGE },
  deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
  ...over,
});

beforeAll(async () => {
  await resetTestDb();
  app = await bootApp();
});
beforeEach(() => clearRates());
afterEach(() => { env.ATTESTATION_MODE = 'off'; });
afterAll(async () => { await app?.close(); });

describe('P10 metrics', () => {
  it('GET /metrics lists the spec’s metrics; request durations are recorded by route pattern', async () => {
    await http(app).get('/healthz');
    await http(app).get('/v1/catalog');
    const r = await http(app).get('/metrics');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/plain/);
    const text = String(r.body);
    for (const name of ['http_request_duration_seconds', 'socket_connections', 'bullmq_queue_depth', 'outbox_lag_ms', 'rc_webhook_total', 'push_sent_total', 'db_pool_in_use', 'presence_tick_lag_ms', 'attestation_total'])
      expect(text, name).toContain(name);
    expect(text).toMatch(/http_request_duration_seconds_count\{[^}]*route="\/healthz"/);
    expect(text).not.toMatch(/route="\/v1\/catalog\?/); // patterns, never raw URLs
  });

  it('with METRICS_TOKEN set, the bearer token is required', async () => {
    env.METRICS_TOKEN = 'scrape-secret';
    try {
      expect((await http(app).get('/metrics')).status).toBe(401);
      expect((await http(app).get('/metrics', { headers: { authorization: 'Bearer wrong-secret!' } })).status).toBe(401);
      expect((await http(app).get('/metrics', { headers: { authorization: 'Bearer scrape-secret' } })).status).toBe(200);
    } finally {
      env.METRICS_TOKEN = '';
    }
  });
});

describe('P10 attestation on guest create', () => {
  it('off (default): no proof needed', async () => {
    expect((await http(app).post('/v1/auth/guest', guestBody('ios'))).status).toBe(201);
  });

  it('enforce: a new install without a proof is refused; an existing install resumes without one', async () => {
    const id = install();
    expect((await http(app).post('/v1/auth/guest', guestBody('android', undefined, id))).status).toBe(201); // created while off
    env.ATTESTATION_MODE = 'enforce';
    const r = await http(app).post('/v1/auth/guest', guestBody('android'));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('ATTESTATION_FAILED');
    expect((await http(app).post('/v1/auth/guest', guestBody('android', undefined, id))).status).toBe(201);
  });

  it('Android: a valid Play Integrity verdict for this challenge passes; the challenge works once', async () => {
    env.ATTESTATION_MODE = 'enforce';
    env.PLAY_INTEGRITY_SA_B64 = Buffer.from(JSON.stringify({ client_email: 'sa@test.iam', private_key: testKey() })).toString('base64');
    const svc = app.get(AttestationService);
    let seen = '';
    svc.fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 'g', expires_in: 3600 }));
      seen = JSON.parse(String(init!.body)).integrity_token;
      return new Response(JSON.stringify({ tokenPayloadExternal: verdict(seen.split(':')[1]!) }));
    }) as typeof fetch;
    const { challenge } = (await http(app).post('/v1/auth/attest/challenge')).body.data;
    const ok = await http(app).post('/v1/auth/guest', guestBody('android', { challenge, token: `play-token:${challenge}` }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(seen).toBe(`play-token:${challenge}`);
    const again = await http(app).post('/v1/auth/guest', guestBody('android', { challenge, token: `play-token:${challenge}` }));
    expect(again.status).toBe(403); // used challenge
  });

  it('monitor: a bad proof is counted but not blocked', async () => {
    env.ATTESTATION_MODE = 'monitor';
    const r = await http(app).post('/v1/auth/guest', guestBody('ios', { challenge: 'x'.repeat(20), keyId: 'k'.repeat(20), object: 'o'.repeat(20) }));
    expect(r.status).toBe(201);
    expect(String((await http(app).get('/metrics')).body)).toMatch(/attestation_total\{[^}]*platform="ios"[^}]*result="failed_allowed"[^}]*\} [1-9]/);
  });

  it('iOS: a real App Attest object (made with openssl) passes; a different challenge or app id fails', async () => {
    env.ATTESTATION_MODE = 'enforce';
    env.APPLE_TEAM_ID = 'TEAM123456';
    const appId = `TEAM123456.${env.APPLE_BUNDLE_IDS.split(',')[0]}`;
    const { challenge } = (await http(app).post('/v1/auth/attest/challenge')).body.data;
    const att = makeAppAttest(appId, challenge);
    app.get(AttestationService).appleRoot = att.root;
    expect(verifyAppAttest({ ...att, challenge: 'another-challenge-value' }, appId, att.root)).toBe('nonce does not match the challenge');
    expect(verifyAppAttest({ ...att, challenge }, 'OTHER.app', att.root)).toMatch(/nonce|app id/);
    const r = await http(app).post('/v1/auth/guest', guestBody('ios', { challenge, keyId: att.keyId, object: att.object }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });
});

describe('P10 data lifecycle', () => {
  it('published outbox rows older than 7 days are removed; unpublished ones never', async () => {
    const { Client } = await import('pg');
    const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
    await db.query(`INSERT INTO outbox_events (topic, payload, created_at, published_at) VALUES ('t', '{}', now() - interval '9 days', now() - interval '8 days'), ('t', '{}', now() - interval '9 days', NULL), ('t', '{}', now(), now())`);
    const before = Number((await db.query(`SELECT count(*) FROM outbox_events`)).rows[0].count);
    const { AnalyticsService } = await import('../src/modules/analytics/analytics.service');
    const out = await app.get(AnalyticsService).lifecycle();
    expect(out.outbox).toBeGreaterThanOrEqual(1);
    const left = await db.query(`SELECT count(*) FILTER (WHERE published_at IS NULL AND created_at < now() - interval '8 days')::int AS stuck FROM outbox_events`);
    expect(left.rows[0].stuck).toBeGreaterThanOrEqual(1);
    expect(Number((await db.query(`SELECT count(*) FROM outbox_events`)).rows[0].count)).toBe(before - out.outbox);
    await db.end();
  });
});

describe('attestation helpers', () => {
  it('CBOR decodes maps, arrays, strings, bytes and ints', () => {
    expect(decodeCbor(cbor({ a: [Buffer.from([1, 2]), 'x'], b: 'hello' }))).toEqual({ a: [Buffer.from([1, 2]), 'x'], b: 'hello' });
  });
  it('Play Integrity verdict checks', () => {
    const c = 'challenge-123456';
    expect(checkIntegrityVerdict(verdict(c), c, env.ANDROID_PACKAGE)).toBeNull();
    expect(checkIntegrityVerdict(verdict('other'), c, env.ANDROID_PACKAGE)).toBe('challenge does not match');
    expect(checkIntegrityVerdict(verdict(c, { appIntegrity: { appRecognitionVerdict: 'UNRECOGNIZED_VERSION' } }), c, env.ANDROID_PACKAGE)).toBe('app not recognized by Play');
    expect(checkIntegrityVerdict(verdict(c, { deviceIntegrity: { deviceRecognitionVerdict: [] } }), c, env.ANDROID_PACKAGE)).toBe('device does not meet integrity');
    expect(checkIntegrityVerdict(verdict(c), c, 'com.other')).toBe('wrong package');
  });
});

/** An RSA key in PKCS#8 for the fake Google service account. */
function testKey() {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}
