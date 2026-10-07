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
  /** Firebase Auth: the app signs in with Firebase (Google/Apple) and sends the Firebase id token. */
  FIREBASE_PROJECT_ID: z.string().default('wehum-a7fc5'),
  MAIL_FROM: z.string().default('WeHum <hello@wehum.app>'),
  SMTP_URL: z.string().default(''),
  APP_LINK_BASE: z.string().default('https://wehum.app'),
  FCM_SERVICE_ACCOUNT_JSON: z.string().default(''),
  REVENUECAT_WEBHOOK_SECRET: z.string().default(''),
  REVENUECAT_API_KEY_V2: z.string().default(''),
  REVENUECAT_PROJECT_ID: z.string().default(''),
  /** Offering the app gets once the Founding offer is closed. */
  REVENUECAT_REGULAR_OFFERING: z.string().default('regular'),
  REVENUECAT_BASE_URL: z.string().default('https://api.revenuecat.com'),
  ADMIN_APP_URL: z.string().default('http://localhost:5173'),
  /** Parent domain for the readable CSRF cookie when the CMS and API are on different subdomains, e.g. ".wehum.app". */
  ADMIN_COOKIE_DOMAIN: z.string().default(''),
  S3_ENDPOINT: z.string().default(''),
  /** Endpoint in the URLs given to browsers, when storage is reached differently from outside (a proxy). */
  S3_PUBLIC_ENDPOINT: z.string().default(''),
  S3_REGION: z.string().default('eu-central-1'),
  S3_BUCKET: z.string().default('wehum-media-dev'),
  S3_ACCESS_KEY: z.string().default(''),
  S3_SECRET_KEY: z.string().default(''),
  S3_FORCE_PATH_STYLE: bool.default('true'),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  YOUTUBE_API_KEY: z.string().default(''),
  CDN_BASE_URL: z.string().default('http://localhost:9000/wehum-media-dev'),
  CDN_SIGNING_SECRET: z.string().default('dev-only-cdn-secret'),
  SENTRY_DSN: z.string().default(''),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().default(0.1),
  SEED_OWNER_EMAIL: z.string().default('owner@wehum.app'),
  SEED_OWNER_PASSWORD: z.string().default('ChangeMe-2026!'),
  RATE_LIMIT_DISABLED: bool.default('false'),
  // ── P10 hardening
  /** Bearer token for GET /metrics (Prometheus sends it). In staging/production /metrics is off (404) until it is set. */
  METRICS_TOKEN: z.string().default(''),
  /** Worker and scheduler have no HTTP server: they serve /metrics on this port when set (e.g. 9464). */
  METRICS_PORT: z.coerce.number().default(0),
  /** Guest-create attestation (App Attest / Play Integrity): off, monitor (check and count, never block) or enforce. */
  ATTESTATION_MODE: z.enum(['off', 'monitor', 'enforce']).default('off'),
  /** Apple team id + bundle id = the App Attest app id ("TEAMID.app.wehum.meditation"). */
  APPLE_TEAM_ID: z.string().default(''),
  /** Android package name checked in the Play Integrity verdict. */
  ANDROID_PACKAGE: z.string().default('app.wehum.meditation'),
  /** Google service account (JSON, base64) allowed to call the Play Integrity API. */
  PLAY_INTEGRITY_SA_B64: z.string().default(''),
  /** Apple App Attestation Root CA, PEM in base64 (https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem). */
  APP_ATTEST_ROOT_CA_B64: z.string().default(''),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast with a readable list (spec §12).
  console.error('Invalid environment:\n' + parsed.error.issues.map((i) => ` - ${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}
export const env = parsed.data;
if ((env.NODE_ENV === 'production' || env.NODE_ENV === 'staging') && env.CDN_SIGNING_SECRET === 'dev-only-cdn-secret') {
  console.error('Invalid environment:\n - CDN_SIGNING_SECRET: must be set in staging/production');
  process.exit(1);
}
export type Env = typeof env;
export const isProd = env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
