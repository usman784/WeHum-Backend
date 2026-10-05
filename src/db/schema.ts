/**
 * WeHum — PostgreSQL schema (Drizzle ORM). Authoritative data model (backend spec §4).
 * Conventions: UUID v7 ids generated in the app, snake_case columns, timestamptz UTC,
 * `version` int on CMS-edited rows for optimistic locking.
 * Migrations: `npm run db:generate` (drizzle-kit → ./drizzle/*.sql) then `npm run db:migrate`.
 */
import { sql } from 'drizzle-orm';
import {
  bigint, bigserial, boolean, char, check, customType, date, index, inet, integer, jsonb, numeric,
  pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar,
} from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow().$onUpdate(() => new Date());

// ───────────── Enums ─────────────
export const themePref = pgEnum('theme_pref', ['dark', 'light', 'system']);
export const authProvider = pgEnum('auth_provider', ['device', 'apple', 'google', 'email']);
export const platform = pgEnum('platform', ['ios', 'android']);
export const store = pgEnum('store', ['app_store', 'play_store', 'promotional', 'stripe']);
export const periodType = pgEnum('period_type', ['trial', 'normal', 'intro', 'promotional']);
export const sessionType = pgEnum('session_type', ['audio', 'video', 'youtube']);
export const access = pgEnum('access', ['free', 'premium']);
export const contentStatus = pgEnum('content_status', ['draft', 'scheduled', 'live', 'archived']);
export const meditationKind = pgEnum('meditation_kind', ['motd', 'group', 'solo', 'silence', 'custom', 'program', 'sos', 'free']);
export const messageType = pgEnum('message_type', ['audio', 'video', 'text']);
export const blockKind = pgEnum('block_kind', ['opening', 'core', 'closing', 'sound', 'bell', 'loop']);
export const dedicationStatus = pgEnum('dedication_status', ['visible', 'hidden', 'flagged']);
export const adminRole = pgEnum('admin_role', ['owner', 'admin', 'editor', 'moderator']);
export const adminStatus = pgEnum('admin_status', ['invited', 'active', 'disabled']);
export const jobType = pgEnum('job_type', ['media_probe', 'media_loudness', 'media_transcode', 'image_process', 'youtube_resolve', 'user_export', 'user_delete', 'push_send', 'rc_reconcile']);
export const jobStatus = pgEnum('job_status', ['queued', 'running', 'done', 'failed', 'cancelled']);
export const notificationStatus = pgEnum('notification_status', ['draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed']);
export const audience = pgEnum('audience', ['all', 'members', 'free', 'trial', 'guests', 'country']);
export const sendMode = pgEnum('send_mode', ['now', 'user_reminder_time', 'scheduled']);
export const emailTokenPurpose = pgEnum('email_token_purpose', ['verify', 'magic_link', 'password_reset', 'admin_invite', 'admin_reset']);
export const mediaStatus = pgEnum('media_status', ['uploading', 'processing', 'ready', 'failed']);
export const challengeCounts = pgEnum('challenge_counts', ['any', 'sleep', 'group']);

// ───────────── Users & auth ─────────────
export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  firstName: varchar('first_name', { length: 30 }),
  email: citext('email').unique(),
  emailVerifiedAt: ts('email_verified_at'),
  isGuest: boolean('is_guest').notNull().default(true),
  country: char('country', { length: 2 }),
  timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
  locale: varchar('locale', { length: 10 }).notNull().default('en'),
  theme: themePref('theme').notNull().default('dark'),
  reminderEnabled: boolean('reminder_enabled').notNull().default(true),
  reminderTime: char('reminder_time', { length: 5 }).notNull().default('07:00'),
  groupWarning: boolean('group_warning').notNull().default(false),
  dailyMessagePush: boolean('daily_message_push').notNull().default(true),
  showCountry: boolean('show_country').notNull().default(true),
  mutedAt: ts('muted_at'),
  tokenVersion: integer('token_version').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  lastActiveAt: ts('last_active_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
}, (t) => [
  index('users_guest_created_idx').on(t.isGuest, t.createdAt.desc()),
  index('users_last_active_idx').on(t.lastActiveAt.desc()),
  index('users_reminder_idx').on(t.timezone, t.reminderTime),
  index('users_first_name_trgm').using('gin', sql`${t.firstName} gin_trgm_ops`),
]);

export const authIdentities = pgTable('auth_identities', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: authProvider('provider').notNull(),
  providerUid: varchar('provider_uid', { length: 255 }).notNull(),
  passwordHash: text('password_hash'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('auth_identities_provider_uid').on(t.provider, t.providerUid), index('auth_identities_user_idx').on(t.userId)]);

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  installId: varchar('install_id', { length: 64 }).notNull().unique(),
  platform: platform('platform').notNull(),
  pushToken: varchar('push_token', { length: 512 }).unique(),
  appVersion: varchar('app_version', { length: 20 }).notNull(),
  osVersion: varchar('os_version', { length: 40 }),
  model: varchar('model', { length: 80 }),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  createdAt: createdAt(),
}, (t) => [index('devices_user_idx').on(t.userId)]);

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  familyId: uuid('family_id').notNull(),
  tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
  deviceId: uuid('device_id'),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  revokedAt: ts('revoked_at'),
  createdAt: createdAt(),
}, (t) => [index('refresh_tokens_user_idx').on(t.userId), index('refresh_tokens_family_idx').on(t.familyId), index('refresh_tokens_exp_idx').on(t.expiresAt)]);

export const emailTokens = pgTable('email_tokens', {
  id: uuid('id').primaryKey(),
  purpose: emailTokenPurpose('purpose').notNull(),
  email: citext('email').notNull(),
  userId: uuid('user_id'),
  adminId: uuid('admin_id'),
  tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: createdAt(),
}, (t) => [index('email_tokens_email_purpose_idx').on(t.email, t.purpose)]);

export const entitlements = pgTable('entitlements', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  active: boolean('active').notNull().default(false),
  productId: varchar('product_id', { length: 80 }),
  store: store('store'),
  periodType: periodType('period_type'),
  startedAt: ts('started_at'),
  expiresAt: ts('expires_at'),
  willRenew: boolean('will_renew').notNull().default(false),
  billingIssue: boolean('billing_issue').notNull().default(false),
  isFounding: boolean('is_founding').notNull().default(false),
  lastEventAt: ts('last_event_at'),
  updatedAt: updatedAt(),
}, (t) => [index('entitlements_active_period_idx').on(t.active, t.periodType), index('entitlements_product_idx').on(t.productId)]);

export const userStats = pgTable('user_stats', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  minutesTotal: integer('minutes_total').notNull().default(0),
  meditationsTotal: integer('meditations_total').notNull().default(0),
  groupTotal: integer('group_total').notNull().default(0),
  dedicationsTotal: integer('dedications_total').notNull().default(0),
  firstMeditationAt: ts('first_meditation_at'),
  lastMeditationAt: ts('last_meditation_at'),
  updatedAt: updatedAt(),
});

export const userDailyStats = pgTable('user_daily_stats', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  localDate: date('local_date').notNull(),
  minutes: integer('minutes').notNull().default(0),
  meditations: integer('meditations').notNull().default(0),
  groupCount: integer('group_count').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.userId, t.localDate] })]);

// ───────────── Content ─────────────
export const mediaAssets = pgTable('media_assets', {
  id: uuid('id').primaryKey(),
  kind: varchar('kind', { length: 20 }).notNull(),
  storageKey: text('storage_key').notNull().unique(),
  originalName: text('original_name'),
  mime: varchar('mime', { length: 80 }).notNull(),
  bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
  checksum: char('checksum', { length: 64 }),
  durationSec: integer('duration_sec'),
  loudnessLufs: numeric('loudness_lufs', { precision: 5, scale: 2 }),
  width: integer('width'),
  height: integer('height'),
  blurhash: varchar('blurhash', { length: 64 }),
  hlsKey: text('hls_key'),
  status: mediaStatus('status').notNull().default('uploading'),
  error: text('error'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [index('media_assets_checksum_idx').on(t.checksum)]);

export const themes = pgTable('themes', {
  id: uuid('id').primaryKey(),
  slug: varchar('slug', { length: 60 }).notNull().unique(),
  name: varchar('name', { length: 60 }).notNull(),
  subtitle: varchar('subtitle', { length: 120 }),
  description: text('description'),
  iconKey: varchar('icon_key', { length: 40 }),
  iconMediaId: uuid('icon_media_id'),
  order: integer('order').notNull().default(0),
  visible: boolean('visible').notNull().default(true),
  version: integer('version').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('themes_visible_order_idx').on(t.visible, t.order)]);

export const teachers = pgTable('teachers', {
  id: uuid('id').primaryKey(),
  name: varchar('name', { length: 80 }).notNull(),
  role: varchar('role', { length: 80 }),
  specialty: varchar('specialty', { length: 120 }),
  bio: text('bio'),
  quote: varchar('quote', { length: 280 }),
  photoMediaId: uuid('photo_media_id'),
  photoUrl: text('photo_url'),
  youtubeUrl: text('youtube_url'),
  instagramUrl: text('instagram_url'),
  websiteUrl: text('website_url'),
  visible: boolean('visible').notNull().default(true),
  canLeadGroup: boolean('can_lead_group').notNull().default(false),
  adminId: uuid('admin_id').unique(),
  version: integer('version').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey(),
  slug: varchar('slug', { length: 120 }).notNull().unique(),
  title: varchar('title', { length: 120 }).notNull(),
  description: text('description'),
  type: sessionType('type').notNull(),
  access: access('access').notNull().default('premium'),
  themeId: uuid('theme_id').references(() => themes.id, { onDelete: 'set null' }),
  teacherId: uuid('teacher_id').references(() => teachers.id, { onDelete: 'set null' }),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  durationSec: integer('duration_sec').notNull(),
  mediaId: uuid('media_id'),
  youtubeId: varchar('youtube_id', { length: 20 }),
  coverMediaId: uuid('cover_media_id'),
  coverUrl: text('cover_url'),
  downloadable: boolean('downloadable').notNull().default(true),
  isSos: boolean('is_sos').notNull().default(false),
  sosFeeling: varchar('sos_feeling', { length: 40 }),
  sosSubtitle: varchar('sos_subtitle', { length: 80 }),
  sosOrder: integer('sos_order'),
  status: contentStatus('status').notNull().default('draft'),
  publishAt: ts('publish_at'),
  plays: integer('plays').notNull().default(0),
  completions: integer('completions').notNull().default(0),
  version: integer('version').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  updatedBy: uuid('updated_by'),
}, (t) => [
  index('sessions_status_publish_idx').on(t.status, t.publishAt),
  index('sessions_theme_status_idx').on(t.themeId, t.status),
  index('sessions_access_status_idx').on(t.access, t.status),
  index('sessions_sos_idx').on(t.isSos, t.sosOrder),
  index('sessions_tags_gin').using('gin', t.tags),
  index('sessions_title_trgm').using('gin', sql`${t.title} gin_trgm_ops`),
]);

export const programs = pgTable('programs', {
  id: uuid('id').primaryKey(),
  slug: varchar('slug', { length: 120 }).notNull().unique(),
  title: varchar('title', { length: 120 }).notNull(),
  description: text('description'),
  coverMediaId: uuid('cover_media_id'),
  coverUrl: text('cover_url'),
  access: access('access').notNull().default('premium'),
  unlockRule: varchar('unlock_rule', { length: 30 }).notNull().default('next_day_0700'),
  status: contentStatus('status').notNull().default('draft'),
  version: integer('version').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const programDays = pgTable('program_days', {
  programId: uuid('program_id').notNull().references(() => programs.id, { onDelete: 'cascade' }),
  day: integer('day').notNull(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'restrict' }),
  title: varchar('title', { length: 120 }),
}, (t) => [primaryKey({ columns: [t.programId, t.day] })]);

export const programProgress = pgTable('program_progress', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  programId: uuid('program_id').notNull().references(() => programs.id, { onDelete: 'cascade' }),
  startedAt: ts('started_at').notNull().defaultNow(),
  currentDay: integer('current_day').notNull().default(1),
  completedDays: integer('completed_days').array().notNull().default(sql`'{}'::int[]`),
  completedAt: ts('completed_at'),
}, (t) => [primaryKey({ columns: [t.userId, t.programId] })]);

export const challenges = pgTable('challenges', {
  id: uuid('id').primaryKey(),
  name: varchar('name', { length: 80 }).notNull(),
  days: integer('days').notNull(),
  counts: challengeCounts('counts').notNull().default('any'),
  minMinutes: integer('min_minutes').notNull().default(3),
  membersOnly: boolean('members_only').notNull().default(true),
  showOnYou: boolean('show_on_you').notNull().default(true),
  coverMediaId: uuid('cover_media_id'),
  startsAt: ts('starts_at'),
  status: contentStatus('status').notNull().default('draft'),
  version: integer('version').notNull().default(1),
  createdAt: createdAt(),
});

export const challengeParticipants = pgTable('challenge_participants', {
  challengeId: uuid('challenge_id').notNull().references(() => challenges.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  joinedAt: ts('joined_at').notNull().defaultNow(),
  completedDays: integer('completed_days').notNull().default(0),
  finishedAt: ts('finished_at'),
}, (t) => [primaryKey({ columns: [t.challengeId, t.userId] })]);

export const motdDays = pgTable('motd_days', {
  date: date('date').primaryKey(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'restrict' }),
  groupStartUtc: char('group_start_utc', { length: 5 }),
  groupLengthMin: integer('group_length_min'),
  practicedToday: integer('practiced_today').notNull().default(0),
  groupJoined: integer('group_joined').notNull().default(0),
  soloCount: integer('solo_count').notNull().default(0),
  version: integer('version').notNull().default(1),
  updatedAt: updatedAt(),
}, (t) => [index('motd_days_session_idx').on(t.sessionId)]);

export const motdVariants = pgTable('motd_variants', {
  date: date('date').notNull().references(() => motdDays.date, { onDelete: 'cascade' }),
  lengthMin: integer('length_min').notNull(),
  mediaId: uuid('media_id').notNull(),
}, (t) => [primaryKey({ columns: [t.date, t.lengthMin] }), check('motd_variants_length_chk', sql`${t.lengthMin} IN (10, 30, 45)`)]);

export const dailyMessages = pgTable('daily_messages', {
  date: date('date').primaryKey(),
  type: messageType('type').notNull(),
  title: varchar('title', { length: 120 }).notNull(),
  text: text('text'),
  mediaId: uuid('media_id'),
  imageMediaId: uuid('image_media_id'),
  durationSec: integer('duration_sec'),
  themeTag: varchar('theme_tag', { length: 40 }),
  status: contentStatus('status').notNull().default('draft'),
  version: integer('version').notNull().default(1),
  updatedAt: updatedAt(),
}, (t) => [
  index('daily_messages_status_date_idx').on(t.status, t.date.desc()),
  index('daily_messages_theme_date_idx').on(t.themeTag, t.date.desc()),
  index('daily_messages_title_trgm').using('gin', sql`${t.title} gin_trgm_ops`),
]);

export const soundBlocks = pgTable('sound_blocks', {
  id: uuid('id').primaryKey(),
  kind: blockKind('kind').notNull(),
  name: varchar('name', { length: 80 }).notNull(),
  mediaId: uuid('media_id').notNull(),
  durationSec: integer('duration_sec').notNull(),
  loopable: boolean('loopable').notNull().default(false),
  loudnessLufs: numeric('loudness_lufs', { precision: 5, scale: 2 }),
  access: access('access').notNull().default('premium'),
  order: integer('order').notNull().default(0),
  visible: boolean('visible').notNull().default(true),
  version: integer('version').notNull().default(1),
  createdAt: createdAt(),
}, (t) => [index('sound_blocks_kind_idx').on(t.kind, t.visible, t.order)]);

// ───────────── User activity ─────────────
export const meditations = pgTable('meditations', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
  recipeId: uuid('recipe_id'),
  kind: meditationKind('kind').notNull(),
  lengthVariant: integer('length_variant'),
  startedAt: ts('started_at').notNull(),
  endedAt: ts('ended_at').notNull(),
  durationSec: integer('duration_sec').notNull(),
  counted: boolean('counted').notNull().default(false),
  completed: boolean('completed').notNull().default(false),
  offline: boolean('offline').notNull().default(false),
  localDate: date('local_date').notNull(),
  country: char('country', { length: 2 }),
  createdAt: createdAt(),
}, (t) => [
  index('meditations_user_started_idx').on(t.userId, t.startedAt.desc()),
  index('meditations_session_started_idx').on(t.sessionId, t.startedAt),
  index('meditations_started_idx').on(t.startedAt),
]);

export const recipes = pgTable('recipes', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 60 }).notNull(),
  lengthMin: integer('length_min').notNull(),
  openingId: uuid('opening_id'),
  soundId: uuid('sound_id'),
  soundLevel: integer('sound_level').notNull().default(50),
  texture: varchar('texture', { length: 10 }).notNull().default('simple'),
  bells: jsonb('bells').notNull().default({ start: true, end: true, intervalMin: 0 }),
  blocks: jsonb('blocks').notNull().default([]),
  shareSlug: varchar('share_slug', { length: 16 }).unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('recipes_user_updated_idx').on(t.userId, t.updatedAt.desc())]);

// ───────────── Community ─────────────
export const dedications = pgTable('dedications', {
  id: uuid('id').primaryKey(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  meditationId: uuid('meditation_id').notNull().unique(),
  firstName: varchar('first_name', { length: 30 }).notNull(),
  country: char('country', { length: 2 }),
  text: varchar('text', { length: 200 }).notNull(),
  status: dedicationStatus('status').notNull().default('visible'),
  autoFlags: text('auto_flags').array().notNull().default(sql`'{}'::text[]`),
  reportCount: integer('report_count').notNull().default(0),
  holdingCount: integer('holding_count').notNull().default(0),
  moderatedBy: uuid('moderated_by'),
  moderatedAt: ts('moderated_at'),
  createdAt: createdAt(),
}, (t) => [
  index('dedications_session_status_idx').on(t.sessionId, t.status, t.createdAt.desc()),
  index('dedications_status_idx').on(t.status, t.createdAt.desc()),
  index('dedications_user_idx').on(t.userId, t.createdAt.desc()),
]);

export const dedicationHolds = pgTable('dedication_holds', {
  dedicationId: uuid('dedication_id').notNull().references(() => dedications.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.dedicationId, t.userId] })]);

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey(),
  dedicationId: uuid('dedication_id').notNull().references(() => dedications.id, { onDelete: 'cascade' }),
  reporterId: uuid('reporter_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  reason: varchar('reason', { length: 40 }).notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('reports_unique').on(t.dedicationId, t.reporterId)]);

export const userBlocks = pgTable('user_blocks', {
  blockerId: uuid('blocker_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  blockedId: uuid('blocked_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] })]);

// ───────────── Config, offers, revenue ─────────────
export const appConfig = pgTable('app_config', {
  key: varchar('key', { length: 40 }).primaryKey(),
  value: jsonb('value').notNull(),
  version: integer('version').notNull().default(1),
  updatedAt: updatedAt(),
  updatedBy: uuid('updated_by'),
});

export const offers = pgTable('offers', {
  id: varchar('id', { length: 40 }).primaryKey(),
  cap: integer('cap').notNull(),
  taken: integer('taken').notNull().default(0),
  open: boolean('open').notNull().default(true),
  productId: varchar('product_id', { length: 80 }).notNull(),
  openedAt: ts('opened_at').notNull().defaultNow(),
  closedAt: ts('closed_at'),
});

export const subscriptionEvents = pgTable('subscription_events', {
  id: varchar('id', { length: 80 }).primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  type: varchar('type', { length: 40 }).notNull(),
  productId: varchar('product_id', { length: 80 }),
  periodType: varchar('period_type', { length: 20 }),
  priceUsd: numeric('price_usd', { precision: 10, scale: 2 }),
  currency: char('currency', { length: 3 }),
  store: varchar('store', { length: 20 }),
  eventAt: ts('event_at').notNull(),
  receivedAt: ts('received_at').notNull().defaultNow(),
  raw: jsonb('raw').notNull(),
}, (t) => [
  index('sub_events_at_idx').on(t.eventAt.desc()),
  index('sub_events_user_idx').on(t.userId, t.eventAt.desc()),
  index('sub_events_type_idx').on(t.type, t.eventAt.desc()),
]);

// ───────────── Notifications ─────────────
export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey(),
  title: varchar('title', { length: 50 }).notNull(),
  body: varchar('body', { length: 150 }).notNull(),
  audience: audience('audience').notNull().default('all'),
  countries: text('countries').array().notNull().default(sql`'{}'::text[]`),
  deepLink: varchar('deep_link', { length: 200 }),
  sendMode: sendMode('send_mode').notNull().default('now'),
  sendAt: ts('send_at'),
  status: notificationStatus('status').notNull().default('draft'),
  targeted: integer('targeted').notNull().default(0),
  delivered: integer('delivered').notNull().default(0),
  opened: integer('opened').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
  version: integer('version').notNull().default(1),
}, (t) => [index('notifications_status_send_idx').on(t.status, t.sendAt)]);

export const autoNotifications = pgTable('auto_notifications', {
  key: varchar('key', { length: 40 }).primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
  title: varchar('title', { length: 50 }).notNull(),
  body: varchar('body', { length: 150 }).notNull(),
  delivered: integer('delivered').notNull().default(0),
  opened: integer('opened').notNull().default(0),
  updatedAt: updatedAt(),
});

export const pushLog = pgTable('push_log', {
  userId: uuid('user_id').notNull(),
  key: varchar('key', { length: 60 }).notNull(),
  localDate: date('local_date').notNull(),
  sentAt: ts('sent_at').notNull().defaultNow(),
  openedAt: ts('opened_at'),
}, (t) => [primaryKey({ columns: [t.userId, t.key, t.localDate] }), index('push_log_sent_idx').on(t.sentAt)]);

export const inboxItems = pgTable('inbox_items', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  type: varchar('type', { length: 30 }).notNull(),
  title: varchar('title', { length: 80 }).notNull(),
  body: varchar('body', { length: 200 }).notNull(),
  deepLink: varchar('deep_link', { length: 200 }),
  audience: audience('audience').notNull().default('all'),
  readAt: ts('read_at'),
  createdAt: createdAt(),
}, (t) => [index('inbox_user_idx').on(t.userId, t.createdAt.desc()), index('inbox_audience_idx').on(t.audience, t.createdAt.desc())]);

// ───────────── Admin ─────────────
export const adminUsers = pgTable('admin_users', {
  id: uuid('id').primaryKey(),
  email: citext('email').notNull().unique(),
  name: varchar('name', { length: 80 }).notNull(),
  role: adminRole('role').notNull(),
  status: adminStatus('status').notNull().default('invited'),
  passwordHash: text('password_hash'),
  totpSecret: text('totp_secret'),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  recoveryCodes: text('recovery_codes').array().notNull().default(sql`'{}'::text[]`),
  failedLogins: integer('failed_logins').notNull().default(0),
  lockedUntil: ts('locked_until'),
  lastSignInAt: ts('last_sign_in_at'),
  invitedBy: uuid('invited_by'),
  createdAt: createdAt(),
});

export const adminSessions = pgTable('admin_sessions', {
  id: uuid('id').primaryKey(),
  adminId: uuid('admin_id').notNull().references(() => adminUsers.id, { onDelete: 'cascade' }),
  tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
  userAgent: text('user_agent'),
  ip: inet('ip'),
  lastUsedAt: ts('last_used_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
}, (t) => [index('admin_sessions_admin_idx').on(t.adminId)]);

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  actorId: uuid('actor_id'),
  actorRole: varchar('actor_role', { length: 20 }),
  action: varchar('action', { length: 60 }).notNull(),
  targetType: varchar('target_type', { length: 40 }).notNull(),
  targetId: varchar('target_id', { length: 80 }),
  before: jsonb('before'),
  after: jsonb('after'),
  ip: inet('ip'),
  requestId: varchar('request_id', { length: 40 }),
  at: ts('at').notNull().defaultNow(),
}, (t) => [
  index('audit_target_idx').on(t.targetType, t.targetId, t.at.desc()),
  index('audit_actor_idx').on(t.actorId, t.at.desc()),
  index('audit_at_idx').on(t.at.desc()),
]);

export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey(),
  type: jobType('type').notNull(),
  status: jobStatus('status').notNull().default('queued'),
  progress: integer('progress').notNull().default(0),
  payload: jsonb('payload').notNull(),
  result: jsonb('result'),
  error: text('error'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('jobs_type_status_idx').on(t.type, t.status)]);

export const outboxEvents = pgTable('outbox_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  topic: varchar('topic', { length: 60 }).notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: createdAt(),
  publishedAt: ts('published_at'),
}, (t) => [index('outbox_unpublished_idx').on(t.publishedAt, t.id)]);

// ───────────── Analytics ─────────────
export const dailyAggregates = pgTable('daily_aggregates', {
  date: date('date').primaryKey(),
  meditations: integer('meditations').notNull().default(0),
  minutes: integer('minutes').notNull().default(0),
  groupMeditations: integer('group_meditations').notNull().default(0),
  activeUsers: integer('active_users').notNull().default(0),
  newUsers: integer('new_users').notNull().default(0),
  newTrials: integer('new_trials').notNull().default(0),
  newPaid: integer('new_paid').notNull().default(0),
  cancellations: integer('cancellations').notNull().default(0),
  revenueUsd: numeric('revenue_usd', { precision: 12, scale: 2 }).notNull().default('0'),
  peakLive: integer('peak_live').notNull().default(0),
  countries: jsonb('countries').notNull().default({}),
  byTheme: jsonb('by_theme').notNull().default({}),
  funnel: jsonb('funnel').notNull().default({}),
  updatedAt: updatedAt(),
});

export const analyticsEvents = pgTable('analytics_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: uuid('user_id'),
  installId: varchar('install_id', { length: 64 }),
  name: varchar('name', { length: 40 }).notNull(),
  props: jsonb('props').notNull().default({}),
  platform: platform('platform'),
  appVersion: varchar('app_version', { length: 20 }),
  at: ts('at').notNull(),
}, (t) => [index('analytics_name_at_idx').on(t.name, t.at), index('analytics_at_idx').on(t.at)]);
