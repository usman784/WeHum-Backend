/**
 * Presence load test: N app sockets meditate at once, a few hundred watchers listen to the world numbers.
 *   API_URL=http://127.0.0.1:3066 N=10000 DURATION_SEC=100 npx tsx scripts/load-presence.ts
 * Needs the same DATABASE_URL / JWT_PRIVATE_KEY_B64 / JWT_KID as the API, and a scheduler process (it publishes live:agg).
 * Reports connect time, ack latency, aggregation lag and that beating users are never dropped.
 */
import 'dotenv/config';
import { importPKCS8, SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { io, type Socket } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const N = Number(process.env.N ?? 10_000), WATCHERS = Number(process.env.WATCHERS ?? 200), DURATION = Number(process.env.DURATION_SEC ?? 100);
const BEAT_MS = Number(process.env.BEAT_MS ?? 30_000), BATCH = Number(process.env.BATCH ?? 500);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const COUNTRIES = ['DE', 'US', 'PK', 'BR', 'JP', 'GB', 'FR', 'IN', 'AU', 'ZA', 'MX', 'SE'];

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  const ids = (await db.query<{ id: string }>(
    `INSERT INTO users (id, is_guest, country, timezone) SELECT gen_random_uuid(), true, (ARRAY[${COUNTRIES.map((c) => `'${c}'`).join(',')}])[1 + (g % ${COUNTRIES.length})], 'UTC' FROM generate_series(1, $1) g RETURNING id`, [N])).rows.map((r) => r.id);
  await db.end();
  const key = await importPKCS8(Buffer.from(process.env.JWT_PRIVATE_KEY_B64!, 'base64').toString(), 'EdDSA');
  const token = (sub: string) => new SignJWT({ gst: true, prm: false, ver: 0 }).setProtectedHeader({ alg: 'EdDSA', kid: process.env.JWT_KID ?? 'k1' }).setIssuer('wehum').setAudience('wehum-app').setSubject(sub).setIssuedAt().setExpirationTime('1h').sign(key);

  const sessions = Array.from({ length: 20 }, () => randomUUID());
  const socks: Socket[] = [], connectMs: number[] = [], ackMs: number[] = [];
  const own = new Map<Socket, string>(); // socket → its meditation id (for beats and stop)
  let connectErrors = 0, disconnects = 0, startErrors = 0;
  const errorKinds: Record<string, number> = {};
  const t0 = Date.now();

  // ── connect + presence:start, in batches so the OS and the API are not hit by one wall of SYNs
  for (let i = 0; i < N; i += BATCH) {
    await Promise.all(ids.slice(i, i + BATCH).map(async (id, k) => {
      const started = Date.now();
      const s = io(`${API}/live`, { transports: ['websocket'], auth: { token: await token(id) }, reconnection: false, forceNew: true });
      s.on('disconnect', () => { disconnects++; });
      const ok = await new Promise<boolean>((res) => { s.on('connect', () => res(true)); s.on('connect_error', (e: Error) => { errorKinds[e.message] = (errorKinds[e.message] ?? 0) + 1; res(false); }); });
      if (!ok) { connectErrors++; return; }
      connectMs.push(Date.now() - started);
      socks.push(s);
      const a0 = Date.now(), meditationId = randomUUID();
      own.set(s, meditationId);
      const r = await s.timeout(10_000).emitWithAck('presence:start', { meditationId, sessionId: sessions[(i + k) % sessions.length], kind: 'motd', mode: 'solo' }).catch(() => ({ ok: false }));
      ackMs.push(Date.now() - a0);
      if (!(r as { ok: boolean }).ok) startErrors++;
    }));
  }
  const allStarted = Date.now();
  console.log(`connected ${socks.length}/${N} in ${((allStarted - t0) / 1000).toFixed(1)} s`);

  // ── watchers: how long until the world sees everyone?
  const watchers = socks.slice(0, WATCHERS);
  const seen: number[] = [];
  const lastTotals: number[] = [];
  let firstFull = 0;
  for (const w of watchers) {
    w.on('live:agg', (p: { total: number }) => { lastTotals.push(p.total); if (!firstFull && p.total >= socks.length - startErrors) { firstFull = Date.now(); } if (p.total >= socks.length - startErrors) seen.push(Date.now()); });
    void w.emitWithAck('room:join', { room: 'world' });
  }
  const waitFull = Date.now() + 30_000;
  while (!firstFull && Date.now() < waitFull) await sleep(50);
  const aggLagMs = firstFull ? firstFull - allStarted : -1;
  console.log(`world saw all ${socks.length} after ${aggLagMs} ms (first totals seen: ${lastTotals.slice(0, 6).join(', ')})`);

  // ── beat for the rest of the run: nobody who keeps beating may drop out
  const beats = { sent: 0, failed: 0 };
  const beatLoop = setInterval(() => { for (const [s, id] of own) { beats.sent++; s.timeout(10_000).emitWithAck('presence:beat', { meditationId: id }).then((r) => { if (!(r as { ok: boolean }).ok) beats.failed++; }, () => { beats.failed++; }); } }, BEAT_MS);
  const end = Date.now() + DURATION * 1000;
  const samples: number[] = [];
  while (Date.now() < end) { await sleep(5000); const last = lastTotals.at(-1); if (last !== undefined) samples.push(last); }
  clearInterval(beatLoop);
  const finalTotal = lastTotals.at(-1) ?? -1;

  // ── everyone stops: the numbers fall to zero within a tick or two
  const stopAt = Date.now();
  await Promise.all([...own].map(([s, id]) => s.timeout(10_000).emitWithAck('presence:stop', { meditationId: id }).catch(() => null)));
  let zeroAt = 0; const zeroWait = Date.now() + 30_000;
  while (Date.now() < zeroWait) { if ((lastTotals.at(-1) ?? 1) === 0) { zeroAt = Date.now(); break; } await sleep(50); }
  const unexpected = disconnects; // before we close them ourselves
  for (const s of socks) s.close();

  console.log(JSON.stringify({
    users: N, connected: socks.length, connectErrors, errorKinds, startErrors, unexpectedDisconnects: unexpected,
    connectMs: { p50: pct(connectMs, 0.5), p95: pct(connectMs, 0.95), p99: pct(connectMs, 0.99) },
    startAckMs: { p50: pct(ackMs, 0.5), p95: pct(ackMs, 0.95), p99: pct(ackMs, 0.99) },
    aggregationLagMs: aggLagMs, totalAfterRun: finalTotal, expectedTotal: socks.length - startErrors,
    beats, droppedWhileBeating: Math.max(0, (socks.length - startErrors) - finalTotal),
    fanoutLiveAggPerWatcher: Math.round(lastTotals.length / Math.max(1, watchers.length)), watcherCount: watchers.length,
    stopToZeroMs: zeroAt ? zeroAt - stopAt : -1, runSec: DURATION,
  }, null, 1));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
