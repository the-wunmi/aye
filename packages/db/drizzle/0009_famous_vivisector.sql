CREATE TABLE "person_memories" (
	"world_id" text NOT NULL,
	"place_key" text NOT NULL,
	"person_key" text NOT NULL,
	"memory" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_memories_world_id_place_key_person_key_pk" PRIMARY KEY("world_id","place_key","person_key")
);
--> statement-breakpoint
ALTER TABLE "person_memories" ADD CONSTRAINT "person_memories_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;