ALTER TABLE "place_revisions" ADD COLUMN "rulebook" text;--> statement-breakpoint
ALTER TABLE "place_revisions" ADD COLUMN "rules_approved" boolean DEFAULT false NOT NULL;