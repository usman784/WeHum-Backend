ALTER TYPE "public"."job_type" ADD VALUE IF NOT EXISTS 'beta_generate';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE IF NOT EXISTS 'beta_bulk';--> statement-breakpoint
CREATE TABLE "beta_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"prefix" varchar(16) NOT NULL,
	"email_domain" varchar(120) NOT NULL,
	"total" integer NOT NULL,
	"premium_count" integer DEFAULT 0 NOT NULL,
	"grant_expires_at" timestamp (3) with time zone,
	"seed_preset" varchar(20) DEFAULT 'blank' NOT NULL,
	"source" varchar(10) DEFAULT 'generate' NOT NULL,
	"status" varchar(12) DEFAULT 'creating' NOT NULL,
	"job_id" uuid,
	"created_by" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "beta_deletions" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid,
	"job_id" uuid,
	"step" varchar(12) DEFAULT 'blocked' NOT NULL,
	"error" varchar(300),
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "beta_grants" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"granted_by" uuid,
	"revoked_at" timestamp (3) with time zone,
	"expiry_notified_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "beta_ops" (
	"op_ref" varchar(120) PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"login" varchar(40) NOT NULL,
	"email" "citext" NOT NULL,
	"user_id" uuid,
	"intended_premium" boolean DEFAULT false NOT NULL,
	"grant_expires_at" timestamp (3) with time zone,
	"state" varchar(10) DEFAULT 'pending' NOT NULL,
	"error" varchar(300),
	"initial_password_active" boolean DEFAULT true NOT NULL,
	"display_name" varchar(30),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deleted_identities" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"login" varchar(40),
	"deleted_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seed_fixtures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"ref_id" varchar(80) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_test_account" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "beta_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "created_by_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "seed_preset" varchar(20);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_reason" varchar(200);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleting_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "access_rev" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "beta_grants" ADD CONSTRAINT "beta_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beta_ops" ADD CONSTRAINT "beta_ops_batch_id_beta_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."beta_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seed_fixtures" ADD CONSTRAINT "seed_fixtures_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "beta_batches_created_idx" ON "beta_batches" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "beta_grants_expiry_idx" ON "beta_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "beta_ops_login_idx" ON "beta_ops" USING btree ("login");--> statement-breakpoint
CREATE INDEX "beta_ops_batch_idx" ON "beta_ops" USING btree ("batch_id","state");--> statement-breakpoint
CREATE INDEX "beta_ops_user_idx" ON "beta_ops" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "deleted_identities_login_idx" ON "deleted_identities" USING btree ("login");--> statement-breakpoint
CREATE INDEX "seed_fixtures_user_idx" ON "seed_fixtures" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "users_test_batch_idx" ON "users" USING btree ("beta_batch_id","username") WHERE "users"."is_test_account";
