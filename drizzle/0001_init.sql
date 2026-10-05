CREATE TYPE "public"."access" AS ENUM('free', 'premium');--> statement-breakpoint
CREATE TYPE "public"."admin_role" AS ENUM('owner', 'admin', 'editor', 'moderator');--> statement-breakpoint
CREATE TYPE "public"."admin_status" AS ENUM('invited', 'active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."audience" AS ENUM('all', 'members', 'free', 'trial', 'guests', 'country');--> statement-breakpoint
CREATE TYPE "public"."auth_provider" AS ENUM('device', 'apple', 'google', 'email');--> statement-breakpoint
CREATE TYPE "public"."block_kind" AS ENUM('opening', 'core', 'closing', 'sound', 'bell', 'loop');--> statement-breakpoint
CREATE TYPE "public"."challenge_counts" AS ENUM('any', 'sleep', 'group');--> statement-breakpoint
CREATE TYPE "public"."content_status" AS ENUM('draft', 'scheduled', 'live', 'archived');--> statement-breakpoint
CREATE TYPE "public"."dedication_status" AS ENUM('visible', 'hidden', 'flagged');--> statement-breakpoint
CREATE TYPE "public"."email_token_purpose" AS ENUM('verify', 'magic_link', 'password_reset', 'admin_invite', 'admin_reset');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('media_probe', 'media_loudness', 'media_transcode', 'image_process', 'youtube_resolve', 'user_export', 'user_delete', 'push_send', 'rc_reconcile');--> statement-breakpoint
CREATE TYPE "public"."media_status" AS ENUM('uploading', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."meditation_kind" AS ENUM('motd', 'group', 'solo', 'silence', 'custom', 'program', 'sos', 'free');--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('audio', 'video', 'text');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."period_type" AS ENUM('trial', 'normal', 'intro', 'promotional');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('ios', 'android');--> statement-breakpoint
CREATE TYPE "public"."send_mode" AS ENUM('now', 'user_reminder_time', 'scheduled');--> statement-breakpoint
CREATE TYPE "public"."session_type" AS ENUM('audio', 'video', 'youtube');--> statement-breakpoint
CREATE TYPE "public"."store" AS ENUM('app_store', 'play_store', 'promotional', 'stripe');--> statement-breakpoint
CREATE TYPE "public"."theme_pref" AS ENUM('dark', 'light', 'system');--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_id" uuid NOT NULL,
	"token_hash" char(64) NOT NULL,
	"user_agent" text,
	"ip" "inet",
	"last_used_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	CONSTRAINT "admin_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" "citext" NOT NULL,
	"name" varchar(80) NOT NULL,
	"role" "admin_role" NOT NULL,
	"status" "admin_status" DEFAULT 'invited' NOT NULL,
	"password_hash" text,
	"totp_secret" text,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"recovery_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp (3) with time zone,
	"last_sign_in_at" timestamp (3) with time zone,
	"invited_by" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "analytics_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"install_id" varchar(64),
	"name" varchar(40) NOT NULL,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"platform" "platform",
	"app_version" varchar(20),
	"at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_config" (
	"key" varchar(40) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"actor_role" varchar(20),
	"action" varchar(60) NOT NULL,
	"target_type" varchar(40) NOT NULL,
	"target_id" varchar(80),
	"before" jsonb,
	"after" jsonb,
	"ip" "inet",
	"request_id" varchar(40),
	"at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "auth_provider" NOT NULL,
	"provider_uid" varchar(255) NOT NULL,
	"password_hash" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auto_notifications" (
	"key" varchar(40) PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"title" varchar(50) NOT NULL,
	"body" varchar(150) NOT NULL,
	"delivered" integer DEFAULT 0 NOT NULL,
	"opened" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "challenge_participants" (
	"challenge_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"completed_days" integer DEFAULT 0 NOT NULL,
	"finished_at" timestamp (3) with time zone,
	CONSTRAINT "challenge_participants_challenge_id_user_id_pk" PRIMARY KEY("challenge_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"days" integer NOT NULL,
	"counts" "challenge_counts" DEFAULT 'any' NOT NULL,
	"min_minutes" integer DEFAULT 3 NOT NULL,
	"members_only" boolean DEFAULT true NOT NULL,
	"show_on_you" boolean DEFAULT true NOT NULL,
	"cover_media_id" uuid,
	"starts_at" timestamp (3) with time zone,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_aggregates" (
	"date" date PRIMARY KEY NOT NULL,
	"meditations" integer DEFAULT 0 NOT NULL,
	"minutes" integer DEFAULT 0 NOT NULL,
	"group_meditations" integer DEFAULT 0 NOT NULL,
	"active_users" integer DEFAULT 0 NOT NULL,
	"new_users" integer DEFAULT 0 NOT NULL,
	"new_trials" integer DEFAULT 0 NOT NULL,
	"new_paid" integer DEFAULT 0 NOT NULL,
	"cancellations" integer DEFAULT 0 NOT NULL,
	"revenue_usd" numeric(12, 2) DEFAULT '0' NOT NULL,
	"peak_live" integer DEFAULT 0 NOT NULL,
	"countries" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"by_theme" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"funnel" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_messages" (
	"date" date PRIMARY KEY NOT NULL,
	"type" "message_type" NOT NULL,
	"title" varchar(120) NOT NULL,
	"text" text,
	"media_id" uuid,
	"image_media_id" uuid,
	"duration_sec" integer,
	"theme_tag" varchar(40),
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dedication_holds" (
	"dedication_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dedication_holds_dedication_id_user_id_pk" PRIMARY KEY("dedication_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "dedications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"meditation_id" uuid NOT NULL,
	"first_name" varchar(30) NOT NULL,
	"country" char(2),
	"text" varchar(200) NOT NULL,
	"status" "dedication_status" DEFAULT 'visible' NOT NULL,
	"auto_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"report_count" integer DEFAULT 0 NOT NULL,
	"holding_count" integer DEFAULT 0 NOT NULL,
	"moderated_by" uuid,
	"moderated_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dedications_meditation_id_unique" UNIQUE("meditation_id")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"install_id" varchar(64) NOT NULL,
	"platform" "platform" NOT NULL,
	"push_token" varchar(512),
	"app_version" varchar(20) NOT NULL,
	"os_version" varchar(40),
	"model" varchar(80),
	"last_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_install_id_unique" UNIQUE("install_id"),
	CONSTRAINT "devices_push_token_unique" UNIQUE("push_token")
);
--> statement-breakpoint
CREATE TABLE "email_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purpose" "email_token_purpose" NOT NULL,
	"email" "citext" NOT NULL,
	"user_id" uuid,
	"admin_id" uuid,
	"token_hash" char(64) NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"used_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "entitlements" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"product_id" varchar(80),
	"store" "store",
	"period_type" "period_type",
	"started_at" timestamp (3) with time zone,
	"expires_at" timestamp (3) with time zone,
	"will_renew" boolean DEFAULT false NOT NULL,
	"billing_issue" boolean DEFAULT false NOT NULL,
	"is_founding" boolean DEFAULT false NOT NULL,
	"last_event_at" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"type" varchar(30) NOT NULL,
	"title" varchar(80) NOT NULL,
	"body" varchar(200) NOT NULL,
	"deep_link" varchar(200),
	"audience" "audience" DEFAULT 'all' NOT NULL,
	"read_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" "job_type" NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" varchar(20) NOT NULL,
	"storage_key" text NOT NULL,
	"original_name" text,
	"mime" varchar(80) NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"checksum" char(64),
	"duration_sec" integer,
	"loudness_lufs" numeric(5, 2),
	"width" integer,
	"height" integer,
	"blurhash" varchar(64),
	"hls_key" text,
	"status" "media_status" DEFAULT 'uploading' NOT NULL,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "meditations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid,
	"recipe_id" uuid,
	"kind" "meditation_kind" NOT NULL,
	"length_variant" integer,
	"started_at" timestamp (3) with time zone NOT NULL,
	"ended_at" timestamp (3) with time zone NOT NULL,
	"duration_sec" integer NOT NULL,
	"counted" boolean DEFAULT false NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"offline" boolean DEFAULT false NOT NULL,
	"local_date" date NOT NULL,
	"country" char(2),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "motd_days" (
	"date" date PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"group_start_utc" char(5),
	"group_length_min" integer,
	"practiced_today" integer DEFAULT 0 NOT NULL,
	"group_joined" integer DEFAULT 0 NOT NULL,
	"solo_count" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "motd_variants" (
	"date" date NOT NULL,
	"length_min" integer NOT NULL,
	"media_id" uuid NOT NULL,
	CONSTRAINT "motd_variants_date_length_min_pk" PRIMARY KEY("date","length_min"),
	CONSTRAINT "motd_variants_length_chk" CHECK ("motd_variants"."length_min" IN (10, 30, 45))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" varchar(50) NOT NULL,
	"body" varchar(150) NOT NULL,
	"audience" "audience" DEFAULT 'all' NOT NULL,
	"countries" text[] DEFAULT '{}'::text[] NOT NULL,
	"deep_link" varchar(200),
	"send_mode" "send_mode" DEFAULT 'now' NOT NULL,
	"send_at" timestamp (3) with time zone,
	"status" "notification_status" DEFAULT 'draft' NOT NULL,
	"targeted" integer DEFAULT 0 NOT NULL,
	"delivered" integer DEFAULT 0 NOT NULL,
	"opened" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"cap" integer NOT NULL,
	"taken" integer DEFAULT 0 NOT NULL,
	"open" boolean DEFAULT true NOT NULL,
	"product_id" varchar(80) NOT NULL,
	"opened_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"topic" varchar(60) NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "program_days" (
	"program_id" uuid NOT NULL,
	"day" integer NOT NULL,
	"session_id" uuid NOT NULL,
	"title" varchar(120),
	CONSTRAINT "program_days_program_id_day_pk" PRIMARY KEY("program_id","day")
);
--> statement-breakpoint
CREATE TABLE "program_progress" (
	"user_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"current_day" integer DEFAULT 1 NOT NULL,
	"completed_days" integer[] DEFAULT '{}'::int[] NOT NULL,
	"completed_at" timestamp (3) with time zone,
	CONSTRAINT "program_progress_user_id_program_id_pk" PRIMARY KEY("user_id","program_id")
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" varchar(120) NOT NULL,
	"title" varchar(120) NOT NULL,
	"description" text,
	"cover_media_id" uuid,
	"cover_url" text,
	"access" "access" DEFAULT 'premium' NOT NULL,
	"unlock_rule" varchar(30) DEFAULT 'next_day_0700' NOT NULL,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "programs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "push_log" (
	"user_id" uuid NOT NULL,
	"key" varchar(60) NOT NULL,
	"local_date" date NOT NULL,
	"sent_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp (3) with time zone,
	CONSTRAINT "push_log_user_id_key_local_date_pk" PRIMARY KEY("user_id","key","local_date")
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(60) NOT NULL,
	"length_min" integer NOT NULL,
	"opening_id" uuid,
	"sound_id" uuid,
	"sound_level" integer DEFAULT 50 NOT NULL,
	"texture" varchar(10) DEFAULT 'simple' NOT NULL,
	"bells" jsonb DEFAULT '{"start":true,"end":true,"intervalMin":0}'::jsonb NOT NULL,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"share_slug" varchar(16),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipes_share_slug_unique" UNIQUE("share_slug")
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" char(64) NOT NULL,
	"device_id" uuid,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"used_at" timestamp (3) with time zone,
	"revoked_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dedication_id" uuid NOT NULL,
	"reporter_id" uuid NOT NULL,
	"reason" varchar(40) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" varchar(120) NOT NULL,
	"title" varchar(120) NOT NULL,
	"description" text,
	"type" "session_type" NOT NULL,
	"access" "access" DEFAULT 'premium' NOT NULL,
	"theme_id" uuid,
	"teacher_id" uuid,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"duration_sec" integer NOT NULL,
	"media_id" uuid,
	"youtube_id" varchar(20),
	"cover_media_id" uuid,
	"cover_url" text,
	"downloadable" boolean DEFAULT true NOT NULL,
	"is_sos" boolean DEFAULT false NOT NULL,
	"sos_feeling" varchar(40),
	"sos_subtitle" varchar(80),
	"sos_order" integer,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"publish_at" timestamp (3) with time zone,
	"plays" integer DEFAULT 0 NOT NULL,
	"completions" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "sessions_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "sound_blocks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "block_kind" NOT NULL,
	"name" varchar(80) NOT NULL,
	"media_id" uuid NOT NULL,
	"duration_sec" integer NOT NULL,
	"loopable" boolean DEFAULT false NOT NULL,
	"loudness_lufs" numeric(5, 2),
	"access" "access" DEFAULT 'premium' NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_events" (
	"id" varchar(80) PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"type" varchar(40) NOT NULL,
	"product_id" varchar(80),
	"period_type" varchar(20),
	"price_usd" numeric(10, 2),
	"currency" char(3),
	"store" varchar(20),
	"event_at" timestamp (3) with time zone NOT NULL,
	"received_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"raw" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teachers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"role" varchar(80),
	"specialty" varchar(120),
	"bio" text,
	"quote" varchar(280),
	"photo_media_id" uuid,
	"photo_url" text,
	"youtube_url" text,
	"instagram_url" text,
	"website_url" text,
	"visible" boolean DEFAULT true NOT NULL,
	"can_lead_group" boolean DEFAULT false NOT NULL,
	"admin_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teachers_admin_id_unique" UNIQUE("admin_id")
);
--> statement-breakpoint
CREATE TABLE "themes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" varchar(60) NOT NULL,
	"name" varchar(60) NOT NULL,
	"subtitle" varchar(120),
	"description" text,
	"icon_key" varchar(40),
	"icon_media_id" uuid,
	"order" integer DEFAULT 0 NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "themes_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "user_blocks" (
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_blocks_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id")
);
--> statement-breakpoint
CREATE TABLE "user_daily_stats" (
	"user_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"minutes" integer DEFAULT 0 NOT NULL,
	"meditations" integer DEFAULT 0 NOT NULL,
	"group_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "user_daily_stats_user_id_local_date_pk" PRIMARY KEY("user_id","local_date")
);
--> statement-breakpoint
CREATE TABLE "user_stats" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"minutes_total" integer DEFAULT 0 NOT NULL,
	"meditations_total" integer DEFAULT 0 NOT NULL,
	"group_total" integer DEFAULT 0 NOT NULL,
	"dedications_total" integer DEFAULT 0 NOT NULL,
	"first_meditation_at" timestamp (3) with time zone,
	"last_meditation_at" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"first_name" varchar(30),
	"email" "citext",
	"email_verified_at" timestamp (3) with time zone,
	"is_guest" boolean DEFAULT true NOT NULL,
	"country" char(2),
	"timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"locale" varchar(10) DEFAULT 'en' NOT NULL,
	"theme" "theme_pref" DEFAULT 'dark' NOT NULL,
	"reminder_enabled" boolean DEFAULT true NOT NULL,
	"reminder_time" char(5) DEFAULT '07:00' NOT NULL,
	"group_warning" boolean DEFAULT false NOT NULL,
	"daily_message_push" boolean DEFAULT true NOT NULL,
	"show_country" boolean DEFAULT true NOT NULL,
	"muted_at" timestamp (3) with time zone,
	"token_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_id_admin_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_participants" ADD CONSTRAINT "challenge_participants_challenge_id_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_participants" ADD CONSTRAINT "challenge_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dedication_holds" ADD CONSTRAINT "dedication_holds_dedication_id_dedications_id_fk" FOREIGN KEY ("dedication_id") REFERENCES "public"."dedications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dedication_holds" ADD CONSTRAINT "dedication_holds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dedications" ADD CONSTRAINT "dedications_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dedications" ADD CONSTRAINT "dedications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meditations" ADD CONSTRAINT "meditations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meditations" ADD CONSTRAINT "meditations_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motd_days" ADD CONSTRAINT "motd_days_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motd_variants" ADD CONSTRAINT "motd_variants_date_motd_days_date_fk" FOREIGN KEY ("date") REFERENCES "public"."motd_days"("date") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_days" ADD CONSTRAINT "program_days_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_days" ADD CONSTRAINT "program_days_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_progress" ADD CONSTRAINT "program_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_progress" ADD CONSTRAINT "program_progress_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_dedication_id_dedications_id_fk" FOREIGN KEY ("dedication_id") REFERENCES "public"."dedications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_theme_id_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."themes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocker_id_users_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_daily_stats" ADD CONSTRAINT "user_daily_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_stats" ADD CONSTRAINT "user_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_sessions_admin_idx" ON "admin_sessions" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "analytics_name_at_idx" ON "analytics_events" USING btree ("name","at");--> statement-breakpoint
CREATE INDEX "analytics_at_idx" ON "analytics_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_target_idx" ON "audit_log" USING btree ("target_type","target_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit_log" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_provider_uid" ON "auth_identities" USING btree ("provider","provider_uid");--> statement-breakpoint
CREATE INDEX "auth_identities_user_idx" ON "auth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "daily_messages_status_date_idx" ON "daily_messages" USING btree ("status","date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "daily_messages_theme_date_idx" ON "daily_messages" USING btree ("theme_tag","date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "daily_messages_title_trgm" ON "daily_messages" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "dedications_session_status_idx" ON "dedications" USING btree ("session_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "dedications_status_idx" ON "dedications" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "dedications_user_idx" ON "dedications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "devices_user_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "email_tokens_email_purpose_idx" ON "email_tokens" USING btree ("email","purpose");--> statement-breakpoint
CREATE INDEX "entitlements_active_period_idx" ON "entitlements" USING btree ("active","period_type");--> statement-breakpoint
CREATE INDEX "entitlements_product_idx" ON "entitlements" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "inbox_user_idx" ON "inbox_items" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inbox_audience_idx" ON "inbox_items" USING btree ("audience","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "jobs_type_status_idx" ON "jobs" USING btree ("type","status");--> statement-breakpoint
CREATE INDEX "media_assets_checksum_idx" ON "media_assets" USING btree ("checksum");--> statement-breakpoint
CREATE INDEX "meditations_user_started_idx" ON "meditations" USING btree ("user_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "meditations_session_started_idx" ON "meditations" USING btree ("session_id","started_at");--> statement-breakpoint
CREATE INDEX "meditations_started_idx" ON "meditations" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "motd_days_session_idx" ON "motd_days" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "notifications_status_send_idx" ON "notifications" USING btree ("status","send_at");--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox_events" USING btree ("published_at","id");--> statement-breakpoint
CREATE INDEX "push_log_sent_idx" ON "push_log" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "recipes_user_updated_idx" ON "recipes" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_exp_idx" ON "refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_unique" ON "reports" USING btree ("dedication_id","reporter_id");--> statement-breakpoint
CREATE INDEX "sessions_status_publish_idx" ON "sessions" USING btree ("status","publish_at");--> statement-breakpoint
CREATE INDEX "sessions_theme_status_idx" ON "sessions" USING btree ("theme_id","status");--> statement-breakpoint
CREATE INDEX "sessions_access_status_idx" ON "sessions" USING btree ("access","status");--> statement-breakpoint
CREATE INDEX "sessions_sos_idx" ON "sessions" USING btree ("is_sos","sos_order");--> statement-breakpoint
CREATE INDEX "sessions_tags_gin" ON "sessions" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "sessions_title_trgm" ON "sessions" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "sound_blocks_kind_idx" ON "sound_blocks" USING btree ("kind","visible","order");--> statement-breakpoint
CREATE INDEX "sub_events_at_idx" ON "subscription_events" USING btree ("event_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sub_events_user_idx" ON "subscription_events" USING btree ("user_id","event_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sub_events_type_idx" ON "subscription_events" USING btree ("type","event_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "themes_visible_order_idx" ON "themes" USING btree ("visible","order");--> statement-breakpoint
CREATE INDEX "users_guest_created_idx" ON "users" USING btree ("is_guest","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "users_last_active_idx" ON "users" USING btree ("last_active_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "users_reminder_idx" ON "users" USING btree ("timezone","reminder_time");--> statement-breakpoint
CREATE INDEX "users_first_name_trgm" ON "users" USING gin ("first_name" gin_trgm_ops);