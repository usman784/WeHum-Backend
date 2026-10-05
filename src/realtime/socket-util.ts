import { ZodError } from 'zod';
import type { Socket } from 'socket.io';
import { AppError } from '../common/errors';
import type { Ack } from './socket-events';

export const ok = <T>(data: T): Ack<T> => ({ ok: true, data });
export const fail = (code: string, extra?: Record<string, unknown>): Ack<never> => ({ ok: false, code, ...extra }) as Ack<never>;

/** Turns any failure inside an event handler into the standard ack, so a bad event never crashes the socket. */
export async function safely(fn: () => Promise<Ack<unknown>> | Ack<unknown>): Promise<Ack<unknown>> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof AppError) return fail(e.code);
    if (e instanceof ZodError) return fail('VALIDATION_FAILED', { fields: e.issues.map((i) => i.path.join('.')) });
    return fail('INTERNAL');
  }
}

/** `connect_error` the client can act on: `err.data.code` is TOKEN_EXPIRED / TOKEN_INVALID / UPDATE_REQUIRED / … */
export function connectError(code: string) {
  const e = new Error(code) as Error & { data: { code: string } };
  e.data = { code };
  return e;
}

/** 20 client events per 10 s per socket (spec §7.1); the rest are dropped with an `error` event. */
export function limitEvents(socket: Socket, limit = 20, windowMs = 10_000) {
  let windowStart = Date.now(), count = 0;
  socket.use((_packet, next) => {
    const now = Date.now();
    if (now - windowStart >= windowMs) { windowStart = now; count = 0; }
    if (++count > limit) { socket.emit('error', { code: 'RATE_LIMITED' }); return; } // dropped: next() is never called
    next();
  });
}

/** Emits `auth:expiring` 60 s before the token ends and disconnects when it does. Returns a function that clears the timers. */
export function watchExpiry(socket: Socket, expSec: number): () => void {
  const timers: NodeJS.Timeout[] = [];
  const left = expSec * 1000 - Date.now();
  if (left > 60_000) timers.push(setTimeout(() => socket.emit('auth:expiring', { exp: expSec }), left - 60_000));
  else if (left > 0) socket.emit('auth:expiring', { exp: expSec });
  timers.push(setTimeout(() => { socket.emit('error', { code: 'TOKEN_EXPIRED' }); socket.disconnect(true); }, Math.max(0, left)));
  return () => timers.forEach(clearTimeout);
}
