import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type Redis from 'ioredis';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { AppError } from '../../common/errors';
import type { AuthedRequest } from '../../common/auth';
import { auditLog, outboxEvents } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { K, REDIS } from '../../infra/redis';
import type { EntityType } from '../../realtime/socket-events';
import type { Role } from '../admin-auth/rbac';

export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
export interface Actor { id: string | null; role: Role | 'system'; ip: string | null; requestId: string }
/** Background jobs act as the system (audit shows no admin). */
export const SYSTEM_ACTOR = (job: string): Actor => ({ id: null, role: 'system', ip: null, requestId: job });

/** Who is doing this (admin token + client ip + request id) → goes into audit_log. */
export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  return { id: req.admin!.id, role: req.admin!.role, ip: req.ip, requestId: String(req.id) };
});

/** `If-Match: "v3"` (or `3`) → 3. Missing header → null (the edit is then last-write-wins). */
export function parseIfMatch(h: string | undefined): number | null {
  if (!h) return null;
  const m = /^(?:W\/)?"?v?(\d+)"?$/.exec(h.trim());
  if (!m) throw new AppError('VALIDATION_FAILED', 'If-Match must look like "v3"');
  return Number(m[1]);
}

export function assertVersion(ifMatch: string | undefined, current: { version: number }) {
  const v = parseIfMatch(ifMatch);
  if (v !== null && v !== current.version) throw new AppError('CONFLICT_VERSION', 'Someone else changed this meanwhile', { current });
}

export const etag = (version: number) => `"v${version}"`;

/** Only the keys whose value changed (compact audit before/after). */
export function changed<T extends Record<string, unknown>>(before: T, after: T) {
  const b: Record<string, unknown> = {}, a: Record<string, unknown> = {};
  for (const k of Object.keys(after)) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) { b[k] = before[k]; a[k] = after[k]; }
  return { before: b, after: a };
}

export interface WriteSpec { action: string; type: EntityType; id: string; catalog?: boolean; invalidate?: string[] }

/**
 * Every admin mutation goes through here (spec §5.5): one transaction that applies the change, writes the audit entry,
 * queues the `entity:changed` outbox event (and `catalog:changed` + a catalog version bump when app content changed).
 * Caches are dropped only after the commit, so a rolled-back write leaves no trace.
 */
@Injectable()
export class AdminWriter {
  constructor(@Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis) {}

  async run<T>(actor: Actor, spec: WriteSpec, fn: (tx: Tx) => Promise<{ result: T; before?: unknown; after?: unknown; version?: number; events?: { topic: string; payload: unknown }[] }>): Promise<T> {
    const out = await this.db.transaction(async (tx) => {
      const r = await fn(tx);
      await tx.insert(auditLog).values({
        actorId: actor.id, actorRole: actor.role, action: spec.action, targetType: spec.type, targetId: spec.id,
        before: (r.before ?? null) as object | null, after: (r.after ?? null) as object | null, ip: actor.ip, requestId: actor.requestId.slice(0, 40),
      });
      await tx.insert(outboxEvents).values({ topic: 'entity:changed', payload: { type: spec.type, id: spec.id, action: spec.action, version: r.version ?? null, by: actor.id } });
      for (const e of r.events ?? []) await tx.insert(outboxEvents).values({ topic: e.topic, payload: e.payload as object });
      let catalogVersion: number | null = null;
      if (spec.catalog) {
        const res = await tx.execute<{ version: number }>(sql`
          INSERT INTO app_config (key, value, version) VALUES ('catalog', jsonb_build_object('version', 2, 'updatedAt', now()), 2)
          ON CONFLICT (key) DO UPDATE SET version = app_config.version + 1, value = jsonb_build_object('version', app_config.version + 1, 'updatedAt', now()), updated_at = now()
          RETURNING version`);
        catalogVersion = res.rows[0]!.version;
        await tx.insert(outboxEvents).values({ topic: 'catalog:changed', payload: { version: catalogVersion } });
      }
      return { result: r.result, catalogVersion };
    });
    const keys = [...(spec.invalidate ?? []), ...(spec.catalog ? [K.config('catalog')] : [])];
    if (keys.length) await this.redis.del(...keys).catch(() => 0);
    return out.result;
  }
}

/** Row lock + If-Match check for versioned entities (themes, sessions, …). Throws 404 / 409 CONFLICT_VERSION. */
export async function lockVersioned<R extends { version: number }>(tx: Tx, table: PgTable, idCol: PgColumn, id: string | number, ifMatch: string | undefined, what: string): Promise<R> {
  const [row] = (await tx.select().from(table as never).where(eq(idCol, id)).for('update')) as unknown as R[];
  if (!row) throw new AppError('NOT_FOUND', `${what} not found`);
  assertVersion(ifMatch, row);
  return row;
}
