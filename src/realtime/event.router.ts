import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { adminUsers, jobs } from '../db/schema';
import { DRIZZLE, type DB } from '../infra/core.module';
import { RealtimeBus, type BusEvent } from '../infra/realtime-bus';
import { AdminGateway } from './admin.gateway';
import { LiveGateway } from './live.gateway';

const opOf = (action: string): 'create' | 'update' | 'delete' =>
  /\.(create|invite|duplicate)$/.test(action) ? 'create' : /\.(delete|remove)$/.test(action) ? 'delete' : 'update';

/**
 * Every API pod listens to the bus and emits to its own sockets (`.local`), so an event published anywhere reaches
 * every connected client exactly once, whichever pod holds the socket (spec §3).
 */
@Injectable()
export class EventRouter implements OnModuleInit {
  private readonly log = new Logger('EventRouter');
  private readonly names = new Map<string, { name: string; at: number }>();

  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly bus: RealtimeBus, private readonly live: LiveGateway, private readonly admin: AdminGateway) {}

  async onModuleInit() { await this.bus.subscribe((e) => void this.route(e).catch((err) => this.log.warn(`${e.topic}: ${(err as Error).message}`))); }

  private async adminName(id: string | null): Promise<{ id: string; name: string } | null> {
    if (!id) return null;
    const hit = this.names.get(id);
    if (hit && Date.now() - hit.at < 300_000) return { id, name: hit.name };
    const [a] = await this.db.select({ name: adminUsers.name }).from(adminUsers).where(eq(adminUsers.id, id));
    const name = a?.name ?? 'Unknown';
    this.names.set(id, { name, at: Date.now() });
    return { id, name };
  }

  async route({ topic, payload }: BusEvent) {
    const p = payload as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const live = this.live.server.local, admin = this.admin.server.local;
    switch (topic) {
      // ── CMS changes
      case 'entity:changed':
        admin.to('entities').emit('entity:changed', { type: p.type, id: p.id, op: opOf(String(p.action)), version: p.version ?? 0, by: await this.adminName(p.by ?? null) });
        break;
      case 'config:changed':
        live.to('config').emit('config:changed', p);
        admin.to('config').emit('config:changed', p);
        break;
      case 'catalog:changed': live.to('config').emit('catalog:changed', p); break;
      case 'job:progress': {
        const [j] = await this.db.select().from(jobs).where(eq(jobs.id, p.jobId));
        if (!j) break;
        const out = { id: j.id, type: j.type, status: j.status, progress: j.progress, ...(j.error && { error: j.error }), ...(j.result != null && { result: j.result }) };
        const to = admin.to('jobs');
        (j.createdBy ? to.to(`admin:${j.createdBy}`) : to).emit('job:progress', out);
        break;
      }
      case 'editing:presence': admin.to(`entity:${p.type}:${p.id}`).emit('editing:presence', p); break;
      case 'dashboard:kpis':
        admin.to('dashboard').emit('dashboard:kpis', p);
        admin.to('dashboard:mod').emit('dashboard:kpis', { moderationOpen: p.moderationOpen, at: p.at });
        break;
      // ── live numbers
      case 'live:agg':
        live.to('today').to('world').emit('live:agg', p);
        admin.to('dashboard').emit('live:agg', p);
        break;
      case 'session:live': live.to(`session:${p.sessionId}`).emit('session:live', p); break;
      case 'motd:stats': live.to(`motd:${p.date}`).emit('motd:stats', p); break;
      case 'lobby:state': live.to(`lobby:${p.date}`).emit('lobby:state', p); break;
      case 'group:start': live.to(`lobby:${p.date}`).emit('group:start', p); break;
      // ── per user / per admin
      case 'entitlement:changed': live.to(`user:${p.userId}`).emit('entitlement:changed', p.entitlement); break;
      case 'inbox:new': live.to(`user:${p.userId}`).emit('inbox:new', { item: p.item }); break;
      case 'force:logout': {
        const [nsp, room] = p.scope === 'admin' ? [admin, `admin:${p.id}`] : [live, `user:${p.id}`];
        nsp.to(room).emit('force:logout', { reason: p.reason });
        setTimeout(() => nsp.in(room).disconnectSockets(true), 200); // let the message out first
        break;
      }
      // ── community, moderation, subscriptions (emitted by their phases)
      case 'dedication:new': live.to(`session:${p.sessionId}`).emit('dedication:new', { sessionId: p.sessionId, items: p.items }); break;
      case 'dedication:holding': live.to(`session:${p.sessionId}`).emit('dedication:holding', { id: p.id, holdingCount: p.holdingCount }); break;
      case 'dedication:removed': live.to(`session:${p.sessionId}`).emit('dedication:removed', { id: p.id }); break;
      case 'gratitude:new': live.to(`gratitude:${p.kind}`).emit('gratitude:new', { kind: p.kind, item: p.item }); break;
      case 'gratitude:removed': live.to(`gratitude:${p.kind}`).emit('gratitude:removed', { kind: p.kind, id: p.id }); break;
      case 'moderation:new': admin.to('moderation').emit('moderation:new', p); break;
      case 'moderation:count': admin.to('role:owner').to('role:admin').to('role:moderator').emit('moderation:count', p); break;
      case 'subs:event': admin.to('subscriptions').emit('subs:event', p); break;
      case 'users:new': admin.to('users').emit('users:new', p); break;
      case 'notification:stats': admin.to('entities').emit('notification:stats', p); break;
      default: this.log.debug(`no route for ${topic}`);
    }
  }
}
