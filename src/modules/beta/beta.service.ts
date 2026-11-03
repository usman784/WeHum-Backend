import { Inject, Injectable, Logger } from '@nestjs/common';
import argon2 from 'argon2';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type Redis from 'ioredis';
import { randomBytes } from 'node:crypto';
import { v7 as uuid } from 'uuid';
import { AppError } from '../../common/errors';
import { clampLimit, decodeCursor, encodeCursor } from '../../common/pagination';
import { env } from '../../config/env';
import {
  authIdentities, betaBatches, betaDeletions, betaGrants, betaOps, deletedIdentities, jobs, outboxEvents, refreshTokens, savedMessages, seedFixtures, userStats, users,
} from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { K, REDIS } from '../../infra/redis';
import { QUEUES, QueueService } from '../../jobs/queues';
import { OnlineService } from '../../realtime/online.service';
import { AdminWriter, SYSTEM_ACTOR, type Actor } from '../admin/admin-writer';
import { resolveAccess } from '../entitlements/access';
import { EntitlementService } from '../entitlements/entitlement.service';
import { toCsv, UserDataService } from '../users-admin/user-data.service';
import { cleanDomain, initialPassword, LOGIN_RE, loginFor, parseImport, passwordOk } from './beta.logins';

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
export type SeedPreset = 'blank' | 'profile' | 'light';
export type BulkAction = 'grant' | 'extend' | 'remove' | 'suspend' | 'resume' | 'delete' | 'reset_sample';

export interface ListFilter { batchId?: string; q?: string; access?: 'free' | 'beta' | 'paid'; state?: 'active' | 'suspended' | 'deleting'; presence?: 'online' | 'offline' }
export interface CreateInput { name: string; count: number; prefix: string; access: 'free' | 'premium' | 'mixed'; premiumCount?: number; freeCount?: number; premiumDays?: number; premiumExpiresAt?: string; seedPreset: SeedPreset }
export interface BulkParams { days?: number; expiresAt?: string; reason?: string; confirm?: string }

const NAMES = ['Alex Rivers', 'Sam Morgan', 'Jordan Lee', 'Taylor Brooks', 'Casey Quinn', 'Riley Hayes', 'Morgan Ellis', 'Avery Stone', 'Jamie Fox', 'Robin Vale'];
const BIO = 'Sample profile created for beta testing.';
const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
const day = (d: Date) => d.toISOString().slice(0, 10);
/** Anything we show an admin about a failure: short, no secrets. */
const brief = (e: unknown) => (e instanceof AppError ? e.message : (e as Error).message ?? 'Failed').slice(0, 280);

/**
 * Beta tester management. Test accounts are ordinary users flagged by the server (`is_test_account`); every method here
 * scopes to that flag, so a regular member id can never be reached through a beta route.
 */
@Injectable()
export class BetaService {
  private readonly log = new Logger('Beta');

  constructor(
    @Inject(DRIZZLE) private readonly db: DB, @Inject(REDIS) private readonly redis: Redis, private readonly writer: AdminWriter, private readonly ent: EntitlementService,
    private readonly queues: QueueService, private readonly online: OnlineService, private readonly data: UserDataService,
  ) {}

  // ───────────── scoping helpers ─────────────

  private lock(tx: Tx, key: string) { return tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`); }

  /** The one place that decides "this id is a test account": anything else looks like it does not exist. */
  private async scoped(db: DB | Tx, id: string) {
    const [u] = await db.select({ id: users.id, login: users.username, test: users.isTestAccount, sus: users.suspendedAt, del: users.deletingAt, gone: users.deletedAt, batch: users.betaBatchId }).from(users).where(eq(users.id, id));
    if (!u || !u.test || u.gone) throw new AppError('NOT_FOUND', 'Test account not found');
    return u;
  }

  private async progress(jobId: string, patch: Partial<typeof jobs.$inferInsert>) {
    await this.db.transaction(async (tx) => {
      const [j] = await tx.update(jobs).set({ ...patch, updatedAt: new Date() }).where(eq(jobs.id, jobId)).returning({ id: jobs.id, status: jobs.status, progress: jobs.progress });
      if (j) await tx.insert(outboxEvents).values({ topic: 'job:progress', payload: { jobId: j.id, status: j.status, progress: j.progress } });
    });
  }

  private changed(batchId: string | null, action: string) {
    return this.db.insert(outboxEvents).values({ topic: 'entity:changed', payload: { type: 'betaBatch', id: batchId ?? 'all', action, version: null, by: null } });
  }

  // ───────────── list, summary ─────────────

  private conds(f: ListFilter, onlineIds: string[] | null): SQL[] {
    const paid = sql`(e.active and (e.expires_at is null or e.expires_at > now()))`;
    const beta = sql`(g.user_id is not null and g.revoked_at is null and g.expires_at > now())`;
    const c: SQL[] = [sql`u.is_test_account`, sql`u.deleted_at is null`];
    if (f.batchId) c.push(sql`u.beta_batch_id = ${f.batchId}::uuid`);
    if (f.q) {
      const like = f.q.replace(/[\\%_]/g, (x) => `\\${x}`);
      const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(f.q);
      c.push(isId ? sql`u.id = ${f.q}::uuid` : sql`(u.username ilike ${like + '%'} or u.first_name ilike ${'%' + like + '%'})`);
    }
    if (f.access === 'paid') c.push(paid);
    if (f.access === 'beta') c.push(beta);
    if (f.access === 'free') c.push(sql`not coalesce(${paid}, false) and not ${beta}`);
    if (f.state === 'active') c.push(sql`u.suspended_at is null and u.deleting_at is null`);
    if (f.state === 'suspended') c.push(sql`u.suspended_at is not null and u.deleting_at is null`);
    if (f.state === 'deleting') c.push(sql`u.deleting_at is not null`);
    if (f.presence && onlineIds) {
      const arr = `{${onlineIds.join(',')}}`;
      c.push(f.presence === 'online' ? (onlineIds.length ? sql`u.id = ANY(${arr}::uuid[])` : sql`false`) : (onlineIds.length ? sql`not (u.id = ANY(${arr}::uuid[]))` : sql`true`));
    }
    return c;
  }

  /** Online users that are test accounts: the full online set (all members) is never sent to the database. */
  private async onlineTestIds() {
    const all = await this.online.ids().catch(() => [] as string[]);
    if (!all.length) return all;
    const rows = await this.db.select({ id: users.id }).from(users).where(and(inArray(users.id, all), eq(users.isTestAccount, true)));
    return rows.map((r) => r.id);
  }

  private static readonly FROM = sql`from users u left join entitlements e on e.user_id = u.id left join beta_grants g on g.user_id = u.id left join beta_batches b on b.id = u.beta_batch_id left join (select distinct on (user_id) user_id, state, error from beta_ops where user_id is not null order by user_id, created_at desc) o on o.user_id = u.id`;

  async summary(batchId?: string) {
    const ids = await this.onlineTestIds();
    const c = this.conds({ batchId }, null);
    const arr = `{${ids.join(',')}}`;
    const [r] = (await this.db.execute<Record<string, number>>(sql`select count(*)::int as total,
        count(*) filter (where g.user_id is not null and g.revoked_at is null and g.expires_at > now())::int as beta,
        count(*) filter (where e.active and (e.expires_at is null or e.expires_at > now()))::int as paid,
        count(*) filter (where not coalesce(e.active and (e.expires_at is null or e.expires_at > now()), false) and not (g.user_id is not null and g.revoked_at is null and g.expires_at > now()))::int as free,
        count(*) filter (where u.suspended_at is not null and u.deleting_at is null)::int as suspended,
        count(*) filter (where u.deleting_at is not null)::int as deleting,
        count(*) filter (where ${ids.length ? sql`u.id = ANY(${arr}::uuid[])` : sql`false`})::int as online
      ${BetaService.FROM} where ${sql.join(c, sql` and `)}`)).rows;
    return r!;
  }

  private mapRow(r: Record<string, any>, online: Set<string>) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const acc = resolveAccess(r.e_active == null ? null : { active: r.e_active, expiresAt: r.e_exp ? new Date(r.e_exp) : null }, r.g_exp ? { expiresAt: new Date(r.g_exp), revokedAt: r.g_revoked ? new Date(r.g_revoked) : null } : null, { suspended: false, deleting: false });
    const state = r.deleting_at ? 'deleting' : r.suspended_at ? 'suspended' : 'active';
    const provisioning = r.op_state === 'ready' || !r.op_state ? 'ready' : r.op_error ? (r.op_state === 'pending' ? 'failed' : 'partial') : 'creating';
    return {
      id: r.id as string, login: r.username as string, email: r.email as string | null, name: r.first_name as string | null,
      batch: r.beta_batch_id && r.batch_name ? { id: r.beta_batch_id as string, name: r.batch_name as string } : null,
      state, suspendedReason: state === 'suspended' ? (r.suspended_reason as string | null) : null,
      access: { source: acc.source, paidExpiresAt: acc.paidActive ? (r.e_exp ?? null) : null, betaExpiresAt: acc.betaActive ? acc.betaExpiresAt : null, label: acc.source === 'paid+beta' ? 'Paid plus beta premium' : acc.source === 'paid' ? 'Paid' : acc.source === 'beta' ? 'Beta premium' : 'Free' },
      online: online.has(r.id as string), lastActiveAt: r.last_active_at as string, createdAt: r.created_at as string,
      provisioning, provisioningError: (r.op_error as string | null) ?? null, seedPreset: r.seed_preset as string | null,
    };
  }

  async list(f: ListFilter, cursor?: string, limit = 30) {
    const lim = clampLimit(limit, 30);
    const ids = f.presence ? await this.onlineTestIds() : null;
    const c = this.conds(f, ids);
    const cur = decodeCursor(cursor);
    // how many accounts match the filters (the CMS "select all matching" count); only asked for on the first page
    const total = cur ? undefined : (await this.db.execute<{ n: number }>(sql`select count(*)::int as n ${BetaService.FROM} where ${sql.join(c, sql` and `)}`)).rows[0]!.n;
    if (cur) c.push(sql`(u.username::text, u.id) > (${String(cur.k)}, ${cur.id}::uuid)`);
    const rows = (await this.db.execute<Record<string, any>>(sql`select u.id, u.username, u.email, u.first_name, u.beta_batch_id, b.name as batch_name, u.suspended_at, u.suspended_reason, u.deleting_at, u.last_active_at, u.created_at, u.seed_preset,
        e.active as e_active, e.expires_at as e_exp, g.expires_at as g_exp, g.revoked_at as g_revoked, o.state as op_state, o.error as op_error
      ${BetaService.FROM} where ${sql.join(c, sql` and `)} order by u.username::text asc, u.id asc limit ${lim + 1}`)).rows; // eslint-disable-line @typescript-eslint/no-explicit-any
    const page = rows.slice(0, lim);
    const on = await this.online.isOnline(page.map((r) => String(r.id))).catch(() => new Set<string>());
    return { data: page.map((r) => this.mapRow(r, on)), meta: { ...(total !== undefined && { total }), nextCursor: rows.length > lim ? encodeCursor(String(page.at(-1)!.username), String(page.at(-1)!.id)) : null } };
  }

  /** Non-secret list for download: never any password. */
  async listCsv(f: ListFilter) {
    const ids = f.presence ? await this.onlineTestIds() : null;
    const rows = (await this.db.execute<Record<string, any>>(sql`select u.id, u.username, u.email, u.first_name, b.name as batch_name, u.suspended_at, u.deleting_at, u.last_active_at, u.created_at, u.seed_preset,
        e.active as e_active, e.expires_at as e_exp, g.expires_at as g_exp, g.revoked_at as g_revoked, o.state as op_state, o.error as op_error, u.beta_batch_id, u.suspended_reason
      ${BetaService.FROM} where ${sql.join(this.conds(f, ids), sql` and `)} order by u.username asc limit 5000`)).rows; // eslint-disable-line @typescript-eslint/no-explicit-any
    return toCsv(rows.map((r) => { const m = this.mapRow(r, new Set()); return { login: m.login, email: m.email, name: m.name, group: m.batch?.name, state: m.state, access: m.access.label, beta_expires: m.access.betaExpiresAt, last_active: m.lastActiveAt }; }));
  }

  /** Every id matching a filter, as a stable snapshot (newer accounts are not part of a running job). */
  private async resolveAll(f: ListFilter) {
    const ids = f.presence ? await this.onlineTestIds() : null;
    const rows = (await this.db.execute<{ id: string }>(sql`select u.id ${BetaService.FROM} where ${sql.join(this.conds(f, ids), sql` and `)} order by u.username limit 2000`)).rows;
    return rows.map((r) => r.id);
  }

  async resolve(sel: { ids: string[] } | { all: true; filter: ListFilter }) {
    if ('ids' in sel) {
      const uniq = [...new Set(sel.ids)];
      const ok = await this.db.select({ id: users.id }).from(users).where(and(inArray(users.id, uniq), eq(users.isTestAccount, true), isNull(users.deletedAt)));
      if (ok.length !== uniq.length) throw new AppError('VALIDATION_FAILED', 'Some of the selected accounts are not beta test accounts', { rejected: uniq.length - ok.length });
      return uniq;
    }
    return this.resolveAll(sel.filter);
  }

  // ───────────── batches, generation ─────────────

  private normalize(i: CreateInput) {
    const domain = cleanDomain(env.BETA_TEST_EMAIL_DOMAIN);
    if (!domain) throw new AppError('INVALID_STATE', 'Set BETA_TEST_EMAIL_DOMAIN to a company-controlled domain before creating test accounts');
    if (i.count > env.BETA_MAX_ACCOUNTS) throw new AppError('VALIDATION_FAILED', `At most ${env.BETA_MAX_ACCOUNTS} accounts at once`, { fields: [{ path: 'count', message: `At most ${env.BETA_MAX_ACCOUNTS}` }] });
    const premium = i.access === 'premium' ? i.count : i.access === 'free' ? 0 : (i.premiumCount ?? 0);
    if (i.access === 'mixed') {
      if (premium < 1 || premium >= i.count) throw new AppError('VALIDATION_FAILED', 'Mixed needs at least one premium and one free account', { fields: [{ path: 'premiumCount', message: 'Between 1 and the total minus 1' }] });
      if (i.freeCount !== undefined && i.freeCount + premium !== i.count) throw new AppError('VALIDATION_FAILED', 'Premium and free counts must add up to the total', { fields: [{ path: 'freeCount', message: 'Premium + free must equal the total' }] });
    }
    let expires: Date | null = null;
    if (premium > 0) {
      if ((i.premiumDays === undefined) === (i.premiumExpiresAt === undefined)) throw new AppError('VALIDATION_FAILED', 'Give either a number of days or an expiry date for premium', { fields: [{ path: 'premiumDays', message: 'Days or expiry date, not both' }] });
      expires = i.premiumDays !== undefined ? new Date(Date.now() + i.premiumDays * 86_400_000) : new Date(i.premiumExpiresAt!);
      if (!(expires.getTime() > Date.now() + 60_000) || expires.getTime() > Date.now() + 366 * 86_400_000) throw new AppError('VALIDATION_FAILED', 'Premium must end between now and one year from now', { fields: [{ path: 'premiumExpiresAt', message: 'Must be in the future, within a year' }] });
    }
    if (!passwordOk(loginFor(i.prefix, 1))) throw new AppError('VALIDATION_FAILED', 'The login prefix is too short: passwords (login + we) need at least 8 characters', { fields: [{ path: 'prefix', message: 'Use at least 3 characters' }] });
    return { domain, premium, expires };
  }

  /** What the form shows before submitting. The example logins are illustrative (always 001–003); the real numbers are picked at creation. */
  preview(i: CreateInput) {
    const { domain, premium, expires } = this.normalize(i);
    return {
      total: i.count, premium, free: i.count - premium, premiumExpiresAt: expires, domain, seedPreset: i.seedPreset,
      passwordStyle: 'Username + we (example: beta001we)',
      examples: [1, 2, 3].map((n) => ({ login: loginFor(i.prefix, n), email: `${loginFor(i.prefix, n)}@${domain}`, password: initialPassword(loginFor(i.prefix, n)) })),
    };
  }

  /** Next free numbers for a prefix: above every login ever used (accounts, plans and deleted tombstones), so a login is never reused. */
  private async nextNumbers(tx: Tx, prefix: string, count: number) {
    const re = `^${prefix}[0-9]+$`;
    const [r] = (await tx.execute<{ m: number | null }>(sql`select max(n)::int as m from (
        select substring(login from ${prefix.length + 1}::int)::bigint as n from beta_ops where login ~ ${re}
        union all select substring(username::text from ${prefix.length + 1}::int)::bigint from users where username::text ~ ${re}
        union all select substring(login from ${prefix.length + 1}::int)::bigint from deleted_identities where login ~ ${re}) t`)).rows;
    const start = (r?.m ?? 0) + 1;
    const width = Math.max(3, String(start + count - 1).length);
    return Array.from({ length: count }, (_, k) => loginFor(prefix, start + k, width));
  }

  async createBatch(actor: Actor, i: CreateInput) {
    const { domain, premium, expires } = this.normalize(i);
    const batchId = uuid(), jobId = uuid();
    const out = await this.writer.run(actor, { action: 'beta.batch.create', type: 'betaBatch', id: batchId }, async (tx) => {
      await this.lock(tx, `beta:${i.prefix}`);
      const logins = await this.nextNumbers(tx, i.prefix, i.count);
      if (logins.some((l) => !passwordOk(l))) throw new AppError('VALIDATION_FAILED', 'A generated password would break the password policy');
      await tx.insert(jobs).values({ id: jobId, type: 'beta_generate', status: 'queued', payload: { batchId }, createdBy: actor.id });
      await tx.insert(betaBatches).values({ id: batchId, name: i.name, prefix: i.prefix, emailDomain: domain, total: i.count, premiumCount: premium, grantExpiresAt: expires, seedPreset: i.seedPreset, source: 'generate', status: 'creating', jobId, createdBy: actor.id });
      await tx.insert(betaOps).values(logins.map((login, k) => ({
        opRef: `${batchId}:${login}`, batchId, login, email: `${login}@${domain}`, intendedPremium: k < premium, grantExpiresAt: k < premium ? expires : null,
        displayName: i.seedPreset === 'blank' ? null : NAMES[k % NAMES.length]!,
      })));
      return { result: { batchId, jobId, firstLogin: logins[0]!, lastLogin: logins.at(-1)! }, after: { name: i.name, count: i.count, premium, seedPreset: i.seedPreset, firstLogin: logins[0], lastLogin: logins.at(-1) } };
    });
    await this.queues.add(QUEUES.cron, 'beta.generate', { jobId, batchId }, { jobId: `beta-gen-${batchId}`, attempts: 2, backoff: { type: 'exponential', delay: 5000 } });
    return out;
  }

  async previewImport(text: string) {
    const domain = cleanDomain(env.BETA_TEST_EMAIL_DOMAIN);
    if (!domain) throw new AppError('INVALID_STATE', 'Set BETA_TEST_EMAIL_DOMAIN to a company-controlled domain before importing test accounts');
    const { rows, fileError } = parseImport(text, env.BETA_MAX_ACCOUNTS);
    if (fileError) throw new AppError('VALIDATION_FAILED', fileError);
    const logins = rows.map((r) => r.login).filter((l) => LOGIN_RE.test(l)); // only well-formed logins reach the database
    const taken = new Set<string>();
    if (logins.length) {
      const arr = `{${logins.join(',')}}`, mails = `{${logins.map((l) => `${l}@${domain}`).join(',')}}`;
      const t = await this.db.execute<{ l: string }>(sql`select login as l from beta_ops where login = ANY(${arr}::text[])
        union select username::text from users where username = ANY(${arr}::citext[])
        union select login from deleted_identities where login = ANY(${arr}::text[])
        union select split_part(email::text, '@', 1) from users where email = ANY(${mails}::citext[])`);
      for (const r of t.rows) taken.add(r.l);
    }
    const out = rows.map((r) => ({ ...r, errors: taken.has(r.login) ? [...r.errors, 'This login is already used (accounts are never converted or reused)'] : r.errors }));
    return { domain, rows: out.map((r) => ({ ...r, ok: r.errors.length === 0 })), valid: out.filter((r) => !r.errors.length).length, invalid: out.filter((r) => r.errors.length).length };
  }

  async importBatch(actor: Actor, name: string, text: string, skipInvalid: boolean, seedPreset: SeedPreset) {
    const prev = await this.previewImport(text);
    if (prev.invalid && !skipInvalid) throw new AppError('VALIDATION_FAILED', `${prev.invalid} rows have errors; fix them or import only the valid rows`, { invalid: prev.invalid });
    const good = prev.rows.filter((r) => r.ok);
    if (!good.length) throw new AppError('VALIDATION_FAILED', 'There are no valid rows to import');
    const batchId = uuid(), jobId = uuid();
    const premium = good.filter((r) => r.premium);
    const out = await this.writer.run(actor, { action: 'beta.batch.import', type: 'betaBatch', id: batchId }, async (tx) => {
      await tx.insert(jobs).values({ id: jobId, type: 'beta_generate', status: 'queued', payload: { batchId }, createdBy: actor.id });
      await tx.insert(betaBatches).values({ id: batchId, name, prefix: 'import', emailDomain: prev.domain, total: good.length, premiumCount: premium.length, grantExpiresAt: null, seedPreset, source: 'import', status: 'creating', jobId, createdBy: actor.id });
      await tx.insert(betaOps).values(good.map((r) => ({
        opRef: `${batchId}:${r.login}`, batchId, login: r.login, email: `${r.login}@${prev.domain}`, intendedPremium: r.premium,
        grantExpiresAt: r.premium ? new Date(Date.now() + r.days! * 86_400_000) : null, displayName: r.displayName,
      })));
      return { result: { batchId, jobId, imported: good.length, skipped: prev.invalid }, after: { name, imported: good.length, skipped: prev.invalid } };
    });
    await this.queues.add(QUEUES.cron, 'beta.generate', { jobId, batchId }, { jobId: `beta-gen-${batchId}`, attempts: 2, backoff: { type: 'exponential', delay: 5000 } });
    return out;
  }

  async batches() {
    const rows = (await this.db.execute<Record<string, any>>(sql`select b.id, b.name, b.prefix, b.total, b.premium_count, b.grant_expires_at, b.seed_preset, b.source, b.status, b.job_id, b.created_at,
        count(u.id) filter (where u.deleted_at is null)::int as accounts, count(o.op_ref) filter (where o.state = 'ready')::int as ready, count(o.op_ref) filter (where o.state <> 'ready' and o.state <> 'deleted' and o.error is not null)::int as failed,
        count(u.id) filter (where u.suspended_at is not null and u.deleting_at is null)::int as suspended, count(u.id) filter (where u.deleting_at is not null)::int as deleting
      from beta_batches b left join users u on u.beta_batch_id = b.id left join beta_ops o on o.batch_id = b.id and o.user_id = u.id
      group by b.id order by b.created_at desc limit 100`)).rows; // eslint-disable-line @typescript-eslint/no-explicit-any
    return rows.map((r) => ({
      id: r.id, name: r.name, prefix: r.prefix, total: r.total, premiumCount: r.premium_count, grantExpiresAt: r.grant_expires_at, seedPreset: r.seed_preset, source: r.source, status: r.status, jobId: r.job_id, createdAt: r.created_at,
      accounts: r.accounts, ready: r.ready, failed: r.failed, suspended: r.suspended, deleting: r.deleting,
      credentialsAvailable: Date.now() - new Date(r.created_at).getTime() < env.BETA_CREDENTIALS_EXPORT_DAYS * 86_400_000,
    }));
  }

  /** Generation/import job: idempotent per account (`op_ref`), so a retry finishes the missing steps and nothing else. */
  async runGenerate(jobId: string, batchId: string) {
    const [batch] = await this.db.select().from(betaBatches).where(eq(betaBatches.id, batchId));
    if (!batch) throw new AppError('NOT_FOUND', 'Batch not found');
    await this.progress(jobId, { status: 'running', progress: 1, error: null });
    const todo = await this.db.select().from(betaOps).where(and(eq(betaOps.batchId, batchId), sql`${betaOps.state} <> 'ready'`)).orderBy(betaOps.login);
    let done = 0;
    const queue = [...todo];
    // bounded concurrency: argon2 is memory-hungry and the database should stay free for real traffic
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let op = queue.shift(); op; op = queue.shift()) {
        await this.provision(op, batch, jobId);
        if (++done % 5 === 0 || done === todo.length) await this.progress(jobId, { progress: Math.min(99, Math.round((done / Math.max(1, todo.length)) * 100)) });
      }
    }));
    const [c] = (await this.db.execute<{ ready: number; failed: number }>(sql`select count(*) filter (where state = 'ready')::int as ready, count(*) filter (where state <> 'ready' and error is not null)::int as failed from beta_ops where batch_id = ${batchId}`)).rows;
    const status = c!.failed === 0 ? 'ready' : c!.ready === 0 ? 'failed' : 'partial';
    await this.db.update(betaBatches).set({ status }).where(eq(betaBatches.id, batchId));
    await this.progress(jobId, { status: c!.failed ? 'failed' : 'done', progress: 100, error: c!.failed ? `${c!.failed} of ${batch.total} accounts need a retry` : null, result: { total: batch.total, ready: c!.ready, failed: c!.failed } });
    await this.changed(batchId, 'beta.batch.generated');
  }

  async retryBatch(actor: Actor, batchId: string) {
    const [b] = await this.db.select().from(betaBatches).where(eq(betaBatches.id, batchId));
    if (!b) throw new AppError('NOT_FOUND', 'Group not found');
    if (!b.jobId) throw new AppError('INVALID_STATE', 'Nothing to retry');
    await this.db.update(jobs).set({ status: 'queued', error: null, updatedAt: new Date() }).where(eq(jobs.id, b.jobId));
    await this.writer.run(actor, { action: 'beta.batch.retry', type: 'betaBatch', id: batchId }, async () => ({ result: null, after: { jobId: b.jobId } }));
    await this.queues.add(QUEUES.cron, 'beta.generate', { jobId: b.jobId, batchId }, { jobId: `beta-gen-${batchId}-${Date.now()}`, attempts: 2 });
    return { jobId: b.jobId };
  }

  /** One account, in order: create → grant → seed → ready. A step that already happened is skipped, never repeated. */
  private async provision(op: typeof betaOps.$inferSelect, batch: typeof betaBatches.$inferSelect, jobId: string) {
    const sys = SYSTEM_ACTOR(jobId);
    try {
      let userId = op.userId;
      let state = op.state;
      if (!userId) { userId = await this.createAccount(op, batch); state = 'created'; }
      if (state === 'created' || state === 'pending') {
        if (op.intendedPremium && op.grantExpiresAt) await this.grant(sys, userId, op.grantExpiresAt, 'beta.grant.initial');
        await this.db.update(betaOps).set({ state: 'granted', error: null }).where(eq(betaOps.opRef, op.opRef));
        state = 'granted';
      }
      if (state === 'granted') {
        await this.seed(userId, batch.seedPreset as SeedPreset, op);
        await this.db.update(betaOps).set({ state: 'ready', error: null }).where(eq(betaOps.opRef, op.opRef));
      }
    } catch (e) {
      this.log.warn(`provision ${op.login}: ${brief(e)}`);
      await this.db.update(betaOps).set({ error: brief(e) }).where(eq(betaOps.opRef, op.opRef));
    }
  }

  private async createAccount(op: typeof betaOps.$inferSelect, batch: typeof betaBatches.$inferSelect) {
    const id = uuid();
    const passwordHash = await argon2.hash(initialPassword(op.login), { type: argon2.argon2id });
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(users).values({
          id, email: op.email, username: op.login, emailVerifiedAt: new Date(), isGuest: false, isTestAccount: true, betaBatchId: batch.id, createdByAdminId: batch.createdBy, seedPreset: batch.seedPreset,
        });
        await tx.insert(userStats).values({ userId: id });
        await tx.insert(authIdentities).values({ id: uuid(), userId: id, provider: 'email', providerUid: op.email, passwordHash });
        await tx.update(betaOps).set({ userId: id, state: 'created', error: null }).where(eq(betaOps.opRef, op.opRef));
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505' || /unique/i.test((e as Error).message)) throw new AppError('ALREADY_EXISTS', 'This login or email is already in use');
      throw e;
    }
    return id;
  }

  // ───────────── sample data ─────────────

  private async seed(userId: string, preset: SeedPreset, op: Pick<typeof betaOps.$inferSelect, 'displayName'>) {
    if (preset === 'blank') return;
    const done = new Set((await this.db.select({ k: seedFixtures.kind }).from(seedFixtures).where(eq(seedFixtures.userId, userId))).map((r) => r.k));
    const fix = (tx: Tx, kind: string, refId: string) => tx.insert(seedFixtures).values({ id: uuid(), userId, kind, refId });
    await this.db.transaction(async (tx) => {
      if (!done.has('name') && op.displayName) {
        await tx.update(users).set({ firstName: op.displayName.slice(0, 30), bio: BIO }).where(and(eq(users.id, userId), isNull(users.firstName)));
        await fix(tx, 'name', op.displayName.slice(0, 30));
        await fix(tx, 'bio', BIO);
      }
      if (preset !== 'light') return;
      if (!done.has('saved')) {
        const msgs = (await tx.execute<{ d: string }>(sql`select date::text as d from daily_messages where date <= current_date order by date desc limit 3`)).rows;
        for (const m of msgs) { await tx.insert(savedMessages).values({ userId, date: m.d }).onConflictDoNothing(); await fix(tx, 'saved', m.d); }
        if (!msgs.length) await fix(tx, 'saved', 'none');
      }
      if (!done.has('sit')) {
        const sess = (await tx.execute<{ id: string }>(sql`select id from sessions where status = 'live' and access = 'free' order by created_at limit 2`)).rows;
        let k = 1;
        for (const s of sess) {
          const id = uuid(), start = ago(k * 2);
          // not counted: sample sits must never reach streaks, public counters or the reports
          await tx.execute(sql`insert into meditations (id, user_id, session_id, kind, started_at, ended_at, duration_sec, counted, completed, local_date) values (${id}, ${userId}, ${s.id}, 'solo', ${start}, ${new Date(start.getTime() + 600_000)}, 600, false, true, ${day(start)})`);
          await fix(tx, 'sit', id);
          k++;
        }
        if (!sess.length) await fix(tx, 'sit', 'none');
      }
    });
  }

  /** What "Reset sample data" would remove for one account. */
  async samplePreview(userId: string) {
    await this.scoped(this.db, userId);
    const rows = await this.db.select({ kind: seedFixtures.kind, n: sql<number>`count(*)::int` }).from(seedFixtures).where(and(eq(seedFixtures.userId, userId), sql`${seedFixtures.refId} <> 'none'`)).groupBy(seedFixtures.kind);
    return { items: rows.map((r) => ({ kind: r.kind, count: r.n })), total: rows.reduce((a, r) => a + r.n, 0) };
  }

  /** Removes only rows the preset created; the tester's own sits, saves and edits stay. */
  async resetSample(actor: Actor, userId: string) {
    await this.scoped(this.db, userId);
    return this.writer.run(actor, { action: 'beta.sample.reset', type: 'user', id: userId }, async (tx) => {
      const fx = await tx.select().from(seedFixtures).where(eq(seedFixtures.userId, userId));
      for (const f of fx) {
        if (f.kind === 'sit' && f.refId !== 'none') await tx.execute(sql`delete from meditations where id = ${f.refId}::uuid and user_id = ${userId}`);
        if (f.kind === 'saved' && f.refId !== 'none') await tx.delete(savedMessages).where(and(eq(savedMessages.userId, userId), sql`${savedMessages.date} = ${f.refId}`));
        if (f.kind === 'name') await tx.update(users).set({ firstName: null }).where(and(eq(users.id, userId), eq(users.firstName, f.refId)));
        if (f.kind === 'bio') await tx.update(users).set({ bio: null }).where(and(eq(users.id, userId), eq(users.bio, f.refId)));
      }
      await tx.delete(seedFixtures).where(eq(seedFixtures.userId, userId));
      return { result: { removed: fx.filter((f) => f.refId !== 'none').length }, after: { removed: fx.length }, events: [{ topic: 'account:changed', payload: { userId, reason: 'sample_reset' } }] };
    });
  }

  /** Separate, explicitly confirmed action: wipes the tester's own genuine progress. */
  async resetProgress(actor: Actor, userId: string) {
    await this.scoped(this.db, userId);
    return this.writer.run(actor, { action: 'beta.progress.reset', type: 'user', id: userId }, async (tx) => {
      await tx.execute(sql`delete from meditations where user_id = ${userId}`);
      await tx.execute(sql`delete from user_daily_stats where user_id = ${userId}`);
      await tx.execute(sql`delete from saved_messages where user_id = ${userId}`);
      await tx.execute(sql`delete from program_progress where user_id = ${userId}`);
      await tx.execute(sql`delete from recipes where user_id = ${userId}`);
      await tx.execute(sql`update user_stats set minutes_total = 0, meditations_total = 0, group_total = 0, dedications_total = 0, first_meditation_at = null, last_meditation_at = null where user_id = ${userId}`);
      await tx.delete(seedFixtures).where(eq(seedFixtures.userId, userId));
      return { result: { reset: true }, after: { reset: true }, events: [{ topic: 'account:changed', payload: { userId, reason: 'progress_reset' } }] };
    });
  }

  // ───────────── premium ─────────────

  /** Grant or move the beta end date. The expiry is always explicit, so repeating the call changes nothing. */
  async grant(actor: Actor, userId: string, expiresAt: Date, action = 'beta.grant') {
    if (expiresAt.getTime() <= Date.now()) throw new AppError('VALIDATION_FAILED', 'The end date must be in the future');
    return this.writer.run(actor, { action, type: 'user', id: userId, invalidate: [K.entitlement(userId)] }, async (tx) => {
      await this.lock(tx, `user:${userId}`);
      const u = await this.scoped(tx, userId);
      if (u.del) throw new AppError('INVALID_STATE', 'This account is being deleted');
      const [prev] = await tx.select().from(betaGrants).where(eq(betaGrants.userId, userId));
      await tx.insert(betaGrants).values({ userId, expiresAt, grantedBy: actor.id })
        .onConflictDoUpdate({ target: betaGrants.userId, set: { expiresAt, revokedAt: null, expiryNotifiedAt: null, grantedBy: actor.id, updatedAt: new Date() } });
      const ev = await this.ent.nextEvent(tx, userId);
      return { result: ev.payload.entitlement, before: { betaExpiresAt: prev && !prev.revokedAt ? prev.expiresAt : null }, after: { betaExpiresAt: expiresAt }, events: [ev] };
    });
  }

  async extend(actor: Actor, userId: string, days: number) {
    const [g] = await this.db.select().from(betaGrants).where(eq(betaGrants.userId, userId));
    const base = g && !g.revokedAt && g.expiresAt.getTime() > Date.now() ? g.expiresAt.getTime() : Date.now();
    return this.grant(actor, userId, new Date(base + days * 86_400_000), 'beta.extend');
  }

  /** Ends the beta grant only. Paid and support-gift access are not stored here and are never touched. */
  async remove(actor: Actor, userId: string) {
    return this.writer.run(actor, { action: 'beta.remove', type: 'user', id: userId, invalidate: [K.entitlement(userId)] }, async (tx) => {
      await this.lock(tx, `user:${userId}`);
      await this.scoped(tx, userId);
      const [prev] = await tx.select().from(betaGrants).where(eq(betaGrants.userId, userId));
      if (!prev || prev.revokedAt) return { result: await this.ent.view(userId, tx), after: { unchanged: true } };
      await tx.update(betaGrants).set({ revokedAt: new Date(), updatedAt: new Date() }).where(eq(betaGrants.userId, userId));
      const ev = await this.ent.nextEvent(tx, userId);
      return { result: ev.payload.entitlement, before: { betaExpiresAt: prev.expiresAt }, after: { betaExpiresAt: null }, events: [ev] };
    });
  }

  /** Minute job: a grant that ran out tells the connected app (the server already refuses it; the cache is capped at the expiry). */
  async expireDue(limit = 200) {
    const due = await this.db.select({ userId: betaGrants.userId }).from(betaGrants).where(and(isNull(betaGrants.revokedAt), isNull(betaGrants.expiryNotifiedAt), sql`${betaGrants.expiresAt} <= now()`)).limit(limit);
    for (const d of due) {
      await this.writer.run(SYSTEM_ACTOR('beta.expire'), { action: 'beta.expired', type: 'user', id: d.userId, invalidate: [K.entitlement(d.userId)] }, async (tx) => {
        await tx.update(betaGrants).set({ expiryNotifiedAt: new Date() }).where(eq(betaGrants.userId, d.userId));
        const ev = await this.ent.nextEvent(tx, d.userId);
        return { result: null, after: { expired: true }, events: [ev] };
      }).catch((e) => this.log.warn(`expire ${d.userId}: ${brief(e)}`));
    }
    return due.length;
  }

  // ───────────── suspension, password, deletion ─────────────

  /** Suspend: sessions and tokens end everywhere, sockets are told and dropped, login is refused until resume. */
  async suspend(actor: Actor, userId: string, reason: string) {
    return this.writer.run(actor, { action: 'beta.suspend', type: 'user', id: userId, invalidate: [K.tokenVersion(userId), K.entitlement(userId)] }, async (tx) => {
      await this.lock(tx, `user:${userId}`);
      const u = await this.scoped(tx, userId);
      if (u.del) throw new AppError('INVALID_STATE', 'This account is being deleted');
      if (u.sus) return { result: { changed: false }, after: { unchanged: true } };
      await tx.update(users).set({ suspendedAt: new Date(), suspendedReason: reason.slice(0, 200), tokenVersion: sql`${users.tokenVersion} + 1` }).where(eq(users.id, userId));
      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
      return { result: { changed: true }, after: { state: 'suspended', reason: reason.slice(0, 200) }, events: [{ topic: 'force:logout', payload: { scope: 'user', id: userId, reason: 'account_suspended' } }] };
    });
  }

  /** Resume only lifts the block. Old tokens stay dead, the expiry is not extended, the person signs in again. */
  async resume(actor: Actor, userId: string) {
    return this.writer.run(actor, { action: 'beta.resume', type: 'user', id: userId, invalidate: [K.tokenVersion(userId), K.entitlement(userId)] }, async (tx) => {
      await this.lock(tx, `user:${userId}`);
      const u = await this.scoped(tx, userId);
      if (u.del) throw new AppError('INVALID_STATE', 'This account is being deleted');
      if (!u.sus) return { result: { changed: false }, after: { unchanged: true } };
      await tx.update(users).set({ suspendedAt: null, suspendedReason: null, tokenVersion: sql`${users.tokenVersion} + 1` }).where(eq(users.id, userId));
      return { result: { changed: true }, after: { state: 'active' } };
    });
  }

  /** The new password is returned once to the admin and never stored or logged in clear. */
  async resetPassword(actor: Actor, userId: string) {
    const password = randomBytes(12).toString('base64url').replace(/[-_]/g, 'x').slice(0, 14);
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const login = await this.writer.run(actor, { action: 'beta.password.reset', type: 'user', id: userId, invalidate: [K.tokenVersion(userId)] }, async (tx) => {
      await this.lock(tx, `user:${userId}`);
      const u = await this.scoped(tx, userId);
      if (u.del) throw new AppError('INVALID_STATE', 'This account is being deleted');
      const upd = await tx.update(authIdentities).set({ passwordHash: hash }).where(and(eq(authIdentities.userId, userId), eq(authIdentities.provider, 'email'))).returning({ id: authIdentities.id });
      if (!upd.length) throw new AppError('INVALID_STATE', 'This account has no password sign-in');
      await tx.update(betaOps).set({ initialPasswordActive: false }).where(eq(betaOps.userId, userId));
      await tx.update(users).set({ tokenVersion: sql`${users.tokenVersion} + 1` }).where(eq(users.id, userId));
      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
      return { result: u.login, after: { sessionsEnded: true }, events: [{ topic: 'force:logout', payload: { scope: 'user', id: userId, reason: 'password_reset' } }] };
    });
    return { login, password };
  }

  /** The initial login/password pairs of one group, only while the export window is open and only for passwords still unchanged. */
  async credentialsCsv(actor: Actor, batchId: string) {
    const [b] = await this.db.select().from(betaBatches).where(eq(betaBatches.id, batchId));
    if (!b) throw new AppError('NOT_FOUND', 'Group not found');
    if (Date.now() - b.createdAt.getTime() > env.BETA_CREDENTIALS_EXPORT_DAYS * 86_400_000) throw new AppError('GONE', 'The export window for this group has closed. Reset a password instead.');
    const ops = await this.db.select({ login: betaOps.login, email: betaOps.email }).from(betaOps).where(and(eq(betaOps.batchId, batchId), eq(betaOps.initialPasswordActive, true), sql`${betaOps.userId} is not null`)).orderBy(betaOps.login);
    await this.writer.run(actor, { action: 'beta.credentials.export', type: 'betaBatch', id: batchId }, async () => ({ result: null, after: { accounts: ops.length } }));
    return toCsv(ops.map((o) => ({ login: o.login, email: o.email, password: initialPassword(o.login) })));
  }

  /** Block first (fast, one account): from this moment nothing can sign in or use a token. */
  private async blockForDeletion(userId: string, batchId: string | null, jobId: string) {
    await this.db.transaction(async (tx) => {
      await this.lock(tx, `user:${userId}`);
      await tx.update(users).set({ deletingAt: sql`coalesce(${users.deletingAt}, now())`, tokenVersion: sql`${users.tokenVersion} + 1` }).where(eq(users.id, userId));
      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
      await tx.insert(betaDeletions).values({ userId, batchId, jobId, step: 'blocked' }).onConflictDoUpdate({ target: betaDeletions.userId, set: { jobId, updatedAt: new Date() } });
      await tx.insert(outboxEvents).values({ topic: 'force:logout', payload: { scope: 'user', id: userId, reason: 'account_deleted' } });
    });
    await this.redis.del(K.tokenVersion(userId), K.entitlement(userId)).catch(() => 0);
  }

  /** Slow part, safe to repeat: every step it runs is idempotent and the account stays blocked until it ends. */
  private async cleanup(userId: string, actor: Actor) {
    await this.db.update(betaDeletions).set({ step: 'cleaning', attempts: sql`${betaDeletions.attempts} + 1`, updatedAt: new Date() }).where(eq(betaDeletions.userId, userId));
    try {
      await this.data.deleteUser(uuid(), userId, actor.id, { rc: 'if_entitled' });
    } catch (e) {
      const [gone] = await this.db.select({ id: deletedIdentities.userId }).from(deletedIdentities).where(eq(deletedIdentities.userId, userId));
      if (!gone) {
        await this.db.update(betaDeletions).set({ step: 'failed', error: brief(e), updatedAt: new Date() }).where(eq(betaDeletions.userId, userId));
        throw e;
      }
    }
    await this.db.update(betaOps).set({ state: 'deleted', userId: null }).where(eq(betaOps.userId, userId));
    await this.db.update(betaDeletions).set({ step: 'done', error: null, updatedAt: new Date() }).where(eq(betaDeletions.userId, userId));
  }

  /** The exact scope shown before anything is deleted: who goes, who is protected and why, and the phrase to type. */
  async reviewDelete(ids: string[]) {
    const rows = (await this.db.execute<Record<string, any>>(sql`select u.id, u.username, u.beta_batch_id, b.name as batch_name, u.is_test_account,
        coalesce(e.product_id is not null and e.store is not null and e.store <> 'promotional' and (e.active or e.will_renew), false) as paid
      from users u left join entitlements e on e.user_id = u.id left join beta_batches b on b.id = u.beta_batch_id where u.id = ANY(${`{${ids.join(',')}}`}::uuid[]) and u.deleted_at is null`)).rows; // eslint-disable-line @typescript-eslint/no-explicit-any
    const blocked = rows.filter((r) => !r.is_test_account || r.paid).map((r) => ({ id: r.id as string, login: (r.is_test_account ? r.username : null) as string | null, reason: !r.is_test_account ? 'Not a beta test account' : 'Has a paid store subscription: review billing first (deleting the account does not cancel it)' }));
    const bad = new Set(blocked.map((b) => b.id));
    const go = rows.filter((r) => !bad.has(r.id));
    const batchNames = [...new Set(go.map((r) => r.batch_name as string).filter(Boolean))];
    const phrase = go.length === 1 ? `DELETE ${go[0]!.username}` : batchNames.length === 1 && go.every((r) => r.batch_name) ? `DELETE ${batchNames[0]}` : `DELETE ${go.length} accounts`;
    const groups = batchNames.map((n) => ({ name: n, count: go.filter((r) => r.batch_name === n).length }));
    return { count: go.length, groups, blocked, phrase, ids: go.map((r) => r.id as string) };
  }

  // ───────────── bulk operations ─────────────

  /** Creates the job from a fixed list of ids; the list never changes afterwards, so new accounts cannot join a running operation. */
  async startBulk(actor: Actor, action: BulkAction, ids: string[], params: BulkParams, expectedCount?: number) {
    if (!ids.length) throw new AppError('VALIDATION_FAILED', 'Nothing is selected');
    if (expectedCount !== undefined && expectedCount !== ids.length) throw new AppError('INVALID_STATE', `The selection changed: it is now ${ids.length} accounts, not ${expectedCount}. Review it again.`, { count: ids.length });
    const p: Record<string, unknown> = {};
    let list = ids;
    let skipped: { id: string; login: string | null; reason: string }[] = [];
    if (action === 'grant') {
      const at = params.expiresAt ? new Date(params.expiresAt) : params.days ? new Date(Date.now() + params.days * 86_400_000) : null;
      if (!at || at.getTime() <= Date.now() + 60_000) throw new AppError('VALIDATION_FAILED', 'Choose a number of days or a future end date');
      p.expiresAt = at.toISOString();
    }
    if (action === 'extend') { if (!params.days) throw new AppError('VALIDATION_FAILED', 'Choose how many days to add'); p.days = params.days; }
    if (action === 'suspend') p.reason = (params.reason ?? 'Suspended by an admin').slice(0, 200);
    if (action === 'delete') {
      const rv = await this.reviewDelete(ids);
      if (params.confirm?.trim() !== rv.phrase) throw new AppError('VALIDATION_FAILED', 'The confirmation does not match', { expected: rv.phrase, fields: [{ path: 'confirm', message: `Type ${rv.phrase} to confirm` }] });
      list = rv.ids; skipped = rv.blocked;
      if (!list.length) throw new AppError('VALIDATION_FAILED', 'None of the selected accounts can be deleted here', { blocked: rv.blocked });
    }
    const jobId = uuid();
    const batchIds = (await this.db.select({ b: users.betaBatchId }).from(users).where(inArray(users.id, list))).map((r) => r.b);
    const batchId = new Set(batchIds).size === 1 ? batchIds[0] ?? null : null;
    await this.writer.run(actor, { action: `beta.bulk.${action}`, type: 'betaBatch', id: batchId ?? jobId }, async (tx) => {
      await tx.insert(jobs).values({ id: jobId, type: 'beta_bulk', status: 'queued', payload: { action, params: p, ids: list, batchId, actorId: actor.id, actorRole: actor.role }, result: { items: {}, skipped }, createdBy: actor.id });
      return { result: null, after: { jobId, action, count: list.length, skipped: skipped.length, batchId } };
    });
    // deletion blocks access before the job even starts
    if (action === 'delete') for (const id of list) await this.blockForDeletion(id, batchId, jobId);
    await this.queues.add(QUEUES.cron, 'beta.bulk', { jobId }, { jobId: `beta-bulk-${jobId}`, attempts: 1 });
    return { jobId, count: list.length, skipped };
  }

  async runBulk(jobId: string) {
    const [job] = await this.db.select().from(jobs).where(eq(jobs.id, jobId));
    if (!job) throw new AppError('NOT_FOUND', 'Job not found');
    const pl = job.payload as { action: BulkAction; params: Record<string, any>; ids: string[]; batchId: string | null; actorId: string | null; actorRole: Actor['role'] }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const actor: Actor = { id: pl.actorId, role: pl.actorRole, ip: null, requestId: jobId };
    const prev = (job.result as { items: Record<string, { status: string; error?: string }>; skipped: unknown[] } | null) ?? { items: {}, skipped: [] };
    const items = { ...prev.items };
    const todo = pl.ids.filter((id) => items[id]?.status !== 'done');
    await this.progress(jobId, { status: 'running', error: null });
    let n = pl.ids.length - todo.length;
    const queue = [...todo];
    await Promise.all(Array.from({ length: Math.min(pl.action === 'delete' ? 3 : 4, queue.length) }, async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        try { await this.applyOne(actor, pl.action, id, pl.params); items[id] = { status: 'done' }; }
        catch (e) { items[id] = { status: 'failed', error: brief(e) }; }
        n++;
        if (n % 5 === 0) await this.progress(jobId, { progress: Math.min(99, Math.round((n / pl.ids.length) * 100)), result: { items, skipped: prev.skipped } });
      }
    }));
    const failed = Object.values(items).filter((i) => i.status === 'failed').length;
    await this.progress(jobId, { status: failed ? 'failed' : 'done', progress: 100, error: failed ? `${failed} of ${pl.ids.length} accounts failed` : null, result: { items, skipped: prev.skipped, ok: pl.ids.length - failed, failed } });
    await this.changed(pl.batchId, `beta.bulk.${pl.action}.done`);
  }

  private async applyOne(actor: Actor, action: BulkAction, id: string, p: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
    switch (action) {
      case 'grant': return void (await this.grant(actor, id, new Date(p.expiresAt)));
      case 'extend': return void (await this.extend(actor, id, p.days));
      case 'remove': return void (await this.remove(actor, id));
      case 'suspend': return void (await this.suspend(actor, id, p.reason));
      case 'resume': return void (await this.resume(actor, id));
      case 'reset_sample': return void (await this.resetSample(actor, id));
      case 'delete': return this.cleanup(id, actor);
    }
  }

  /** Re-runs only the accounts that failed; accounts that finished are never touched again. */
  async retryJob(actor: Actor, jobId: string) {
    const [job] = await this.db.select().from(jobs).where(eq(jobs.id, jobId));
    if (!job || (job.type !== 'beta_bulk' && job.type !== 'beta_generate')) throw new AppError('NOT_FOUND', 'Job not found');
    if (job.status !== 'failed') throw new AppError('INVALID_STATE', 'Only a failed job can be retried');
    await this.writer.run(actor, { action: 'beta.job.retry', type: 'betaBatch', id: String((job.payload as { batchId?: string }).batchId ?? jobId) }, async () => ({ result: null, after: { jobId } }));
    await this.db.update(jobs).set({ status: 'queued', error: null, updatedAt: new Date() }).where(eq(jobs.id, jobId));
    const name = job.type === 'beta_bulk' ? 'beta.bulk' : 'beta.generate';
    await this.queues.add(QUEUES.cron, name, { jobId, batchId: (job.payload as { batchId?: string }).batchId }, { jobId: `${name}-${jobId}-${Date.now()}`, attempts: 1 });
    return { jobId };
  }

  async job(jobId: string) {
    const [j] = await this.db.select().from(jobs).where(and(eq(jobs.id, jobId), inArray(jobs.type, ['beta_bulk', 'beta_generate'])));
    if (!j) throw new AppError('NOT_FOUND', 'Job not found');
    const r = (j.result ?? {}) as { items?: Record<string, { status: string; error?: string }>; skipped?: unknown[]; ok?: number; failed?: number; total?: number; ready?: number };
    const logins = r.items ? new Map((await this.db.select({ id: users.id, l: users.username }).from(users).where(inArray(users.id, Object.keys(r.items).slice(0, 2000)))).map((u) => [u.id, u.l])) : new Map();
    return {
      id: j.id, type: j.type, status: j.status, progress: j.progress, error: j.error, action: (j.payload as { action?: string }).action ?? 'generate', total: ((j.payload as { ids?: string[] }).ids ?? []).length || r.total || 0,
      ok: r.ok ?? r.ready ?? 0, failed: r.failed ?? 0, skipped: r.skipped ?? [],
      failures: Object.entries(r.items ?? {}).filter(([, v]) => v.status === 'failed').map(([id, v]) => ({ id, login: logins.get(id) ?? null, error: v.error ?? 'Failed' })),
    };
  }
}
