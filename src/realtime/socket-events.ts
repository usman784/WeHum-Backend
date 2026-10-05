/**
 * Socket.IO contract (spec §7). Copy this file into the CMS (`src/lib/socket-events.ts`);
 * the Flutter app mirrors it in `lib/core/realtime/socket_events.dart`.
 */
export type Ack<T = unknown> = { ok: true; data: T } | { ok: false; code: string };

export type LiveRoom = 'today' | 'world' | `motd:${string}` | `session:${string}` | `lobby:${string}`;

export interface LiveAgg {
  total: number;              // unique users meditating now
  countries: number;
  top: { c: string; n: number }[]; // ISO-2, top 50
  quiet: boolean;             // total < emptyRoomThreshold
  meditatedToday: number;
  vibration: number;          // 0–100
  at: number;                 // server ms
}

// ── /live (app)
export interface LiveClientToServer {
  'room:join': (p: { room: LiveRoom }, ack: (r: Ack) => void) => void;
  'room:leave': (p: { room: LiveRoom }) => void;
  'time:sync': (p: { t0: number }, ack: (r: Ack<{ t0: number; serverTime: number }>) => void) => void;
  'presence:start': (p: { meditationId: string; sessionId?: string; kind: string; lengthMin?: number; mode: 'solo' | 'group' | 'silence' },
    ack: (r: Ack<{ together: { people: number; countries: number } }>) => void) => void;
  'presence:beat': (p: { meditationId: string }) => void;
  'presence:stop': (p: { meditationId: string }) => void;
  'lobby:join': (p: { date: string }, ack: (r: Ack<{ startsAt: string; waiting: number }>) => void) => void;
  'lobby:leave': (p: { date: string }) => void;
  'auth:refresh': (p: { token: string }, ack: (r: Ack) => void) => void;
}

export interface LiveServerToClient {
  'live:agg': (p: LiveAgg) => void;
  'session:live': (p: { sessionId: string; people: number; countries: number }) => void;
  'motd:stats': (p: { date: string; practicedToday: number }) => void;
  'lobby:state': (p: { date: string; waiting: number; countries: number; regions: { r: string; n: number }[]; startsAt: string }) => void;
  'group:start': (p: { date: string; startsAt: string; sessionId: string; lengthMin: number; mediaKey: string }) => void;
  'dedication:new': (p: { sessionId: string; items: unknown[] }) => void;
  'dedication:holding': (p: { id: string; holdingCount: number }) => void;
  'dedication:removed': (p: { id: string }) => void;
  'entitlement:changed': (p: { active: boolean; productId: string | null; periodType: string | null; expiresAt: string | null; billingIssue: boolean }) => void;
  'inbox:new': (p: { item: unknown }) => void;
  'config:changed': (p: { key: string; version: number }) => void;
  'catalog:changed': (p: { version: number }) => void;
  'auth:expiring': (p: { exp: number }) => void;
  'force:logout': (p: { reason: string }) => void;
}

// ── /admin (CMS)
export type EntityType = 'session' | 'media' | 'theme' | 'teacher' | 'program' | 'motd' | 'dailyMessage' | 'soundBlock' | 'sos'
  | 'config' | 'notification' | 'challenge' | 'admin' | 'user';

export interface AdminClientToServer {
  subscribe: (p: { channels: string[] }, ack: (r: Ack<{ joined: string[] }>) => void) => void;
  unsubscribe: (p: { channels: string[] }) => void;
  'editing:start': (p: { type: EntityType; id: string }) => void;
  'editing:stop': (p: { type: EntityType; id: string }) => void;
  'auth:refresh': (p: { token: string }, ack: (r: Ack) => void) => void;
}

export interface AdminServerToClient {
  'entity:changed': (p: { type: EntityType; id: string; op: 'create' | 'update' | 'delete'; version: number; by: { id: string; name: string } | null }) => void;
  'dashboard:kpis': (p: { liveNow: number; meditationsToday: number; minutesToday: number; payingMembers: number; inTrial: number; mrrUsd: number; founding: { taken: number; cap: number; open: boolean }; moderationOpen: number; at: number }) => void;
  'live:agg': (p: LiveAgg) => void;
  'moderation:new': (p: { dedication: unknown; flags: string[] }) => void;
  'moderation:count': (p: { open: number }) => void;
  'subs:event': (p: { event: unknown }) => void;
  'users:new': (p: { count: number }) => void;
  'job:progress': (p: { id: string; type: string; status: string; progress: number; error?: string; result?: unknown }) => void;
  'editing:presence': (p: { type: EntityType; id: string; admins: { id: string; name: string }[] }) => void;
  'notification:stats': (p: { id: string; delivered: number; opened: number; failed: number }) => void;
  'auth:expiring': (p: { exp: number }) => void;
}
