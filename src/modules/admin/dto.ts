import { z } from 'zod';

export const uuid = z.string().uuid();
export const IdParam = z.string().uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((d) => { const t = Date.parse(d); return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d); }, 'Invalid date');
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm');
export const url = z.string().url().max(500).refine((u) => /^https?:\/\//.test(u), 'http(s) only');
export const ids = z.array(uuid).min(1).max(200).refine((a) => new Set(a).size === a.length, 'Duplicate ids');
export const slugify = (t: string) => t.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 100) || 'item';
export const cursorQuery = { cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) };
export const LENGTHS = [10, 30, 45] as const;
