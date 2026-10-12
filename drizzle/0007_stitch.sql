CREATE TABLE "group_intentions" (
	"user_id" uuid NOT NULL,
	"starts_at" timestamp (3) with time zone NOT NULL,
	"intention" varchar(60) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_intentions_user_id_starts_at_pk" PRIMARY KEY("user_id","starts_at")
);
--> statement-breakpoint
CREATE TABLE "saved_messages" (
	"user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_messages_user_id_date_pk" PRIMARY KEY("user_id","date")
);
--> statement-breakpoint
CREATE TABLE "session_kudos" (
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_kudos_user_id_session_id_local_date_pk" PRIMARY KEY("user_id","session_id","local_date")
);
--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "blurb" text;--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "lead_teacher_id" uuid;--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "badge_name" varchar(60);--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "grace_days" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "unlock_time" char(5) DEFAULT '07:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "schedule" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_messages" ADD COLUMN "transcript" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_messages" ADD COLUMN "video_media_id" uuid;--> statement-breakpoint
ALTER TABLE "daily_messages" ADD COLUMN "access" "access" DEFAULT 'premium' NOT NULL;--> statement-breakpoint
ALTER TABLE "dedications" ADD COLUMN "place" varchar(80);--> statement-breakpoint
ALTER TABLE "dedications" ADD COLUMN "author_kind" varchar(10) DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "preview_key" text;--> statement-breakpoint
ALTER TABLE "meditations" ADD COLUMN "hr_delta_bpm" smallint;--> statement-breakpoint
ALTER TABLE "meditations" ADD COLUMN "hr_avg_bpm" smallint;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "phases" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sound_blocks" ADD COLUMN "bell_role" varchar(10);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "weekly_goal" smallint DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "group_intentions" ADD CONSTRAINT "group_intentions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_messages" ADD CONSTRAINT "saved_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_kudos" ADD CONSTRAINT "session_kudos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_kudos" ADD CONSTRAINT "session_kudos_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_intentions_starts_idx" ON "group_intentions" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "session_kudos_session_date_idx" ON "session_kudos" USING btree ("session_id","local_date");--> statement-breakpoint
-- Stitch: new feature flags on an existing `main` row (streaks + challenges on, hourly sits and heart rate off).
UPDATE "app_config" SET "value" = jsonb_set("value", '{features}', coalesce("value"->'features', '{}'::jsonb) || '{"streaks": true, "challenges": true, "hourlySits": false, "heartRate": false}'::jsonb), "version" = "version" + 1 WHERE "key" = 'main';
