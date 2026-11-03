CREATE TABLE "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"world_id" text NOT NULL,
	"place_key" text NOT NULL,
	"instance" text NOT NULL,
	"author_id" text NOT NULL,
	"speaker" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DELETE FROM "world_places";--> statement-breakpoint
ALTER TABLE "world_places" DROP CONSTRAINT "world_places_world_id_place_id_pk";--> statement-breakpoint
ALTER TABLE "world_places" ADD COLUMN "key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "world_places" ADD CONSTRAINT "world_places_world_id_key_pk" PRIMARY KEY("world_id","key");--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_room_idx" ON "chat_messages" USING btree ("world_id","place_key","instance","created_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");