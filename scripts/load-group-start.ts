/**
 * Group start load test (spec §6.3): N app sockets wait in today's lobby, then one `group:start` goes out on the bus
 * (as the scheduler sends it at T0). Every socket must receive it within 1 s.
 *   API_URL=http://127.0.0.1:3000 N=50000 npx tsx scripts/load-group-start.ts
 * Needs the API's DATABASE_URL, REDIS_URL, JWT_PRIVATE_KEY_B64 and JWT_KID. Run against 2+ API pods behind the load
 * balancer (docker-compose.lb.yml) to include the Redis adapter fan-out. The client machine needs `ulimit -n` > N.
 */
import 'dotenv/config';
import Redis from 'ioredis';
import { importPKCS8, SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { io, type Socket } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const N = Number(process.env.N ?? 50_000), BATCH = Number(process.env.BATCH ?? 500);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const date = new Date().toISOString().slice(0, 10);
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  const ids = (await db.query<{ id: string }>(`INSERT INTO users (id, is_guest, country, timezone) SELECT gen_random_uuid(), true, 'DE', 'UTC' FROM generate_series(1, $1) RETURNING id`, [N])).rows.map((r) => r.id);
  await db.end();
  const key = await importPKCS8(Buffer.from(process.env.JWT_PRIVATE_KEY_B64!, 'base64').toString(), 'EdDSA');
  const token = (sub: string) => new SignJWT({ gst: true, prm: false, ver: 0 }).setProtectedHeader({ alg: 'EdDSA', kid: process.env.JWT_KID ?? 'k1' }).setIssuer('wehum').setAudience('wehum-app').setSubject(sub).setIssuedAt().setExpirationTime('1h').sign(key);

  const socks: Socket[] = [];
  const got = new Map<Socket, number>();
  let joined = 0, failed = 0;
  const t0 = Date.now();
  for (let i = 0; i < ids.length; i += BATCH) {
    await Promise.all(ids.slice(i, i + BATCH).map(async (id) => {
      const s = io(`${API}/live`, { transports: ['websocket'], auth: { token: await token(id), installId: randomUUID(), appVersion: '1.0.0' }, reconnection: false });
      socks.push(s);
      s.on('group:start', () => { if (!got.has(s)) got.set(s, Date.now()); });
      await new Promise<void>((done) => {
        s.on('connect', () => s.emit('room:join', { room: `lobby:${date}` }, (r: { ok: boolean }) => { if (r?.ok) joined++; else failed++; done(); }));
        s.on('connect_error', () => { failed++; done(); });
      });
    }));
    process.stdout.write(`\rin the lobby: ${joined}/${N} (failed ${failed})`);
  }
  console.log(`\nconnected in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await sleep(3000); // let the lobby settle

  const bus = new Redis(process.env.REDIS_URL!);
  const sentAt = Date.now();
  await bus.publish('events', JSON.stringify({ topic: 'group:start', payload: { date, startsAt: new Date(sentAt).toISOString(), sessionId: randomUUID(), lengthMin: 30, mediaKey: `motd:${date}:30` } }));
  await sleep(5000);
  const lat = [...got.values()].map((t) => t - sentAt);
  console.log(`received: ${got.size}/${joined}  p50 ${pct(lat, 0.5)} ms  p95 ${pct(lat, 0.95)} ms  p99 ${pct(lat, 0.99)} ms  max ${Math.max(0, ...lat)} ms`);
  const ok = got.size === joined && pct(lat, 1) < 1000;
  console.log(ok ? 'PASS: every socket in the lobby got group:start within 1 s' : 'FAIL: budget is all clients < 1 s');
  socks.forEach((s) => s.close());
  bus.disconnect();
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
