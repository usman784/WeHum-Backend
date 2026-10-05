import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { v7 as uuid } from 'uuid';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { env } from '../../config/env';
import { recipes, soundBlocks } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';

const id = z.string().uuid();
const Block = z.discriminatedUnion('type', [
  z.object({ type: z.literal('block'), blockId: id, count: z.number().int().min(1).max(21).default(1) }).strict(),
  z.object({ type: z.literal('silence') }).strict(),
]);
export const RecipeDto = z.object({
  name: z.string().trim().min(1).max(60),
  lengthMin: z.number().int().min(5).max(60),
  openingId: id.nullish(), soundId: id.nullish(),
  soundLevel: z.number().int().min(0).max(100).default(50),
  texture: z.enum(['simple', 'rich']).default('simple'),
  bells: z.object({ start: z.boolean().default(true), end: z.boolean().default(true), intervalMin: z.number().int().min(0).max(60).default(0) }).strict().default({}),
  blocks: z.array(Block).max(30).default([]),
}).strict();
export const RecipePatchDto = RecipeDto.partial().strict();
export type RecipeInput = z.infer<typeof RecipeDto>;
const MAX_PER_USER = 100;
const SLUG_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

type Row = typeof recipes.$inferSelect;

@Injectable()
export class RecipesService {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  private view(r: Row) {
    return {
      id: r.id, name: r.name, lengthMin: r.lengthMin, openingId: r.openingId, soundId: r.soundId, soundLevel: r.soundLevel, texture: r.texture, bells: r.bells, blocks: r.blocks,
      shareSlug: r.shareSlug, shareUrl: r.shareSlug ? `${env.APP_LINK_BASE}/r/${r.shareSlug}` : null, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    };
  }

  /** Every referenced sound block must exist, be visible, and be of the right kind (the app disables missing options). */
  private async check(b: Partial<RecipeInput>) {
    const ref = new Map<string, string>(); // id → where it is used
    if (b.openingId) ref.set(b.openingId, 'openingId');
    if (b.soundId) ref.set(b.soundId, 'soundId');
    b.blocks?.forEach((x, i) => { if (x.type === 'block') ref.set(x.blockId, `blocks.${i}.blockId`); });
    if (!ref.size) return;
    const found = await this.db.select({ id: soundBlocks.id, kind: soundBlocks.kind }).from(soundBlocks).where(and(inArray(soundBlocks.id, [...ref.keys()]), eq(soundBlocks.visible, true)));
    const kinds = new Map(found.map((f) => [f.id, f.kind]));
    const fields: { path: string; message: string }[] = [];
    for (const [bid, path] of ref) {
      if (!kinds.has(bid)) fields.push({ path, message: 'This sound is not available' });
      else if (path === 'openingId' && kinds.get(bid) !== 'opening') fields.push({ path, message: 'Not an opening' });
      else if (path === 'soundId' && kinds.get(bid) !== 'sound') fields.push({ path, message: 'Not a background sound' });
    }
    if (fields.length) throw new AppError('VALIDATION_FAILED', 'Some choices are not available', { fields });
  }

  async list(userId: string) {
    return (await this.db.select().from(recipes).where(eq(recipes.userId, userId)).orderBy(desc(recipes.updatedAt), desc(recipes.id)).limit(MAX_PER_USER)).map((r) => this.view(r));
  }

  async create(userId: string, b: RecipeInput) {
    const [{ n }] = await this.db.select({ n: count() }).from(recipes).where(eq(recipes.userId, userId)) as [{ n: number }];
    if (n >= MAX_PER_USER) throw new AppError('INVALID_STATE', `You can save up to ${MAX_PER_USER} meditations`);
    await this.check(b);
    const [r] = await this.db.insert(recipes).values({ id: uuid(), userId, ...b, openingId: b.openingId ?? null, soundId: b.soundId ?? null }).returning();
    return this.view(r!);
  }

  private async mine(userId: string, id: string) {
    const [r] = await this.db.select().from(recipes).where(and(eq(recipes.id, id), eq(recipes.userId, userId)));
    if (!r) throw new AppError('NOT_FOUND', 'Meditation not found');
    return r;
  }

  async update(userId: string, id: string, b: Partial<RecipeInput>) {
    await this.mine(userId, id);
    await this.check(b);
    const [r] = await this.db.update(recipes).set({ ...b, updatedAt: new Date() }).where(and(eq(recipes.id, id), eq(recipes.userId, userId))).returning();
    return this.view(r!);
  }

  async remove(userId: string, id: string) {
    await this.mine(userId, id);
    await this.db.delete(recipes).where(and(eq(recipes.id, id), eq(recipes.userId, userId)));
  }

  /** `wehum.app/r/{slug}`: `name-xxxx`, at most 16 characters. The link holds the recipe only, never the author. */
  async share(userId: string, id: string) {
    const r = await this.mine(userId, id);
    if (r.shareSlug) return { slug: r.shareSlug, url: `${env.APP_LINK_BASE}/r/${r.shareSlug}` };
    const base = r.name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 11).replace(/-+$/, '') || 'recipe';
    for (let i = 0; i < 5; i++) {
      const suffix = Array.from(randomBytes(4), (b) => SLUG_CHARS[b % SLUG_CHARS.length]).join('');
      const slug = `${base}-${suffix}`;
      const [row] = await this.db.update(recipes).set({ shareSlug: slug }).where(and(eq(recipes.id, id), eq(recipes.userId, userId))).returning().catch((e) => { if ((e as { code?: string }).code === '23505') return []; throw e; });
      if (row) return { slug, url: `${env.APP_LINK_BASE}/r/${slug}` };
    }
    throw new AppError('INTERNAL', 'Could not create a link');
  }

  async shared(slug: string) {
    const [r] = await this.db.select().from(recipes).where(eq(recipes.shareSlug, slug));
    if (!r) throw new AppError('NOT_FOUND', 'This link does not exist any more');
    return { slug, name: r.name, lengthMin: r.lengthMin, openingId: r.openingId, soundId: r.soundId, soundLevel: r.soundLevel, texture: r.texture, bells: r.bells, blocks: r.blocks };
  }
}
