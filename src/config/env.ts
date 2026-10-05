import 'dotenv/config';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  APP_ROLE: z.enum(['api', 'worker', 'scheduler']).default('api'),
  PORT: z.coerce.number().default(3000),
  PUBLIC_API_URL: z.string().default('http://localhost:3000'),
  CMS_ORIGINS: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().default(10),
  REDIS_URL: z.string().min(1),
  JWT_PRIVATE_KEY_B64: z.string().default(''),
  JWT_PUBLIC_KEYS_B64: z.string().default(''),
  JWT_KID: z.string().default('k1'),
  ACCESS_TTL_SEC: z.coerce.number().default(900),
  REFRESH_TTL_DAYS: z.coerce.number().default(60),
  ADMIN_ACCESS_TTL_SEC: z.coerce.number().default(600),
  ADMIN_REFRESH_IDLE_HOURS: z.coerce.number().default(12),
  TOTP_ENC_KEY_BASE64: z.string().default(''),
  MIN_APP_VERSION_IOS: z.string().default('1.0.0'),
  MIN_APP_VERSION_ANDROID: z.string().default('1.0.0'),
  APPLE_BUNDLE_IDS: z.string().default('app.wehum.meditation'),
  GOOGLE_CLIENT_IDS: z.string().default(''),
  MAIL_FROM: z.string().default('WeHum <hello@wehum.app>'),
  SMTP_URL: z.string().default(''),
  APP_LINK_BASE: z.string().default('https://wehum.app'),
  REVENUECAT_WEBHOOK_SECRET: z.string().default(''),
  SENTRY_DSN: z.string().default(''),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().default(0.1),
  SEED_OWNER_EMAIL: z.string().default('owner@wehum.app'),
  SEED_OWNER_PASSWORD: z.string().default('ChangeMe-2026!'),
  RATE_LIMIT_DISABLED: bool.default('false'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast with a readable list (spec §12).
  console.error('Invalid environment:\n' + parsed.error.issues.map((i) => ` - ${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}
export const env = parsed.data;
export type Env = typeof env;
export const isProd = env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
