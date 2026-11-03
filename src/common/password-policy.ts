import { z } from 'zod';

const COMMON = new Set(['password', 'password1', '12345678', '123456789', 'qwertyui', 'iloveyou', '11111111', 'meditation', 'wehum123']);

/** The one password rule for members (sign-up and reset) and for generated test accounts. */
export const passwordPolicy = z.string().min(8, 'At least 8 characters').max(128).refine((p) => !COMMON.has(p.toLowerCase()), 'This password is too common');
