CREATE TABLE "favorite_sessions" (
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorite_sessions_user_id_session_id_pk" PRIMARY KEY("user_id","session_id")
);
--> statement-breakpoint
ALTER TABLE "favorite_sessions" ADD CONSTRAINT "favorite_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorite_sessions" ADD CONSTRAINT "favorite_sessions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "favorite_sessions_user_idx" ON "favorite_sessions" USING btree ("user_id","created_at");