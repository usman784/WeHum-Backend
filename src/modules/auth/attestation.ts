import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import { authIdentities } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { metrics } from '../../infra/metrics';
import { REDIS } from '../../infra/redis';

/**
 * Abuse protection on guest create (backend spec §P10): iOS App Attest, Android Play Integrity. The app first asks
 * for a one-time challenge, then sends the platform's proof with `POST /v1/auth/guest`. ATTESTATION_MODE:
 * - off: nothing is checked;
 * - monitor: checked and counted (`attestation_total`), never blocks (roll-out);
 * - enforce: a new install without a valid proof gets 403 ATTESTATION_FAILED.
 * Resuming an existing install never asks again.
 */
export const AttestationDto = z.union([
  z.object({ challenge: z.string().min(16).max(100), keyId: z.string().min(16).max(200), object: z.string().min(16).max(12_000) }).strict(),
  z.object({ challenge: z.string().min(16).max(100), token: z.string().min(16).max(12_000) }).strict(),
]);
export type Attestation = z.infer<typeof AttestationDto>;
const CHALLENGE_TTL_SEC = 300;
const sha256 = (...parts: Buffer[]) => createHash('sha256').update(Buffer.concat(parts)).digest();
const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// ───────────── minimal CBOR (RFC 8949) for the App Attest object: maps, arrays, byte/text strings, unsigned ints
export function decodeCbor(buf: Buffer): unknown {
  let i = 0;
  const len = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return buf[i++]!;
    if (info === 25) { const v = buf.readUInt16BE(i); i += 2; return v; }
    if (info === 26) { const v = buf.readUInt32BE(i); i += 4; return v; }
    if (info === 27) { const v = Number(buf.readBigUInt64BE(i)); i += 8; return v; }
    throw new Error('CBOR: indefinite lengths are not used by App Attest');
  };
  const item = (): unknown => {
    const b = buf[i++];
    if (b === undefined) throw new Error('CBOR: unexpected end');
    const major = b >> 5, info = b & 31;
    if (major === 0) return len(info);
    if (major === 1) return -1 - len(info);
    if (major === 2) { const n = len(info); const v = buf.subarray(i, i + n); i += n; return Buffer.from(v); }
    if (major === 3) { const n = len(info); const v = buf.toString('utf8', i, i + n); i += n; return v; }
    if (major === 4) { const n = len(info); return Array.from({ length: n }, item); }
    if (major === 5) { const n = len(info); const m: Record<string, unknown> = {}; for (let k = 0; k < n; k++) { const key = String(item()); m[key] = item(); } return m; }
    if (major === 7 && (info === 20 || info === 21)) return info === 21;
    if (major === 7 && info === 22) return null;
    throw new Error(`CBOR: type ${major}/${info} not supported`);
  };
  return item();
}

/** The App Attest nonce: extension 1.2.840.113635.100.8.2 of the credential certificate, a 32-byte OCTET STRING. */
function nonceOf(cert: X509Certificate): Buffer | null {
  const der = cert.raw;
  const oid = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02]);
  const at = der.indexOf(oid);
  if (at < 0) return null;
  const inner = der.indexOf(Buffer.from([0x04, 0x20]), at + oid.length); // the innermost OCTET STRING (32 bytes)
  return inner < 0 || inner > at + 40 ? null : der.subarray(inner + 2, inner + 34);
}

/**
 * Apple's checks for an attestation object (developer.apple.com: "Validating apps that connect to your server").
 * `root` is Apple's App Attestation Root CA. Returns null when valid, else the reason.
 */
export function verifyAppAttest(a: { keyId: string; object: string; challenge: string }, appId: string, root: X509Certificate): string | null {
  let att: { fmt?: string; attStmt?: { x5c?: Buffer[] }; authData?: Buffer };
  try { att = decodeCbor(b64(a.object)) as typeof att; } catch (e) { return `not CBOR: ${(e as Error).message}`; }
  if (att.fmt !== 'apple-appattest' || !att.authData || !att.attStmt?.x5c || att.attStmt.x5c.length < 2) return 'not an App Attest object';
  const [leaf, intermediate] = att.attStmt.x5c.map((d) => new X509Certificate(d)) as [X509Certificate, X509Certificate];
  // 1. the chain: credential cert ← intermediate ← Apple root
  if (!intermediate.checkIssued(root) || !intermediate.verify(root.publicKey)) return 'intermediate not issued by the Apple root';
  if (!leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey)) return 'credential certificate not issued by the intermediate';
  const now = Date.now();
  for (const c of [leaf, intermediate]) if (Date.parse(c.validFrom) > now || Date.parse(c.validTo) < now) return 'certificate out of date';
  // 2–4. nonce = SHA256(authData ‖ SHA256(challenge)) is in the credential certificate
  const nonce = sha256(att.authData, sha256(Buffer.from(a.challenge)));
  const inCert = nonceOf(leaf);
  if (!inCert || !inCert.equals(nonce)) return 'nonce does not match the challenge';
  // 5. key id = SHA256 of the credential public key (uncompressed EC point)
  const jwk = leaf.publicKey.export({ format: 'jwk' }) as { x?: string; y?: string };
  if (!jwk.x || !jwk.y) return 'credential key is not an EC key';
  const point = Buffer.concat([Buffer.from([0x04]), b64(jwk.x), b64(jwk.y)]);
  const keyId = b64(a.keyId);
  if (!sha256(point).equals(keyId)) return 'key id does not match the credential key';
  // 6–9. authenticator data: app id hash, counter 0, App Attest AAGUID, credential id = key id
  const ad = att.authData;
  if (ad.length < 55) return 'authenticator data too short';
  if (!ad.subarray(0, 32).equals(sha256(Buffer.from(appId)))) return 'wrong app id';
  if (ad.readUInt32BE(33) !== 0) return 'counter is not 0';
  const aaguid = ad.subarray(37, 53).toString('latin1');
  if (aaguid !== 'appattestdevelop' && aaguid !== 'appattest\0\0\0\0\0\0\0') return 'not an App Attest key';
  const idLen = ad.readUInt16BE(53);
  if (!ad.subarray(55, 55 + idLen).equals(keyId)) return 'credential id does not match the key id';
  return null;
}

/** The parts of a Play Integrity verdict we check. */
export type IntegrityVerdict = {
  requestDetails?: { requestPackageName?: string; requestHash?: string; nonce?: string; timestampMillis?: string };
  appIntegrity?: { appRecognitionVerdict?: string; packageName?: string };
  deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
};
export function checkIntegrityVerdict(v: IntegrityVerdict, challenge: string, pkg: string, now = Date.now()): string | null {
  const r = v.requestDetails ?? {};
  if (r.requestPackageName !== pkg) return 'wrong package';
  if (r.requestHash !== challenge && r.nonce !== challenge) return 'challenge does not match';
  if (r.timestampMillis && Math.abs(now - Number(r.timestampMillis)) > CHALLENGE_TTL_SEC * 1000) return 'verdict too old';
  if (v.appIntegrity?.appRecognitionVerdict !== 'PLAY_RECOGNIZED') return 'app not recognized by Play';
  if (!(v.deviceIntegrity?.deviceRecognitionVerdict ?? []).includes('MEETS_DEVICE_INTEGRITY')) return 'device does not meet integrity';
  return null;
}

@Injectable()
export class AttestationService {
  private readonly log = new Logger('Attestation');
  /** Replaced in tests. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  /** Apple App Attestation Root CA (PEM, from APP_ATTEST_ROOT_CA_B64); replaced in tests. */
  appleRoot: X509Certificate | null = env.APP_ATTEST_ROOT_CA_B64 ? new X509Certificate(Buffer.from(env.APP_ATTEST_ROOT_CA_B64, 'base64')) : null;
  private googleToken: { value: string; until: number } | null = null;

  constructor(@Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis) {}

  async challenge() {
    const c = randomBytes(32).toString('base64url');
    await this.redis.set(`attest:ch:${c}`, '1', 'EX', CHALLENGE_TTL_SEC);
    return { challenge: c, expiresIn: CHALLENGE_TTL_SEC };
  }

  /** Called before a guest is created. Throws only in enforce mode. */
  async check(d: { installId: string; platform: 'ios' | 'android' }, raw: unknown) {
    const mode = env.ATTESTATION_MODE;
    if (mode === 'off') return;
    const [known] = await this.db.select({ id: authIdentities.id }).from(authIdentities)
      .where(and(eq(authIdentities.provider, 'device'), eq(authIdentities.providerUid, d.installId)));
    if (known) return; // resuming an install: it was checked when it was created
    const problem = await this.verify(d.platform, raw).catch((e: Error) => `error: ${e.message}`);
    metrics.attestation.inc({ platform: d.platform, result: problem ? (mode === 'enforce' ? 'rejected' : 'failed_allowed') : 'ok' });
    if (!problem) return;
    this.log.warn(`attestation failed (${d.platform}, ${mode}): ${problem}`);
    if (mode === 'enforce') throw new AppError('ATTESTATION_FAILED', 'This device could not be verified. Update the app and try again.');
  }

  private async verify(platform: 'ios' | 'android', raw: unknown): Promise<string | null> {
    const parsed = AttestationDto.safeParse(typeof raw === 'string' ? safeJson(raw) : raw);
    if (!parsed.success) return 'missing or malformed attestation';
    const a = parsed.data;
    // the challenge is single use
    if ((await this.redis.del(`attest:ch:${a.challenge}`)) !== 1) return 'unknown or used challenge';
    if (platform === 'ios') {
      if (!('keyId' in a)) return 'iOS needs an App Attest object';
      if (!this.appleRoot) return 'APP_ATTEST_ROOT_CA_B64 is not configured';
      if (!env.APPLE_TEAM_ID) return 'APPLE_TEAM_ID is not configured';
      const bundle = env.APPLE_BUNDLE_IDS.split(',')[0]!.trim();
      return verifyAppAttest(a, `${env.APPLE_TEAM_ID}.${bundle}`, this.appleRoot);
    }
    if (!('token' in a)) return 'Android needs a Play Integrity token';
    const verdict = await this.decodePlayIntegrity(a.token);
    return checkIntegrityVerdict(verdict, a.challenge, env.ANDROID_PACKAGE);
  }

  /** Google decodes and checks the token's signature for us (server-side decryption, "Google-managed" keys). */
  private async decodePlayIntegrity(token: string): Promise<IntegrityVerdict> {
    const access = await this.google();
    const res = await this.fetchImpl(`https://playintegrity.googleapis.com/v1/${encodeURIComponent(env.ANDROID_PACKAGE)}:decodeIntegrityToken`, {
      method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: JSON.stringify({ integrity_token: token }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Play Integrity answered ${res.status}`);
    return ((await res.json()) as { tokenPayloadExternal?: IntegrityVerdict }).tokenPayloadExternal ?? {};
  }

  private async google() {
    if (this.googleToken && this.googleToken.until > Date.now()) return this.googleToken.value;
    if (!env.PLAY_INTEGRITY_SA_B64) throw new Error('PLAY_INTEGRITY_SA_B64 is not configured');
    const sa = JSON.parse(Buffer.from(env.PLAY_INTEGRITY_SA_B64, 'base64').toString()) as { client_email: string; private_key: string };
    const jwt = await new SignJWT({ scope: 'https://www.googleapis.com/auth/playintegrity' }).setProtectedHeader({ alg: 'RS256' })
      .setIssuer(sa.client_email).setSubject(sa.client_email).setAudience('https://oauth2.googleapis.com/token').setIssuedAt().setExpirationTime('55m')
      .sign(await importPKCS8(sa.private_key, 'RS256'));
    const res = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    });
    if (!res.ok) throw new Error(`Google token ${res.status}`);
    const t = (await res.json()) as { access_token: string; expires_in: number };
    this.googleToken = { value: t.access_token, until: Date.now() + (t.expires_in - 120) * 1000 };
    return t.access_token;
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
