CREATE TYPE "public"."artifact_ref_kind" AS ENUM('capture', 'place_revision', 'world', 'character');--> statement-breakpoint
CREATE TYPE "public"."world_role" AS ENUM('owner', 'editor', 'player', 'viewer');--> statement-breakpoint
CREATE TABLE "artifact_refs" (
	"hash" text NOT NULL,
	"kind" "artifact_ref_kind" NOT NULL,
	"record_id" text NOT NULL,
	CONSTRAINT "artifact_refs_hash_kind_record_id_pk" PRIMARY KEY("hash","kind","record_id")
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"hash" text PRIMARY KEY NOT NULL,
	"media_type" text NOT NULL,
	"bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "captures" (
	"id" text PRIMARY KEY NOT NULL,
	"place_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"video" text NOT NULL,
	"video_bytes" bigint NOT NULL,
	"media_type" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"recorded_at" timestamp with time zone,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" text PRIMARY KEY NOT NULL,
	"world_id" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "command_log" (
	"world_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"tick" bigint NOT NULL,
	"actor_id" text NOT NULL,
	"command" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "command_log_world_id_seq_pk" PRIMARY KEY("world_id","seq")
);
--> statement-breakpoint
CREATE TABLE "pipeline_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"capture_id" text NOT NULL,
	"pipeline_hash" text NOT NULL,
	"status" text NOT NULL,
	"stages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scene" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "place_revisions" (
	"hash" text PRIMARY KEY NOT NULL,
	"place_id" text NOT NULL,
	"parent" text,
	"base" text NOT NULL,
	"scene" text NOT NULL,
	"edits" jsonb NOT NULL,
	"author_id" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "places" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"geo" geometry(point),
	"geo_precision" text DEFAULT 'none' NOT NULL,
	"bearing_deg" smallint DEFAULT 0 NOT NULL,
	"head" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"recipe_hash" text PRIMARY KEY NOT NULL,
	"record" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "world_links" (
	"id" text PRIMARY KEY NOT NULL,
	"world_id" text NOT NULL,
	"from_place_id" text NOT NULL,
	"from_portal_id" text NOT NULL,
	"to_place_id" text NOT NULL,
	"to_portal_id" text NOT NULL,
	"mode" text NOT NULL,
	"duration_min" integer NOT NULL,
	"fare" bigint NOT NULL,
	"bidirectional" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "world_members" (
	"world_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "world_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "world_members_world_id_user_id_pk" PRIMARY KEY("world_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "world_places" (
	"world_id" text NOT NULL,
	"place_id" text NOT NULL,
	"revision" text NOT NULL,
	"map_x" integer,
	"map_z" integer,
	CONSTRAINT "world_places_world_id_place_id_pk" PRIMARY KEY("world_id","place_id")
);
--> statement-breakpoint
CREATE TABLE "worlds" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"style" jsonb NOT NULL,
	"rules" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_log" ADD CONSTRAINT "command_log_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_log" ADD CONSTRAINT "command_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_revisions" ADD CONSTRAINT "place_revisions_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_revisions" ADD CONSTRAINT "place_revisions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_links" ADD CONSTRAINT "world_links_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_members" ADD CONSTRAINT "world_members_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_members" ADD CONSTRAINT "world_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_places" ADD CONSTRAINT "world_places_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_places" ADD CONSTRAINT "world_places_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worlds" ADD CONSTRAINT "worlds_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_refs_record_idx" ON "artifact_refs" USING btree ("kind","record_id");--> statement-breakpoint
CREATE INDEX "captures_owner_idx" ON "captures" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "captures_place_idx" ON "captures" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "characters_world_idx" ON "characters" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "pipeline_runs_capture_idx" ON "pipeline_runs" USING btree ("capture_id");--> statement-breakpoint
CREATE INDEX "place_revisions_place_idx" ON "place_revisions" USING btree ("place_id","created_at");--> statement-breakpoint
CREATE INDEX "places_owner_idx" ON "places" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "places_geo_idx" ON "places" USING gist ("geo");--> statement-breakpoint
CREATE INDEX "places_public_idx" ON "places" USING btree ("visibility") WHERE "places"."visibility" = 'public';--> statement-breakpoint
CREATE UNIQUE INDEX "users_handle_key" ON "users" USING btree (lower("handle"));--> statement-breakpoint
CREATE INDEX "world_links_world_idx" ON "world_links" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "world_members_user_idx" ON "world_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "world_places_place_idx" ON "world_places" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "worlds_owner_idx" ON "worlds" USING btree ("owner_id");