import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { io, type Socket } from 'socket.io-client';
import { TokensService } from '../src/modules/auth/tokens.service';
import { bootApp } from './helpers';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An API pod listening on a free port (several can run in one test, sharing Postgres + Redis, like pods behind a load balancer). */
export async function startPod(): Promise<{ app: NestFastifyApplication; url: string; stop: () => Promise<void> }> {
  const app = await bootApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.getHttpServer().address() as { port: number };
  return { app, url: `http://127.0.0.1:${addr.port}`, stop: () => app.close() };
}

export interface ConnectResult { socket: Socket; error?: { message: string; code?: string } }

/** Connects to a namespace. Resolves with the socket, or with the `connect_error` (never rejects). */
export function connect(url: string, ns: '/live' | '/admin', auth: Record<string, unknown> | undefined, timeoutMs = 5000): Promise<ConnectResult> {
  return new Promise((resolve) => {
    const socket = io(url + ns, { transports: ['websocket'], auth, reconnection: false, forceNew: true });
    const t = setTimeout(() => resolve({ socket, error: { message: 'timeout' } }), timeoutMs);
    socket.on('connect', () => { clearTimeout(t); resolve({ socket }); });
    socket.on('connect_error', (e: Error & { data?: { code?: string } }) => { clearTimeout(t); resolve({ socket, error: { message: e.message, code: e.data?.code } }); });
  });
}

/** Connects with listeners already attached, so events the server sends right on connect are not missed. */
export async function connectRecorded(url: string, ns: '/live' | '/admin', auth: Record<string, unknown>, ...events: string[]) {
  const socket = io(url + ns, { transports: ['websocket'], auth, reconnection: false, forceNew: true });
  const rec = recorder(socket, ...events);
  await new Promise<void>((resolve, reject) => { socket.on('connect', resolve); socket.on('connect_error', (e) => reject(new Error(`connect failed: ${e.message}`))); });
  return { socket, rec };
}

/** Connects and fails the test if it does not work. */
export async function mustConnect(url: string, ns: '/live' | '/admin', auth: Record<string, unknown>) {
  const r = await connect(url, ns, auth);
  if (r.error) throw new Error(`connect ${ns} failed: ${JSON.stringify(r.error)}`);
  return r.socket;
}

/** Records every event of the given names so tests can look at what arrived (and what did not). */
export function recorder(socket: Socket, ...events: string[]) {
  const got: { event: string; payload: any; at: number }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const e of events) socket.on(e, (payload: unknown) => got.push({ event: e, payload, at: Date.now() }));
  return {
    all: () => got,
    of: (event: string) => got.filter((g) => g.event === event).map((g) => g.payload),
    clear: () => { got.length = 0; },
    /** Waits until at least `n` events of this kind arrived (optionally matching). */
    async wait(event: string, n = 1, match?: (p: any) => boolean, timeoutMs = 5000) { // eslint-disable-line @typescript-eslint/no-explicit-any
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const hits = got.filter((g) => g.event === event && (!match || match(g.payload)));
        if (hits.length >= n) return hits.map((h) => h.payload);
        await sleep(15);
      }
      throw new Error(`timed out waiting for ${n}× ${event}; got ${JSON.stringify(got.filter((g) => g.event === event).map((g) => g.payload)).slice(0, 400)}`);
    },
  };
}

export const emit = <T = any>(socket: Socket, event: string, payload?: unknown): Promise<{ ok: boolean; code?: string; data?: T }> => // eslint-disable-line @typescript-eslint/no-explicit-any
  socket.timeout(5000).emitWithAck(event, payload) as Promise<{ ok: boolean; code?: string; data?: T }>;

export async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 5000, what = 'condition') {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await cond()) return; await sleep(20); }
  throw new Error(`timed out waiting for ${what}`);
}

/** App access token for a user, optionally short-lived. */
export const appToken = (app: NestFastifyApplication, userId: string, ttlSec?: number, over: Record<string, unknown> = {}) =>
  app.get(TokensService).tokenFor(userId, ttlSec, over);
