ALTER TABLE "place_revisions" ADD COLUMN "world_spec" text;--> statement-breakpoint
ALTER TABLE "place_revisions" ADD COLUMN "world_approved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "settings" jsonb NOT NULL;