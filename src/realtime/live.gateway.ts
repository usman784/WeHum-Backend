import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { Namespace, Socket } from 'socket.io';
import { z } from 'zod';
import { compareVersions } from '../common/auth';
import { AppError } from '../common/errors';
import { users } from '../db/schema';
import { DRIZZLE, type DB } from '../infra/core.module';
import { REDIS } from '../infra/redis';
import { AuthService } from '../modules/auth/auth.service';
import { TokensService, type AppClaims } from '../modules/auth/tokens.service';
import { ConfigService, type MainConfig } from '../modules/config/config.service';
import { EntitlementService } from '../modules/entitlements/entitlement.service';
import { LiveService } from '../modules/live/live.service';
import { MotdService, addDaysIso, utcToday } from '../modules/motd/motd.service';
import { GroupService } from '../modules/today/group.service';
import { LobbyService } from './lobby.service';
import { PresenceService } from './presence.service';
import { connectError, fail, limitEvents, ok, safely, watchExpiry } from './socket-util';
import { metrics } from '../infra/metrics';
import { K } from '../infra/redis';

export const MAX_ROOMS = 4;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => { const t = Date.parse(d); return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d); }, 'Invalid date');
const RoomJoin = z.object({ room: z.string().max(60) }).strict();
/** today | world | motd:{date} | session:{uuid} | lobby:{date} */
const validRoom = (room: string) => room === 'today' || room === 'world'
  || (/^(motd|lobby):/.test(room) && date.safeParse(room.slice(room.indexOf(':') + 1)).success)
  || (room.startsWith('session:') && z.string().uuid().safeParse(room.slice(8)).success)
  || /^gratitude:(gratitude|affirmation|love)$/.test(room);
const TimeSync = z.object({ t0: z.number() }).strict();
const PresenceStart = z.object({
  meditationId: z.string().uuid(), sessionId: z.string().uuid().optional(), kind: z.enum(['motd', 'group', 'solo', 'silence', 'custom', 'program', 'sos', 'free']),
  lengthMin: z.number().int().min(1).max(180).optional(), mode: z.enum(['solo', 'group', 'silence']),
}).strict();
const MeditationRef = z.object({ meditationId: z.string().uuid() }).strict();
const LobbyRef = z.object({ date }).strict();
const Refresh = z.object({ token: z.string().min(20).max(4096) }).strict();

interface LiveSocketData { user: { id: string; isGuest: boolean; country: string | null }; installId?: string; exp: number; rooms: Set<string>; lobbies: Set<string>; clear?: () => void }
type LiveSocket = Socket & { data: LiveSocketData };

/** `/live`: the mobile app (spec §7.2). Websocket only; the server keeps no per-socket state that a reconnect cannot rebuild. */
@Injectable()
@WebSocketGateway({ namespace: '/live' })
export class LiveGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Namespace;
  private readonly log = new Logger('LiveGateway');
  private lobbyTimer?: NodeJS.Timeout;

  constructor(
    @Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis, private readonly tokens: TokensService, private readonly config: ConfigService,
    private readonly presence: PresenceService, private readonly lobby: LobbyService, private readonly live: LiveService, private readonly entitlements: EntitlementService,
    private readonly motd: MotdService, private readonly group: GroupService, private readonly auth: AuthService,
  ) {}

  afterInit(nsp: Namespace) {
    nsp.use((socket, next) => void this.authenticate(socket as LiveSocket).then(() => next(), (e) => next(e)));
    // lobby members stay "fresh" while their socket is connected to this pod
    this.lobbyTimer = setInterval(() => void this.touchLobbies(), 30_000);
    this.lobbyTimer.unref();
  }

  // ───────────── connection ─────────────
  private async verifyUser(token: string): Promise<AppClaims & { exp: number }> {
    const c = await this.tokens.verify<AppClaims>(token, 'wehum-app').catch((e) => { throw connectError(e instanceof AppError ? e.code : 'TOKEN_INVALID'); });
    if ((await this.tokens.tokenVersion(c.sub)) !== c.ver) throw connectError('TOKEN_INVALID');
    return c;
  }

  private async authenticate(socket: LiveSocket) {
    const a = (socket.handshake.auth ?? {}) as { token?: string; installId?: string; appVersion?: string; platform?: string };
    if (!a.token) throw connectError('AUTH_REQUIRED');
    const c = await this.verifyUser(a.token);
    const main = await this.config.value<MainConfig>('main');
    const min = a.platform === 'ios' || a.platform === 'android' ? main.minVersion[a.platform] : undefined;
    if (min && a.appVersion && compareVersions(a.appVersion, min) < 0) throw connectError('UPDATE_REQUIRED');
    const [u] = await this.db.select({ isGuest: users.isGuest, country: users.country, showCountry: users.showCountry, deletedAt: users.deletedAt }).from(users).where(eq(users.id, c.sub));
    if (!u || u.deletedAt) throw connectError('GONE');
    socket.data = { user: { id: c.sub, isGuest: u.isGuest, country: u.showCountry ? u.country : null }, installId: a.installId, exp: c.exp, rooms: new Set(), lobbies: new Set() };
  }

  handleConnection(socket: LiveSocket) {
    metrics.socketConnections.inc({ ns: 'live' });
    void socket.join([`user:${socket.data.user.id}`, 'config']);
    limitEvents(socket);
    socket.data.clear = watchExpiry(socket, socket.data.exp);
  }

  async handleDisconnect(socket: LiveSocket) {
    metrics.socketConnections.dec({ ns: 'live' });
    socket.data?.clear?.();
    // presence is kept for 90 s (a backgrounded app may come back); the lobby is left at once
    for (const d of socket.data?.lobbies ?? []) await this.lobby.leave(d, socket.data.user.id).catch(() => null);
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
    if (d < addDaysIso(utcToday(), -1) || d > addDaysIso(utcToday(), 1)) return fail('VALIDATION_FAILED', { fields: ['date'] });
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
