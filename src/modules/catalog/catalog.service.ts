import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { AppError } from '../../common/errors';
import { programDays, programProgress, programs, sessions, soundBlocks, teachers, themes } from '../../db/schema';
import { CdnSigner } from '../../infra/cdn';
import { CacheService } from '../../infra/cache';
import { DRIZZLE, type DB } from '../../infra/core.module';
import { K, REDIS } from '../../infra/redis';
import { ConfigService } from '../config/config.service';
import { MotdService } from '../motd/motd.service';
import { coverMap, toCover, toSessionSummary } from './catalog.mapper';

/** A session is visible to the app when it is live and its publish time has passed. */
export const sessionVisible = () => and(eq(sessions.status, 'live'), or(isNull(sessions.publishAt), lte(sessions.publishAt, sql`now()`)));

const escapeLike = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

export interface SearchParams { q?: string; themeId?: string; type?: 'audio' | 'video' | 'youtube'; access?: 'free' | 'premium'; limit: number }

@Injectable()
export class CatalogService {
  /** Latest snapshot kept per process so a cached read costs one Redis GET (the version) and no JSON parse. */
  private mem: { version: number; snapshot: unknown } | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
    private readonly cdn: CdnSigner,
    private readonly motd: MotdService,
  ) {}

  /** Catalog version = app_config('catalog').version, bumped by every content change (P3 admin CRUD). */
  async version(): Promise<number> { return (await this.config.get('catalog')).version; }

  async bump() {
    const cur = await this.config.get<{ version: number }>('catalog');
    await this.config.set('catalog', { version: cur.version + 1, updatedAt: new Date().toISOString() });
    this.mem = null;
    return cur.version + 1;
  }

  async snapshot(version: number) {
    if (this.mem?.version === version) return this.mem.snapshot;
    const snap = await this.cache.getOrSet(K.catalog(version), 3600, () => this.build(version));
    this.mem = { version, snapshot: snap };
    return snap;
  }

  private async build(version: number) {
    const [th, te, se, pr, pd, sb, sos] = await Promise.all([
      this.db.select().from(themes).where(eq(themes.visible, true)).orderBy(asc(themes.order), asc(themes.id)),
      this.db.select().from(teachers).where(eq(teachers.visible, true)).orderBy(asc(teachers.name), asc(teachers.id)),
      this.db.select().from(sessions).where(sessionVisible()).orderBy(desc(sessions.publishAt), asc(sessions.id)),
      this.db.select().from(programs).where(eq(programs.status, 'live')).orderBy(asc(programs.title), asc(programs.id)),
      this.db.select().from(programDays).orderBy(asc(programDays.programId), asc(programDays.day)),
      this.db.select().from(soundBlocks).where(eq(soundBlocks.visible, true)).orderBy(asc(soundBlocks.kind), asc(soundBlocks.order), asc(soundBlocks.id)),
      this.config.value<Record<string, unknown>>('sos'),
    ]);
    const covers = await coverMap(this.db, [...se.map((s) => s.coverMediaId), ...pr.map((p) => p.coverMediaId)]);
    const liveIds = new Set(se.map((s) => s.id));
    const daysBy = new Map<string, { day: number; sessionId: string; title: string | null }[]>();
    for (const d of pd) if (liveIds.has(d.sessionId)) (daysBy.get(d.programId) ?? daysBy.set(d.programId, []).get(d.programId)!).push({ day: d.day, sessionId: d.sessionId, title: d.title });

    const library = se.filter((s) => !s.isSos);
    return {
      version,
      themes: th.map((t) => ({ id: t.id, slug: t.slug, name: t.name, subtitle: t.subtitle, description: t.description, iconKey: t.iconKey, order: t.order })),
      teachers: te.map((t) => this.teacher(t)),
      sessions: library.map((s) => toSessionSummary(s, this.cdn, covers)),
      programs: pr.map((p) => ({
        id: p.id, slug: p.slug, title: p.title, description: p.description, access: p.access, unlockRule: p.unlockRule,
        cover: toCover(this.cdn, covers, p.coverMediaId, p.coverUrl), days: daysBy.get(p.id) ?? [],
      })),
      soundBlocks: sb.map((b) => ({ id: b.id, kind: b.kind, name: b.name, durationSec: b.durationSec, loopable: b.loopable, access: b.access, order: b.order })),
      sos: this.sosPayload(sos, se.filter((s) => s.isSos), covers),
    };
  }

  private teacher(t: typeof teachers.$inferSelect) {
    return {
      id: t.id, name: t.name, role: t.role, specialty: t.specialty, bio: t.bio, quote: t.quote, photoUrl: this.cdn.publicUrl(t.photoUrl),
      youtubeUrl: t.youtubeUrl, instagramUrl: t.instagramUrl, websiteUrl: t.websiteUrl,
    };
  }

  private sosPayload(cfg: Record<string, unknown>, rows: (typeof sessions.$inferSelect)[], covers: Awaited<ReturnType<typeof coverMap>>) {
    return {
      title: cfg.title, subtitle: cfg.subtitle, help: cfg.help,
      tiles: rows.sort((a, b) => (a.sosOrder ?? 0) - (b.sosOrder ?? 0) || a.id.localeCompare(b.id)).map((s) => ({
        sessionId: s.id, feeling: s.sosFeeling ?? s.title, subtitle: s.sosSubtitle, durationSec: s.durationSec, access: s.access, cover: toCover(this.cdn, covers, s.coverMediaId, s.coverUrl),
      })),
    };
  }

  async sos(catalogVersion: number) {
    const snap = (await this.snapshot(catalogVersion)) as { sos: unknown };
    return snap.sos;
  }

  /** Cache key includes the catalog version, so any content change (which bumps it) invalidates detail caches. */
  async sessionDetail(id: string, version: number) {
    const base = await this.cache.getOrSet(`session:v${version}:${id}`, 600, async () => {
      const [s] = await this.db.select().from(sessions).where(and(eq(sessions.id, id), sessionVisible()));
      if (!s) return null;
      const [covers, theme, teacher] = await Promise.all([
        coverMap(this.db, [s.coverMediaId]),
        s.themeId ? this.db.select({ id: themes.id, name: themes.name, slug: themes.slug }).from(themes).where(eq(themes.id, s.themeId)).then((r) => r[0] ?? null) : null,
        s.teacherId ? this.db.select().from(teachers).where(eq(teachers.id, s.teacherId)).then((r) => r[0] ?? null) : null,
      ]);
      return { ...toSessionSummary(s, this.cdn, covers), isSos: s.isSos, theme, teacher: teacher ? this.teacher(teacher) : null };
    });
    if (!base) throw new AppError('NOT_FOUND', 'Meditation not found');
    return { ...base, practicedToday: await this.motd.practicedTodaySession(id), dedications: { preview: [] as unknown[] } };
  }

  async programDetail(id: string, userId: string, version: number) {
    const base = await this.cache.getOrSet(`program:v${version}:${id}`, 600, async () => {
      const [p] = await this.db.select().from(programs).where(and(eq(programs.id, id), eq(programs.status, 'live')));
      if (!p) return null;
      const days = await this.db.select().from(programDays).where(eq(programDays.programId, id)).orderBy(asc(programDays.day));
      const ss = days.length ? await this.db.select().from(sessions).where(and(inArray(sessions.id, days.map((d) => d.sessionId)), sessionVisible())) : [];
      const covers = await coverMap(this.db, [p.coverMediaId, ...ss.map((s) => s.coverMediaId)]);
      const by = new Map(ss.map((s) => [s.id, s]));
      return {
        id: p.id, slug: p.slug, title: p.title, description: p.description, access: p.access, unlockRule: p.unlockRule,
        cover: toCover(this.cdn, covers, p.coverMediaId, p.coverUrl),
        days: days.filter((d) => by.has(d.sessionId)).map((d) => ({ day: d.day, title: d.title, session: toSessionSummary(by.get(d.sessionId)!, this.cdn, covers) })),
      };
    });
    if (!base) throw new AppError('NOT_FOUND', 'Program not found');
    const [pp] = await this.db.select().from(programProgress).where(and(eq(programProgress.userId, userId), eq(programProgress.programId, id)));
    return { ...base, progress: pp ? { startedAt: pp.startedAt.toISOString(), currentDay: pp.currentDay, completedDays: pp.completedDays, completedAt: pp.completedAt?.toISOString() ?? null } : null };
  }

  async teacherDetail(id: string, version: number) {
    const out = await this.cache.getOrSet(`teacher:v${version}:${id}`, 600, async () => {
      const [t] = await this.db.select().from(teachers).where(and(eq(teachers.id, id), eq(teachers.visible, true)));
      if (!t) return null;
      const ss = await this.db.select().from(sessions).where(and(eq(sessions.teacherId, id), eq(sessions.isSos, false), sessionVisible())).orderBy(desc(sessions.publishAt), asc(sessions.id));
      const covers = await coverMap(this.db, ss.map((s) => s.coverMediaId));
      return { ...this.teacher(t), sessions: ss.map((s) => toSessionSummary(s, this.cdn, covers)) };
    });
    if (!out) throw new AppError('NOT_FOUND', 'Teacher not found');
    return out;
  }

  /** Server fallback search (the app searches its local catalog first). Trigram-indexed ILIKE on title/description/tags. */
  async search(p: SearchParams) {
    const conds = [sessionVisible(), eq(sessions.isSos, false)];
    if (p.themeId) conds.push(eq(sessions.themeId, p.themeId));
    if (p.type) conds.push(eq(sessions.type, p.type));
    if (p.access) conds.push(eq(sessions.access, p.access));
    let order = [desc(sessions.publishAt), asc(sessions.id)];
    if (p.q) {
      const like = `%${escapeLike(p.q)}%`;
      conds.push(or(ilike(sessions.title, like), ilike(sessions.description, like), sql`${sessions.tags} @> ARRAY[${p.q.toLowerCase()}]::text[]`)!);
      order = [desc(sql`similarity(${sessions.title}, ${p.q})`), asc(sessions.id)];
    }
    const rows = await this.db.select().from(sessions).where(and(...conds)).orderBy(...order).limit(p.limit);
    const covers = await coverMap(this.db, rows.map((s) => s.coverMediaId));
    return rows.map((s) => toSessionSummary(s, this.cdn, covers));
  }
}
