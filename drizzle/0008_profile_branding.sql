ALTER TABLE "users" ADD COLUMN "last_name" varchar(30);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "username" "citext";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "username_changed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_username_unique" UNIQUE("username");--> statement-breakpoint
ALTER TABLE "daily_messages" ADD COLUMN "publish_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "daily_messages" ADD COLUMN "push_time" char(5);
