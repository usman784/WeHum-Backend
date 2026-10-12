import { Inject, Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { AppError } from '../../common/errors';
import { users } from '../../db/schema';
import { DRIZZLE, type DB } from '../../infra/core.module';

export const USERNAME_COOLDOWN_DAYS = 7;
const RESERVED = new Set(['admin', 'administrator', 'wehum', 'support', 'help', 'raphael', 'root', 'system', 'moderator', 'staff', 'team', 'official', 'null', 'undefined', 'me', 'you', 'sos']);
const WORDS = ['calm', 'still', 'breathe', 'zen', 'quiet', 'sitter', 'present', 'flow', 'ember', 'dawn'];

/** 3–20 characters: a-z, 0-9, dot and underscore; starts and ends with a letter or digit; no doubled separators. */
export function validateUsername(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const v = raw.trim().toLowerCase();
  if (v.length < 3 || v.length > 20) return { ok: false, reason: 'Use 3 to 20 characters' };
  if (!/^[a-z0-9._]+$/.test(v)) return { ok: false, reason: 'Only letters, numbers, dots and underscores' };
  if (!/^[a-z0-9].*[a-z0-9]$/.test(v)) return { ok: false, reason: 'Start and end with a letter or number' };
  if (/[._]{2}/.test(v)) return { ok: false, reason: 'No two dots or underscores in a row' };
  if (RESERVED.has(v)) return { ok: false, reason: 'This name is reserved' };
  return { ok: true, value: v };
}

/** A clean base from a name or e-mail ("Jane.Doe+news@x.com" → "jane.doe"). */
export function baseFrom(text: string | null | undefined): string {
  const t = (text ?? '').split('@')[0]!.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const clean = t.replace(/\+.*$/, '').replace(/[^a-z0-9._]+/g, '').replace(/[._]{2,}/g, '.').replace(/^[._]+|[._]+$/g, '');
  return clean.length >= 3 ? clean.slice(0, 16) : (clean + 'sitter').slice(0, 16);
}

@Injectable()
export class UsernameService {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  private async taken(names: string[]): Promise<Set<string>> {
    if (!names.length) return new Set();
    const rows = await this.db.select({ u: users.username }).from(users).where(inArray(users.username, names));
    return new Set(rows.map((r) => String(r.u).toLowerCase()));
  }

  async isAvailable(name: string, exceptUserId?: string): Promise<boolean> {
    const rows = await this.db.select({ id: users.id }).from(users).where(inArray(users.username, [name]));
    return rows.every((r) => r.id === exceptUserId);
  }

  /** Candidate names around a base: the base itself, a short number, a calm word, a year. */
  async suggest(seed: string | null | undefined, count = 5): Promise<string[]> {
    const base = baseFrom(seed);
    const rnd = (n: number) => Math.floor(Math.random() * 10 ** n).toString().padStart(n, '0');
    const pool = new Set<string>([base]);
    for (let i = 0; pool.size < count * 3 && i < 60; i++) {
      const w = WORDS[Math.floor(Math.random() * WORDS.length)]!;
      const pick = [`${base}${rnd(2)}`, `${base}_${w}`, `${w}.${base}`.slice(0, 20), `${base}${rnd(3)}`, `${base}.${rnd(2)}`][i % 5]!;
      if (validateUsername(pick).ok) pool.add(pick.slice(0, 20));
    }
    const list = [...pool].filter((n) => validateUsername(n).ok);
    const used = await this.taken(list);
    return list.filter((n) => !used.has(n)).slice(0, count);
  }

  /** First free name for a new account (social sign-in, guests turned into accounts). */
  async generate(seed: string | null | undefined): Promise<string> {
    const [first] = await this.suggest(seed, 1);
    if (first) return first;
    return `sitter${Math.floor(Math.random() * 1e8)}`.slice(0, 20);
  }

  /** Throws a readable error if the new name is not allowed for this person right now. */
  async assertChange(userId: string, current: { username: string | null; usernameChangedAt: Date | null }, next: string, now = new Date()): Promise<string> {
    const v = validateUsername(next);
    if (!v.ok) throw new AppError('VALIDATION_FAILED', v.reason);
    if (current.username?.toLowerCase() === v.value) return v.value;
    if (current.username && current.usernameChangedAt) {
      const nextAt = new Date(current.usernameChangedAt.getTime() + USERNAME_COOLDOWN_DAYS * 86_400_000);
      if (nextAt > now) throw new AppError('RATE_LIMITED', `You can change your username again on ${nextAt.toISOString().slice(0, 10)}`, { nextChangeAt: nextAt.toISOString() });
    }
    if (!(await this.isAvailable(v.value, userId))) throw new AppError('ALREADY_EXISTS', 'That username is taken', { suggestions: await this.suggest(v.value, 3) });
    return v.value;
  }
}
