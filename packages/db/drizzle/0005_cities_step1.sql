-- Characters and world pins from before cities have no owner or city key; they were starting
-- states only, so they are cleared rather than guessed at.
DELETE FROM "characters";--> statement-breakpoint
ALTER TABLE "world_links" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "world_links" CASCADE;--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "owner_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "status" text DEFAULT 'building' NOT NULL;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "characters_world_owner_key" ON "characters" USING btree ("world_id","owner_id");--> statement-breakpoint
CREATE INDEX "worlds_public_idx" ON "worlds" USING btree ("visibility") WHERE "worlds"."visibility" = 'public';--> statement-breakpoint
ALTER TABLE "places" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "world_places" DROP COLUMN "map_x";--> statement-breakpoint
ALTER TABLE "world_places" DROP COLUMN "map_z";