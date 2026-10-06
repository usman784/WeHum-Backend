import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3Service } from '../src/infra/s3';
import { integratedLufs, probe } from '../src/jobs/ffmpeg';
import { QUEUES, QueueService } from '../src/jobs/queues';
import { WorkerRunner } from '../src/jobs/workers';
import { adminToken, bootApp, guest, http, makeAdmin, resetTestDb } from './helpers';

const run = promisify(execFile);
const ffmpeg = (...args: string[]) => run(process.env.FFMPEG_PATH!, ['-y', '-hide_banner', '-loglevel', 'error', ...args]);

let app: NestFastifyApplication;
let db: Client;
let s3: S3Service;
let runner: WorkerRunner;
let queues: QueueService;
let dir: string;
let owner: string, editor: string, mod: string;
const A = {
  post: (u: string, b: unknown = {}, t = owner) => http(app).post(u, b, { token: t }),
  get: (u: string, t = owner) => http(app).get(u, { token: t }),
};
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows as T[];
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Presigned multipart upload straight to S3, like the CMS does. */
async function upload(kind: 'audio' | 'video' | 'image', mime: string, file: Buffer, name: string, token = editor) {
  const start = await A.post('/v1/admin/media/uploads', { kind, mime, bytes: file.length, name, checksum: sha(file) }, token);
  if (start.status !== 201) return { start };
  const { id, partSize, parts } = start.body.data as { id: string; partSize: number; parts: { partNumber: number; url: string }[] };
  const etags: { partNumber: number; etag: string }[] = [];
  for (const p of parts) {
    const res = await fetch(p.url, { method: 'PUT', body: file.subarray((p.partNumber - 1) * partSize, p.partNumber * partSize) });
    expect(res.status, `part ${p.partNumber}`).toBe(200);
    etags.push({ partNumber: p.partNumber, etag: res.headers.get('etag')! });
  }
  const done = await A.post(`/v1/admin/media/uploads/${id}/complete`, { parts: etags }, token);
  return { start, done, id };
}

const settle = async () => runner.idle([QUEUES.media], queues, 90_000);
const media = (id: string, t = editor) => A.get(`/v1/admin/media/${id}`, t).then((r) => r.body.data);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wehum-fixtures-'));
  await resetTestDb();
  app = await bootApp();
  s3 = app.get(S3Service); runner = app.get(WorkerRunner); queues = app.get(QueueService);
  await s3.ensureBucket();
  runner.start(); // in production this runs in the worker process
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  owner = await adminToken(app, await makeAdmin(db, 'owner'));
  editor = await adminToken(app, await makeAdmin(db, 'editor'));
  mod = await adminToken(app, await makeAdmin(db, 'moderator'));
});
afterAll(async () => { rmSync(dir, { recursive: true, force: true }); await db?.end(); await app?.close(); });

const tone = async (name: string, sec: number, extra: string[] = [], rate = 48000) => {
  const f = join(dir, name);
  await ffmpeg('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${rate}:duration=${sec}`, '-ac', '1', ...extra, f);
  return f;
};

describe('P3 media upload → processing → ready', () => {
  it('audio: multipart upload (3 parts), probe, loudness, loop check, AAC 128k in S3', async () => {
    const f = await tone('long.wav', 230); // ~22 MB → 3 parts of 10 MB
    const buf = readFileSync(f);
    expect(buf.length).toBeGreaterThan(20 * 1024 * 1024);
    const r = await upload('audio', 'audio/wav', buf, 'Long Tone.wav');
    expect(r.start.body.data.parts).toHaveLength(3);
    expect(r.start.body.data.partSize).toBe(10 * 1024 * 1024);
    expect(r.start.body.data.duplicateOf).toBeNull();
    expect(r.done!.status).toBe(202);
    expect(r.done!.body.data).toMatchObject({ id: r.id, status: 'processing' });
    expect((await media(r.id!)).status).toBe('processing');

    await settle();
    const m = await media(r.id!);
    expect(m).toMatchObject({ status: 'ready', kind: 'audio', mime: 'audio/mp4', error: null, name: 'Long Tone.wav' });
    expect(m.durationSec).toBeGreaterThanOrEqual(229);
    expect(m.durationSec).toBeLessThanOrEqual(231);
    expect(m.loudnessLufs).toBeLessThan(-10);
    expect(m.loudnessLufs).toBeGreaterThan(-40);
    expect(m.previewUrl).toMatch(/sig=/);
    expect(m.job).toMatchObject({ status: 'done', progress: 100, result: { durationSec: expect.any(Number), lufs: m.loudnessLufs, loop: { seamless: true } } });
    expect(m.job.result.loudnessWarning).toMatch(/outside −16 ±1/); // a quiet test tone is far from −16

    // what is in S3 is AAC-LC 44.1 kHz stereo, not the upload
    const [row] = await q<{ storage_key: string; bytes: string }>(`SELECT storage_key, bytes FROM media_assets WHERE id=$1`, [r.id]);
    expect(row!.storage_key).toBe(`media/${r.id}/v1/audio.m4a`);
    const out = join(dir, 'check.m4a');
    await s3.download(row!.storage_key, out);
    const p = await probe(out);
    expect(p.codec).toBe('aac');
    expect(Number(row!.bytes)).toBe(readFileSync(out).length);
    expect((await run(process.env.FFPROBE_PATH!, ['-v', 'error', '-show_entries', 'stream=sample_rate,channels', '-of', 'csv=p=0', out])).stdout.trim()).toBe('44100,2');
    expect(await s3.size(`media/${r.id}/v1/original.wav`)).toBe(buf.length); // original is kept
    expect((await q(`SELECT 1 FROM audit_log WHERE action='media.complete' AND target_id=$1`, [r.id]))).toHaveLength(1);
    expect((await q(`SELECT 1 FROM outbox_events WHERE topic='job:progress' AND payload->>'jobId'=$1 AND payload->>'status'='done'`, [m.job.id]))).toHaveLength(1);
  });

  it('loudness: a file at −16 LUFS passes without a warning; a faded tail fails the loop check', async () => {
    const base = await tone('base.wav', 12);
    const l0 = (await integratedLufs(base))!;
    const loud = join(dir, 'loud.wav');
    await ffmpeg('-i', base, '-af', `volume=${(-16 - l0).toFixed(2)}dB`, loud);
    const a = await upload('audio', 'audio/wav', readFileSync(loud), 'minus16.wav');
    const faded = join(dir, 'faded.wav');
    await ffmpeg('-i', loud, '-af', 'afade=t=out:st=8:d=4', faded);
    const b = await upload('audio', 'audio/wav', readFileSync(faded), 'faded.wav');
    await settle();
    const ma = await media(a.id!), mb = await media(b.id!);
    expect(Math.abs(ma.loudnessLufs + 16)).toBeLessThan(1);
    expect(ma.job.result.loudnessWarning).toBeNull();
    expect(ma.job.result.loop).toMatchObject({ seamless: true });
    expect(mb.job.result.loop.seamless).toBe(false); // the end is much quieter than the start
    expect(mb.job.result.loop.diffDb).toBeGreaterThan(3);
  });

  it('video: H.264 720p-or-smaller MP4 + AAC, dimensions and duration recorded', async () => {
    const f = join(dir, 'clip.mp4');
    await ffmpeg('-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x360:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-shortest', f);
    const r = await upload('video', 'video/mp4', readFileSync(f), 'clip.mp4');
    await settle();
    const m = await media(r.id!);
    expect(m).toMatchObject({ status: 'ready', kind: 'video', mime: 'video/mp4', width: 640, height: 360 });
    expect(m.durationSec).toBeGreaterThanOrEqual(2);
    expect(m.loudnessLufs).not.toBeNull();
    const key = (await q<{ storage_key: string }>(`SELECT storage_key FROM media_assets WHERE id=$1`, [r.id]))[0]!.storage_key;
    expect(key).toBe(`media/${r.id}/v1/video.mp4`);
    const out = join(dir, 'clip-out.mp4');
    await s3.download(key, out);
    const p = await probe(out);
    expect(p).toMatchObject({ hasVideo: true, hasAudio: true, codec: 'aac' });
    expect((await run(process.env.FFPROBE_PATH!, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', out])).stdout.trim()).toBe('h264');
  });

  it('image: 1200/600/300 WebP + JPEG, blurhash, size', async () => {
    const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 40, g: 90, b: 160 } } })
      .composite([{ input: Buffer.from('<svg width="400" height="300"><rect width="400" height="300" fill="#f5c542"/></svg>'), top: 100, left: 200 }]).png().toBuffer();
    const r = await upload('image', 'image/png', png, 'cover.png');
    await settle();
    const m = await media(r.id!);
    expect(m).toMatchObject({ status: 'ready', kind: 'image', mime: 'image/webp', width: 800, height: 600 });
    expect(m.blurhash).toMatch(/^[\w#$%*+,\-.:;=?@[\]^{|}~]{6,}$/);
    expect(m.durationSec).toBeNull();
    expect(m.previewUrl).toContain(`media/${r.id}/v1/1200.webp`);
    for (const k of ['1200.webp', '600.webp', '300.webp', '1200.jpg']) expect(await s3.size(`media/${r.id}/v1/${k}`), k).toBeGreaterThan(0);
    const w300 = await sharp(await s3.getBuffer(`media/${r.id}/v1/300.webp`)).metadata();
    expect(w300).toMatchObject({ width: 300, height: 225, format: 'webp' });
    const w1200 = await sharp(await s3.getBuffer(`media/${r.id}/v1/1200.webp`)).metadata();
    expect(w1200.width).toBe(800); // never enlarged
  });

  it('a corrupt file fails cleanly with a readable reason and is not retried forever', async () => {
    const r = await upload('audio', 'audio/mpeg', randomBytes(50_000), 'broken.mp3');
    await settle();
    const m = await media(r.id!);
    expect(m).toMatchObject({ status: 'failed', error: 'This is not a valid audio file', previewUrl: null });
    expect(m.job).toMatchObject({ status: 'failed', error: 'This is not a valid audio file' });
    const bad = await upload('image', 'image/png', randomBytes(5_000), 'broken.png');
    await settle();
    expect((await media(bad.id!)).error).toBe('This is not a valid image');
    const silentVideo = join(dir, 'audio-as-video.wav');
    writeFileSync(silentVideo, readFileSync(await tone('t2.wav', 2)));
    const notVideo = await upload('video', 'video/mp4', readFileSync(silentVideo), 'not-video.mp4');
    await settle();
    expect((await media(notVideo.id!)).error).toBe('No video found in this file');
  });

  it('processed media plugs into content: publish a session and play it as a member', async () => {
    const f = await tone('plug.wav', 5);
    const up = await upload('audio', 'audio/wav', readFileSync(f), 'plug.wav');
    await settle();
    const cover = await upload('image', 'image/png', await sharp({ create: { width: 100, height: 100, channels: 3, background: '#223' } }).png().toBuffer(), 'c.png');
    await settle();
    const s = (await A.post('/v1/admin/sessions', { title: 'From Upload', type: 'audio', mediaId: up.id, coverMediaId: cover.id, durationSec: 1 }, editor)).body.data;
    const pub = await A.post(`/v1/admin/sessions/${s.id}/publish`, {}, editor);
    expect(pub.body.data).toMatchObject({ status: 'live', durationSec: 5 });
    const g = await guest(app);
    await q(`INSERT INTO entitlements (user_id, active, expires_at) VALUES ($1, true, now() + interval '1 day')`, [g.me.id]);
    const play = await http(app).post('/v1/media/play-url', { kind: 'session', id: s.id }, { token: g.accessToken });
    expect(play.status).toBe(200);
    expect(new URL(play.body.data.url).pathname).toContain(`/media/${up.id}/v1/audio.m4a`);
    expect(play.body.data).toMatchObject({ mime: 'audio/mp4', durationSec: 5 });
    const cat = await http(app).get('/v1/catalog', { token: g.accessToken });
    const item = cat.body.data.sessions.find((x: { id: string }) => x.id === s.id);
    expect(item.cover.url).toContain(`media/${cover.id}/v1/1200.webp`);
    expect(item.cover.blurhash).toEqual(expect.any(String));
  });
});

describe('P3 media upload rules', () => {
  it('validates kind, mime, size; nothing is created for a rejected upload', async () => {
    const before = (await q<{ n: number }>(`SELECT count(*)::int n FROM media_assets`))[0]!.n;
    const post = (b: Record<string, unknown>, t = editor) => A.post('/v1/admin/media/uploads', { kind: 'audio', mime: 'audio/mpeg', bytes: 1000, name: 'a.mp3', ...b }, t);
    expect((await post({ kind: 'document' })).status).toBe(400);
    expect((await post({ mime: 'video/mp4' })).body.error.code).toBe('VALIDATION_FAILED'); // audio kind, video mime
    expect((await post({ kind: 'image', mime: 'image/svg+xml' })).status).toBe(400); // SVG is not accepted yet
    expect((await post({ kind: 'image', mime: 'image/png', bytes: 10 * 1024 * 1024 + 1 })).status).toBe(413);
    expect((await post({ bytes: 500 * 1024 * 1024 + 1 })).body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect((await post({ kind: 'video', mime: 'video/mp4', bytes: 2049 * 1024 * 1024 })).status).toBe(413);
    expect((await post({ bytes: 0 })).status).toBe(400);
    expect((await post({ bytes: 1.5 })).status).toBe(400);
    expect((await post({ checksum: 'nothex' })).status).toBe(400);
    expect((await post({ extra: true })).status).toBe(400);
    expect((await post({}, mod)).status).toBe(403);
    expect((await http(app).post('/v1/admin/media/uploads', { kind: 'audio', mime: 'audio/mpeg', bytes: 1, name: 'a' })).status).toBe(401);
    expect((await q<{ n: number }>(`SELECT count(*)::int n FROM media_assets`))[0]!.n).toBe(before);
  });

  it('duplicate checksum is flagged (but allowed); upload ids are validated', async () => {
    const f = readFileSync(await tone('dup.wav', 2));
    const a = await upload('audio', 'audio/wav', f, 'dup.wav');
    await settle();
    const b = await A.post('/v1/admin/media/uploads', { kind: 'audio', mime: 'audio/wav', bytes: f.length, name: 'dup-again.wav', checksum: sha(f) }, editor);
    expect(b.status).toBe(201);
    expect(b.body.data.duplicateOf).toMatchObject({ id: a.id, name: 'dup.wav' });
    expect((await A.get('/v1/admin/media/not-a-uuid')).status).toBe(400);
    expect((await A.get(`/v1/admin/media/${a.id!.replace(/.$/, (c: string) => (c === '0' ? '1' : '0'))}`)).status).toBe(404);
    expect((await A.get(`/v1/admin/media/${a.id}`, mod)).status).toBe(403);
  });

  it('complete: part count must match, size must match, only once', async () => {
    const buf = randomBytes(1000);
    const start = await A.post('/v1/admin/media/uploads', { kind: 'audio', mime: 'audio/mpeg', bytes: 1000, name: 'x.mp3' }, editor);
    const { id, parts } = start.body.data;
    const put = await fetch(parts[0].url, { method: 'PUT', body: buf });
    const etag = put.headers.get('etag')!;
    const c = (p: unknown) => A.post(`/v1/admin/media/uploads/${id}/complete`, { parts: p }, editor);
    expect((await c([])).status).toBe(400);
    expect((await c([{ partNumber: 1, etag }, { partNumber: 2, etag }])).body.error.code).toBe('VALIDATION_FAILED');
    expect((await c([{ partNumber: 2, etag }])).status).toBe(400);
    expect((await c([{ partNumber: 1, etag: 'bogus' }])).body.error.code).toBe('INVALID_STATE'); // S3 refuses the assembly
    expect((await media(id)).status).toBe('uploading'); // still resumable
    expect((await c([{ partNumber: 1, etag }])).status).toBe(202);
    expect((await c([{ partNumber: 1, etag }])).body.error.code).toBe('INVALID_STATE');
    expect((await A.post(`/v1/admin/media/uploads/${uuidNil()}/complete`, { parts: [{ partNumber: 1, etag }] }, editor)).status).toBe(404);
    await settle();

    // declared size ≠ uploaded size
    const s2 = await A.post('/v1/admin/media/uploads', { kind: 'audio', mime: 'audio/mpeg', bytes: 5000, name: 'short.mp3' }, editor);
    const p2 = await fetch(s2.body.data.parts[0].url, { method: 'PUT', body: randomBytes(1000) });
    const r2 = await A.post(`/v1/admin/media/uploads/${s2.body.data.id}/complete`, { parts: [{ partNumber: 1, etag: p2.headers.get('etag')! }] }, editor);
    expect(r2.status).toBe(422);
    expect(r2.body.error.code).toBe('INVALID_STATE');
    expect((await media(s2.body.data.id)).status).toBe('failed');
    expect(await s3.size(`media/${s2.body.data.id}/v1/original.mp3`)).toBeNull(); // the partial object is removed
  });

  it('resume: fresh part URLs for an open upload let it finish after the first URLs are gone', async () => {
    const buf = randomBytes(11 * 1024 * 1024); // 2 parts
    const start = await A.post('/v1/admin/media/uploads', { kind: 'audio', mime: 'audio/mpeg', bytes: buf.length, name: 'resume.mp3' }, editor);
    const { id, partSize, parts } = start.body.data as { id: string; partSize: number; parts: { partNumber: number; url: string }[] };
    expect(parts).toHaveLength(2);
    const first = await fetch(parts[0]!.url, { method: 'PUT', body: buf.subarray(0, partSize) }); // part 1 went through, then the network dropped

    const again = await A.post(`/v1/admin/media/uploads/${id}/parts`, { partNumbers: [2] }, editor);
    expect(again.status).toBe(200);
    expect(again.body.data.parts).toHaveLength(1);
    expect(again.body.data.parts[0]).toMatchObject({ partNumber: 2 });
    expect(again.body.data.parts[0].url).toContain('partNumber=2');
    expect(Date.parse(again.body.data.expiresAt)).toBeGreaterThan(Date.now() + 3500_000); // good for another hour
    const second = await fetch(again.body.data.parts[0].url, { method: 'PUT', body: buf.subarray(partSize) });
    expect(second.status).toBe(200);
    const done = await A.post(`/v1/admin/media/uploads/${id}/complete`, { parts: [{ partNumber: 1, etag: first.headers.get('etag')! }, { partNumber: 2, etag: second.headers.get('etag')! }] }, editor);
    expect(done.status).toBe(202);
    expect(await s3.size(`media/${id}/v1/original.mp3`)).toBe(buf.length);
    await settle(); // random bytes are not audio: the job fails cleanly, which is not what this test is about

    // rules
    expect((await A.post(`/v1/admin/media/uploads/${id}/parts`, { partNumbers: [1] }, editor)).body.error.code).toBe('INVALID_STATE'); // already completed
    const open = (await A.post('/v1/admin/media/uploads', { kind: 'audio', mime: 'audio/mpeg', bytes: 1000, name: 'one.mp3' }, editor)).body.data.id;
    expect((await A.post(`/v1/admin/media/uploads/${open}/parts`, { partNumbers: [2] }, editor)).status).toBe(400); // it has one part
    expect((await A.post(`/v1/admin/media/uploads/${open}/parts`, { partNumbers: [1, 1] }, editor)).status).toBe(400);
    expect((await A.post(`/v1/admin/media/uploads/${open}/parts`, { partNumbers: [1] }, mod)).status).toBe(403);
    expect((await A.post(`/v1/admin/media/uploads/${uuidNil()}/parts`, { partNumbers: [1] }, editor)).status).toBe(404);
  });

  it('cancel: the open upload and its parts are removed; a finished upload cannot be cancelled', async () => {
    const start = await A.post('/v1/admin/media/uploads', { kind: 'audio', mime: 'audio/mpeg', bytes: 1000, name: 'cancel-me.mp3' }, editor);
    const { id, parts } = start.body.data;
    await fetch(parts[0].url, { method: 'PUT', body: randomBytes(1000) });
    const del = (i: string, t = editor) => http(app).del(`/v1/admin/media/uploads/${i}`, { token: t });
    expect((await del(id, mod)).status).toBe(403);
    expect((await del(id)).status).toBe(204);
    expect((await A.get(`/v1/admin/media/${id}`, editor)).status).toBe(404);
    expect((await fetch(parts[0].url, { method: 'PUT', body: randomBytes(1000) })).status).toBe(404); // the multipart upload is gone in S3
    expect((await del(id)).status).toBe(204); // idempotent
    expect((await q(`SELECT 1 FROM audit_log WHERE action='media.cancel' AND target_id=$1`, [id]))).toHaveLength(1);

    const [ready] = await q<{ id: string }>(`SELECT id FROM media_assets WHERE status='ready' LIMIT 1`);
    expect((await del(ready!.id)).body.error.code).toBe('INVALID_STATE');
    expect((await q(`SELECT 1 FROM media_assets WHERE id=$1`, [ready!.id]))).toHaveLength(1);
  });

  it('every step is audited (media.create / media.complete / media.cancel) with who did it', async () => {
    const rows = await q<{ action: string; actor_role: string }>(`SELECT action, actor_role FROM audit_log WHERE target_type='media' ORDER BY id`);
    expect(rows.length).toBeGreaterThan(10);
    expect(new Set(rows.map((r) => r.action))).toEqual(new Set(['media.create', 'media.complete', 'media.cancel']));
    expect(new Set(rows.map((r) => r.actor_role))).toEqual(new Set(['editor']));
  });
});

const uuidNil = () => '00000000-0000-0000-0000-000000000000';
