import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { eq, inArray } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { Namespace, Socket } from 'socket.io';
import { z } from 'zod';
import { compareVersions } from '../common/auth';
import { AppError } from '../common/errors';
import { users } from '../db/schema';
import { DRIZZLE, type DB } from '../infra/core.module';
import { RealtimeBus } from '../infra/realtime-bus';
import { REDIS } from '../infra/redis';
import { AuthService } from '../modules/auth/auth.service';
import { TokensService, type AppClaims } from '../modules/auth/tokens.service';
import { ConfigService, type MainConfig } from '../modules/config/config.service';
import { EntitlementService } from '../modules/entitlements/entitlement.service';
import { LiveService, silenceLive } from '../modules/live/live.service';
import { MotdService, addDaysIso, utcToday } from '../modules/motd/motd.service';
import { GroupService, isGlobalSlot, slotDate } from '../modules/today/group.service';
import { LobbyService } from './lobby.service';
import { ONLINE_TOUCH_MS, OnlineService, onlineUserOf, type OnlineUser } from './online.service';
import { PresenceService } from './presence.service';
import { connectError, fail, limitEvents, ok, safely, watchExpiry } from './socket-util';
import { metrics } from '../infra/metrics';
import { K } from '../infra/redis';

export const MAX_ROOMS = 4;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => { const t = Date.parse(d); return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d); }, 'Invalid date');
const RoomJoin = z.object({ room: z.string().max(60) }).strict();
/** today | world | motd:{date} | session:{uuid} | lobby:{date} */
const validRoom = (room: string) => room === 'today' || room === 'world' || room === 'silence'
  || (/^motd:/.test(room) && date.safeParse(room.slice(room.indexOf(':') + 1)).success)
  || (/^lobby:/.test(room) && slot.safeParse(room.slice(6)).success)
  || (room.startsWith('session:') && z.string().uuid().safeParse(room.slice(8)).success)
  || /^gratitude:(gratitude|affirmation|love)$/.test(room);
const TimeSync = z.object({ t0: z.number() }).strict();
const PresenceStart = z.object({
  meditationId: z.string().uuid(), sessionId: z.string().uuid().optional(), kind: z.enum(['motd', 'group', 'solo', 'silence', 'custom', 'program', 'sos', 'free']),
  lengthMin: z.number().int().min(1).max(180).optional(), mode: z.enum(['solo', 'group', 'silence']),
}).strict();
const MeditationRef = z.object({ meditationId: z.string().uuid() }).strict();
/** A lobby is identified by a slot: the date (daily sit) or date + UTC hour (`2026-10-12T08`, hourly sit). */
const slot = z.string().regex(/^(G\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]))?)$/).refine((d) => date.safeParse(slotDate(d)).success, 'Invalid date');
const LobbyRef = z.object({ date: slot }).strict();
const Refresh = z.object({ token: z.string().min(20).max(4096) }).strict();

interface LiveSocketData { user: OnlineUser; installId?: string; ver: number; exp: number; rooms: Set<string>; lobbies: Set<string>; clear?: () => void }
type LiveSocket = Socket & { data: LiveSocketData };

/** `/live`: the mobile app (spec §7.2). Websocket only; the server keeps no per-socket state that a reconnect cannot rebuild. */
@Injectable()
@WebSocketGateway({ namespace: '/live' })
export class LiveGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Namespace;
  private readonly log = new Logger('LiveGateway');
  private lobbyTimer?: NodeJS.Timeout;
  /** This pod's sockets per user (online state itself is kept across pods in Redis). */
  private readonly local = new Map<string, { sockets: Set<string>; user: LiveSocketData['user'] }>();
  private touching = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis, private readonly tokens: TokensService, private readonly config: ConfigService,
    private readonly presence: PresenceService, private readonly lobby: LobbyService, private readonly live: LiveService, private readonly entitlements: EntitlementService,
    private readonly motd: MotdService, private readonly group: GroupService, private readonly auth: AuthService,
    private readonly online: OnlineService, private readonly bus: RealtimeBus,
  ) {}

  afterInit(nsp: Namespace) {
    nsp.use((socket, next) => void this.authenticate(socket as LiveSocket).then(() => next(), (e) => next(e)));
    // lobby members and online users stay "fresh" while their socket is connected to this pod
    this.lobbyTimer = setInterval(() => { void this.touchLobbies(); void this.touchOnline(); }, ONLINE_TOUCH_MS);
    this.lobbyTimer.unref();
  }

  // ───────────── connection ─────────────
  private async verifyUser(token: string): Promise<AppClaims & { exp: number }> {
    const c = await this.tokens.verify<AppClaims>(token, 'wehum-app').catch((e) => { throw connectError(e instanceof AppError ? e.code : 'TOKEN_INVALID'); });
    const tv = await this.tokens.tokenVersion(c.sub);
    if (tv < 0 || tv !== c.ver) throw connectError('TOKEN_INVALID');
    return c;
  }

  private async authenticate(socket: LiveSocket) {
    const a = (socket.handshake.auth ?? {}) as { token?: string; installId?: string; appVersion?: string; platform?: string };
    if (!a.token) throw connectError('AUTH_REQUIRED');
    const c = await this.verifyUser(a.token);
    const main = await this.config.value<MainConfig>('main');
    const min = a.platform === 'ios' || a.platform === 'android' ? main.minVersion[a.platform] : undefined;
    if (min && a.appVersion && compareVersions(a.appVersion, min) < 0) throw connectError('UPDATE_REQUIRED');
    const [u] = await this.db.select({ isGuest: users.isGuest, country: users.country, showCountry: users.showCountry, city: users.city, cityLat: users.cityLat, cityLng: users.cityLng, deletedAt: users.deletedAt, deletingAt: users.deletingAt, suspendedAt: users.suspendedAt }).from(users).where(eq(users.id, c.sub));
    if (!u || u.deletedAt || u.deletingAt) throw connectError('GONE');
    if (u.suspendedAt) throw connectError('ACCOUNT_SUSPENDED');
    socket.data = { user: onlineUserOf({ id: c.sub, ...u }), installId: a.installId, ver: c.ver, exp: c.exp, rooms: new Set(), lobbies: new Set() };
  }

  handleConnection(socket: LiveSocket) {
    metrics.socketConnections.inc({ ns: 'live' });
    void socket.join([`user:${socket.data.user.id}`, 'config']);
    limitEvents(socket);
    // a socket that outlives its session (suspension, deletion, password reset) cannot act: the next event ends it
    socket.use((_packet, next) => {
      void this.tokens.tokenVersion(socket.data.user.id).then((v) => {
        if (v === socket.data.ver) return next();
        socket.emit('force:logout', { reason: v === -1 ? 'account_suspended' : 'signed_out' });
        socket.disconnect(true);
      }, () => next());
    });
    socket.data.clear = watchExpiry(socket, socket.data.exp);
    const u = socket.data.user;
    const mine = this.local.get(u.id) ?? this.local.set(u.id, { sockets: new Set(), user: u }).get(u.id)!;
    mine.sockets.add(socket.id);
    void this.cameOnline(u, [socket.id]);
  }

  async handleDisconnect(socket: LiveSocket) {
    metrics.socketConnections.dec({ ns: 'live' });
    socket.data?.clear?.();
    const u = socket.data?.user;
    const mine = u && this.local.get(u.id);
    if (mine) {
      mine.sockets.delete(socket.id);
      if (!mine.sockets.size) this.local.delete(u.id);
      await this.wentOffline(u.id, socket.id);
    }
    // presence is kept for 90 s (a backgrounded app may come back); the lobby is left at once
    for (const d of socket.data?.lobbies ?? []) await this.lobby.leave(d, socket.data.user.id).catch(() => null);
  }

  // ───────────── online (CMS: green dot, "Online now", the map)
  private async cameOnline(u: LiveSocketData['user'], socketIds: string[]) {
    try {
      if (await this.online.touch(u, socketIds)) await this.bus.publish('users:presence', { id: u.id, online: true, at: Date.now() });
    } catch (e) { this.log.warn(`online touch failed: ${(e as Error).message}`); }
  }

  /** A socket closed: offline only if it was the user's last one on any pod (decided atomically in Redis). */
  private async wentOffline(userId: string, socketId: string) {
    const now = new Date();
    try {
      if (!(await this.online.leave(userId, socketId))) return;
      await this.bus.publish('users:presence', { id: userId, online: false, at: now.getTime(), lastActiveAt: now.toISOString() });
    } catch (e) { this.log.warn(`online leave failed: ${(e as Error).message}`); return; }
    await this.db.update(users).set({ lastActiveAt: now }).where(eq(users.id, userId)).catch((e) => this.log.warn(`last active not saved: ${(e as Error).message}`));
  }

  /**
   * Every 30 s: keep this pod's users fresh in Redis, with their current guest/country flags (a guest who signed up, or
   * someone who hid their country, is right on the map within one cycle). Batches of 500, never two cycles at once.
   */
  private async touchOnline() {
    if (this.touching) return;
    this.touching = true;
    try {
      const all = [...this.local.values()];
      for (let i = 0; i < all.length; i += 500) {
        const batch = all.slice(i, i + 500);
        const rows = await this.db.select({ id: users.id, isGuest: users.isGuest, country: users.country, showCountry: users.showCountry, city: users.city, cityLat: users.cityLat, cityLng: users.cityLng }).from(users)
          .where(inArray(users.id, batch.map((b) => b.user.id))).catch(() => []);
        const fresh = new Map(rows.map((r) => [r.id, onlineUserOf(r)]));
        await Promise.all(batch.map((b) => {
          b.user = fresh.get(b.user.id) ?? b.user;
          return this.cameOnline(b.user, [...b.sockets]);
        }));
      }
    } finally { this.touching = false; }
  }

  private async touchLobbies() {
    const byDate = new Map<string, string[]>();
    for (const s of this.server.sockets.values() as Iterable<LiveSocket>) for (const d of s.data?.lobbies ?? []) (byDate.get(d) ?? byDate.set(d, []).get(d)!).push(s.data.user.id);
    for (const [d, ids] of byDate) await this.lobby.touch(d, [...new Set(ids)]).catch(() => null);
  }

  // ───────────── events ─────────────
  @SubscribeMessage('time:sync')
  timeSync(@MessageBody() body: unknown) { return safely(() => ok({ t0: TimeSync.parse(body).t0, serverTime: Date.now() })); }

  @SubscribeMessage('auth:refresh')
  refresh(@ConnectedSocket() socket: LiveSocket, @MessageBody() body: unknown) {
    return safely(async () => {
      const c = await this.verifyUser(Refresh.parse(body).token).catch((e) => { throw new AppError('TOKEN_INVALID', (e as Error).message); });
      if (c.sub !== socket.data.user.id) return fail('TOKEN_INVALID');
      socket.data.clear?.();
      socket.data.exp = c.exp;
      socket.data.clear = watchExpiry(socket, c.exp);
      return ok({ exp: c.exp });
    });
  }

  @SubscribeMessage('room:join')
  join(@ConnectedSocket() socket: LiveSocket, @MessageBody() body: unknown) {
    return safely(async () => {
      const { room } = RoomJoin.parse(body);
      if (!validRoom(room)) return fail('VALIDATION_FAILED', { fields: ['room'] });
      if (room.startsWith('lobby:')) return this.joinLobby(socket, room.slice(6));
      if (!socket.data.rooms.has(room) && socket.data.rooms.size + socket.data.lobbies.size >= MAX_ROOMS) return fail('ROOM_LIMIT');
      await socket.join(room);
      socket.data.rooms.add(room);
      await this.snapshotFor(socket, room);
      return ok({ joined: room });
    });
  }

  @SubscribeMessage('room:leave')
  leave(@ConnectedSocket() socket: LiveSocket, @MessageBody() body: unknown) {
    return safely(async () => {
      const { room } = RoomJoin.parse(body);
      if (room.startsWith('lobby:')) return this.leaveLobby(socket, room.slice(6));
      await socket.leave(room);
      socket.data.rooms.delete(room);
      return ok({ left: room });
    });
  }

  /** Sends the current state of a room right after joining, so the screen is never empty until the next tick. */
  private async snapshotFor(socket: LiveSocket, room: string) {
    if (room === 'today' || room === 'world') socket.emit('live:agg', await this.live.snapshot(utcToday()));
    else if (room === 'silence') { const s = await this.live.silence(); socket.emit('silence:live', silenceLive(s, s.at)); }
    else if (room.startsWith('session:')) socket.emit('session:live', { sessionId: room.slice(8), ...(await this.presence.sessionLive(room.slice(8))) });
    else if (room.startsWith('motd:')) socket.emit('motd:stats', { date: room.slice(5), practicedToday: await this.redis.scard(K.practiced(room.slice(5))) });
  }

  @SubscribeMessage('presence:start')
  presenceStart(@ConnectedSocket() socket: LiveSocket, @MessageBody() body: unknown) {
    return safely(async () => {
      const b = PresenceStart.parse(body);
      const r = await this.presence.start({ meditationId: b.meditationId, userId: socket.data.user.id, sessionId: b.sessionId, country: socket.data.user.country, mode: b.mode });
      if (r === 'forbidden') return fail('FORBIDDEN');
      const snap = await this.live.snapshot(utcToday());
      return ok({ together: { people: snap.total ?? 0, countries: snap.countries ?? 0 } });
    });
  }

  /** `ack` is optional here: when the app asks and the entry is gone, it learns it must send `presence:start` again. */
  @SubscribeMessage('presence:beat')
  presenceBeat(@ConnectedSocket() socket: LiveSocket, @MessageBody() body: unknown) {
    return safely(async () => {
      const found = await this.presence.beat(MeditationRef.parse(body).meditationId, socket.data.user.id);
      return found ? ok({}) : fail('NOT_FOUND');
    });
  }

  @SubscribeMessage('presence:stop')
  presenceStop(@ConnectedSocket() socket: LiveSocket, @MessageBody() body: unknown) {
    return safely(async () => { await this.presence.stop(MeditationRef.parse(body).meditationId, socket.data.user.id); return ok({}); });
  }

  @SubscribeMessage('lobby:join')
  lobbyJoin(@ConnectedSocket() socket: LiveSocket, @MessageBody() body: unknown) { return safely(() => this.joinLobby(socket, LobbyRef.parse(body).date)); }

  @SubscribeMessage('lobby:leave')
  lobbyLeave(@ConnectedSocket() socket: LiveSocket, @MessageBody() body: unknown) { return safely(() => this.leaveLobby(socket, LobbyRef.parse(body).date)); }

  private async joinLobby(socket: LiveSocket, d: string) {
    const ahead = isGlobalSlot(d) ? 8 : 1; // the weekly Global sit can be opened a few days before it
    if (slotDate(d) < addDaysIso(utcToday(), -1) || slotDate(d) > addDaysIso(utcToday(), ahead)) return fail('VALIDATION_FAILED', { fields: ['date'] });
    if (!(await this.entitlements.isActive(socket.data.user.id))) return fail('PREMIUM_REQUIRED'); // group meditation is part of the membership
    if (!socket.data.lobbies.has(d) && socket.data.rooms.size + socket.data.lobbies.size >= MAX_ROOMS) return fail('ROOM_LIMIT');
    await this.lobby.join(d, socket.data.user.id, socket.data.user.country);
    await socket.join(`lobby:${d}`);
    socket.data.lobbies.add(d);
    const st = await this.lobby.state(d);
    socket.emit('lobby:state', st);
    return ok({ startsAt: st.startsAt, waiting: st.waiting });
  }

  private async leaveLobby(socket: LiveSocket, d: string) {
    await this.lobby.leave(d, socket.data.user.id);
    await socket.leave(`lobby:${d}`);
    socket.data.lobbies.delete(d);
    return ok({ left: `lobby:${d}` });
  }

  onModuleDestroy() { if (this.lobbyTimer) clearInterval(this.lobbyTimer); }
}
