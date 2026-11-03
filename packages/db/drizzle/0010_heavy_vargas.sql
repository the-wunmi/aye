ALTER TABLE "captures" ADD COLUMN "world_id" text;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "phase" text;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "place_key" text;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;