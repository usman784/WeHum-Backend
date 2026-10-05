import { Inject, Injectable } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { Namespace, Socket } from 'socket.io';
import { z } from 'zod';
import { AppError } from '../common/errors';
import { adminUsers } from '../db/schema';
import { DRIZZLE, type DB } from '../infra/core.module';
import { RealtimeBus } from '../infra/realtime-bus';
import { K, REDIS } from '../infra/redis';
import { ALL_ROLES, CONTENT_ROLES, MODERATION_ROLES, type Role } from '../modules/admin-auth/rbac';
import { TokensService, type AdminClaims } from '../modules/auth/tokens.service';
import { LiveService } from '../modules/live/live.service';
import { utcToday } from '../modules/motd/motd.service';
import { connectError, fail, limitEvents, ok, safely, watchExpiry } from './socket-util';
import type { EntityType } from './socket-events';

const ENTITY_TYPES: EntityType[] = ['session', 'media', 'theme', 'teacher', 'program', 'motd', 'dailyMessage', 'soundBlock', 'sos', 'config', 'notification', 'challenge', 'admin', 'user'];
/** Who may listen to what (CMS spec §6.2). The UI hides things; this is the real check. */
const CHANNEL_ROLES: Record<string, readonly Role[]> = { dashboard: ALL_ROLES, moderation: MODERATION_ROLES, subscriptions: CONTENT_ROLES, users: CONTENT_ROLES, jobs: ALL_ROLES };
const Channels = z.object({ channels: z.array(z.string().max(120)).min(1).max(20) }).strict();
const Entity = z.object({ type: z.enum(ENTITY_TYPES as [EntityType, ...EntityType[]]), id: z.string().min(1).max(80) }).strict();
const Refresh = z.object({ token: z.string().min(20).max(4096) }).strict();
const EDIT_TTL_SEC = 3600;

interface AdminSocketData { admin: { id: string; role: Role; name: string }; exp: number; editing: Set<string>; clear?: () => void }
type AdminSocket = Socket & { data: AdminSocketData };

/** `/admin`: the CMS (spec §7.3). Same rules as `/live`: JWT in the handshake, acks, rate limit, `auth:expiring`. */
@Injectable()
@WebSocketGateway({ namespace: '/admin' })
export class AdminGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Namespace;

  constructor(
    @Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis, private readonly tokens: TokensService,
    private readonly bus: RealtimeBus, private readonly live: LiveService,
  ) {}

  afterInit(nsp: Namespace) { nsp.use((socket, next) => void this.authenticate(socket as AdminSocket).then(() => next(), (e) => next(e))); }

  private async verifyAdmin(token: string): Promise<AdminClaims & { exp: number }> {
    const c = await this.tokens.verify<AdminClaims>(token, 'wehum-cms').catch((e) => { throw connectError(e instanceof AppError ? e.code : 'TOKEN_INVALID'); });
    if (c.ver !== (await this.tokens.adminVersion(c.sub))) throw connectError('TOKEN_INVALID');
    return c;
  }

  private async authenticate(socket: AdminSocket) {
    const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
    if (!token) throw connectError('AUTH_REQUIRED');
    const c = await this.verifyAdmin(token);
    const [a] = await this.db.select({ status: adminUsers.status, name: adminUsers.name, role: adminUsers.role }).from(adminUsers).where(eq(adminUsers.id, c.sub));
    if (!a || a.status !== 'active') throw connectError('TOKEN_INVALID');
    socket.data = { admin: { id: c.sub, role: a.role, name: a.name }, exp: c.exp, editing: new Set() };
  }

  handleConnection(socket: AdminSocket) {
    const { id, role } = socket.data.admin;
    void socket.join([`admin:${id}`, `role:${role}`, 'config', 'entities']);
    limitEvents(socket);
    socket.data.clear = watchExpiry(socket, socket.data.exp);
  }

  async handleDisconnect(socket: AdminSocket) {
    socket.data?.clear?.();
    for (const key of [...(socket.data?.editing ?? [])]) { const [type, id] = key.split('|') as [string, string]; await this.stopEditing(socket, type, id).catch(() => null); }
  }

  @SubscribeMessage('subscribe')
  subscribe(@ConnectedSocket() socket: AdminSocket, @MessageBody() body: unknown) {
    return safely(async () => {
      const { channels } = Channels.parse(body);
      const joined: string[] = [], denied: string[] = [];
      for (const ch of channels) {
        const room = this.roomFor(socket.data.admin.role, ch);
        if (!room) { denied.push(ch); continue; }
        await socket.join(room);
        joined.push(ch);
        await this.snapshot(socket, ch);
      }
      return ok({ joined, ...(denied.length && { denied }) });
    });
  }

  @SubscribeMessage('unsubscribe')
  unsubscribe(@ConnectedSocket() socket: AdminSocket, @MessageBody() body: unknown) {
    return safely(async () => {
      for (const ch of Channels.parse(body).channels) { const room = this.roomFor(socket.data.admin.role, ch); if (room) await socket.leave(room); }
      return ok({});
    });
  }

  /** `null` = not allowed. Moderators only get the moderation slice of the dashboard. */
  private roomFor(role: Role, channel: string): string | null {
    if (channel in CHANNEL_ROLES) {
      if (!CHANNEL_ROLES[channel]!.includes(role)) return null;
      return channel === 'dashboard' && role === 'moderator' ? 'dashboard:mod' : channel;
    }
    const m = /^entity:([A-Za-z]+):(.{1,80})$/.exec(channel);
    return m && ENTITY_TYPES.includes(m[1] as EntityType) && CONTENT_ROLES.includes(role) ? channel : null;
  }

  private async snapshot(socket: AdminSocket, channel: string) {
    if (channel !== 'dashboard') return;
    const raw = await this.redis.get(K.dashKpisLast);
    if (raw) {
      const k = JSON.parse(raw) as { moderationOpen: number; at: number };
      socket.emit('dashboard:kpis', socket.data.admin.role === 'moderator' ? { moderationOpen: k.moderationOpen, at: k.at } : k);
    }
    if (socket.data.admin.role !== 'moderator') socket.emit('live:agg', await this.live.snapshot(utcToday()));
  }

  // ───────────── who is editing what ─────────────
  @SubscribeMessage('editing:start')
  editingStart(@ConnectedSocket() socket: AdminSocket, @MessageBody() body: unknown) {
    return safely(async () => {
      const { type, id } = Entity.parse(body);
      if (!CONTENT_ROLES.includes(socket.data.admin.role)) return fail('FORBIDDEN');
      const key = K.editing(type, id);
      await this.redis.multi().hset(key, socket.id, JSON.stringify({ id: socket.data.admin.id, name: socket.data.admin.name })).expire(key, EDIT_TTL_SEC).exec();
      socket.data.editing.add(`${type}|${id}`);
      await socket.join(`entity:${type}:${id}`);
      await this.publishPresence(type, id);
      return ok({});
    });
  }

  @SubscribeMessage('editing:stop')
  editingStop(@ConnectedSocket() socket: AdminSocket, @MessageBody() body: unknown) {
    return safely(async () => { const { type, id } = Entity.parse(body); await this.stopEditing(socket, type, id); return ok({}); });
  }

  private async stopEditing(socket: AdminSocket, type: string, id: string) {
    await this.redis.hdel(K.editing(type, id), socket.id);
    socket.data.editing.delete(`${type}|${id}`);
    await this.publishPresence(type, id);
  }

  /** One entry per admin, however many tabs they have open. */
  private async publishPresence(type: string, id: string) {
    const all = Object.values(await this.redis.hgetall(K.editing(type, id))).map((v) => JSON.parse(v) as { id: string; name: string });
    const admins = [...new Map(all.map((a) => [a.id, a])).values()].sort((a, b) => a.name.localeCompare(b.name));
    await this.bus.publish('editing:presence', { type, id, admins });
  }

  @SubscribeMessage('auth:refresh')
  refresh(@ConnectedSocket() socket: AdminSocket, @MessageBody() body: unknown) {
    return safely(async () => {
      const c = await this.verifyAdmin(Refresh.parse(body).token).catch((e) => { throw new AppError('TOKEN_INVALID', (e as Error).message); });
      if (c.sub !== socket.data.admin.id) return fail('TOKEN_INVALID');
      socket.data.clear?.();
      socket.data.exp = c.exp;
      socket.data.clear = watchExpiry(socket, c.exp);
      return ok({ exp: c.exp });
    });
  }
}
