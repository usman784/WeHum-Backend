CREATE TYPE "public"."gratitude_kind" AS ENUM('gratitude', 'affirmation', 'love');--> statement-breakpoint
CREATE TABLE "breath_patterns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(40) NOT NULL,
	"subtitle" varchar(80) DEFAULT '' NOT NULL,
	"inhale_sec" integer NOT NULL,
	"hold1_sec" integer DEFAULT 0 NOT NULL,
	"exhale_sec" integer NOT NULL,
	"hold2_sec" integer DEFAULT 0 NOT NULL,
	"rounds" integer DEFAULT 10 NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gratitude_posts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "gratitude_kind" DEFAULT 'gratitude' NOT NULL,
	"first_name" varchar(30) NOT NULL,
	"country" char(2),
	"text" varchar(200) NOT NULL,
	"status" "dedication_status" DEFAULT 'visible' NOT NULL,
	"auto_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"report_count" integer DEFAULT 0 NOT NULL,
	"moderated_by" uuid,
	"moderated_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gratitude_reports" (
	"post_id" uuid NOT NULL,
	"reporter_id" uuid NOT NULL,
	"reason" varchar(20) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gratitude_reports_post_id_reporter_id_pk" PRIMARY KEY("post_id","reporter_id")
);
--> statement-breakpoint
CREATE TABLE "user_breath_patterns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(40) NOT NULL,
	"inhale_sec" integer NOT NULL,
	"hold1_sec" integer DEFAULT 0 NOT NULL,
	"exhale_sec" integer NOT NULL,
	"hold2_sec" integer DEFAULT 0 NOT NULL,
	"rounds" integer DEFAULT 10 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_milestones" (
	"user_id" uuid NOT NULL,
	"key" varchar(40) NOT NULL,
	"reached_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_milestones_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
ALTER TABLE "challenge_participants" ADD COLUMN "last_day" date;--> statement-breakpoint
ALTER TABLE "gratitude_posts" ADD CONSTRAINT "gratitude_posts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gratitude_reports" ADD CONSTRAINT "gratitude_reports_post_id_gratitude_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."gratitude_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gratitude_reports" ADD CONSTRAINT "gratitude_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_breath_patterns" ADD CONSTRAINT "user_breath_patterns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_milestones" ADD CONSTRAINT "user_milestones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gratitude_kind_status_idx" ON "gratitude_posts" USING btree ("kind","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "gratitude_status_idx" ON "gratitude_posts" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "gratitude_user_idx" ON "gratitude_posts" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_breath_patterns_user_idx" ON "user_breath_patterns" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "challenge_participants_user_idx" ON "challenge_participants" USING btree ("user_id");