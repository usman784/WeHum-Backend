ALTER TABLE "users" ADD COLUMN "newsletter_synced_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "newsletter_error" varchar(120);
