CREATE TABLE "world_directors" (
	"world_id" text PRIMARY KEY NOT NULL,
	"memory" text DEFAULT '' NOT NULL,
	"last_minute" integer DEFAULT -1 NOT NULL,
	"day" text DEFAULT '' NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "world_directors" ADD CONSTRAINT "world_directors_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;