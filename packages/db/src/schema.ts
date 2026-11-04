/**
 * Postgres schema (PostGIS for geography). Drizzle table definitions are the source of
 * truth for migrations; JSON columns hold values already validated by @aye/schema.
 *
 * Large immutable content (videos, scenes, specs, pictures) lives in the artifact store; tables
 * hold hashes. `artifact_refs` records which record references which artifact, so the API can
 * authorise artifact downloads through the records an actor may read — a hash alone is
 * never a capability.
 */
import type {
  ArtifactHash,
  CaptureStatus,
  Character,
  EditOp,
  GeoPrecision,
  RunStatus,
  StageRecord,
  Thread,
  Visibility,
  WorldSettings,
  WorldStatus,
  WorldVisibility,
} from "@aye/schema";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  geometry,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { CommandLogEntry } from "./types.ts";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const hash = (name: string) => text(name).$type<ArtifactHash>();

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    handle: text("handle").notNull(),
    /** scrypt, self-describing (`scrypt$N$r$p$salt$hash`); null for accounts that can't log in. */
    passwordHash: text("password_hash"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_handle_key").on(sql`lower(${t.handle})`)],
);

/**
 * Login sessions. The cookie carries a random token; only its hash is stored, so a database
 * leak can't be replayed as sessions.
 */
export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const places = pgTable(
  "places",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    visibility: text("visibility").$type<Visibility>().notNull().default("private"),
    /** Stored as the owner gave it; others read it coarsened to `geoPrecision`, at most street. */
    geo: geometry("geo", { type: "point", mode: "xy", srid: 4326 }),
    geoPrecision: text("geo_precision").$type<GeoPrecision>().notNull().default("none"),
    bearingDeg: smallint("bearing_deg").notNull().default(0),
    head: hash("head"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("places_owner_idx").on(t.ownerId),
    index("places_geo_idx").using("gist", t.geo),
    index("places_public_idx").on(t.visibility).where(sql`${t.visibility} = 'public'`),
  ],
);

export const placeRevisions = pgTable(
  "place_revisions",
  {
    hash: hash("hash").primaryKey(),
    placeId: text("place_id")
      .notNull()
      .references(() => places.id, { onDelete: "cascade" }),
    parent: hash("parent"),
    base: hash("base").notNull(),
    scene: hash("scene").notNull(),
    edits: jsonb("edits").$type<EditOp[]>().notNull(),
    /** The place's world spec (an artifact a model wrote), and whether the owner approved it. */
    worldSpec: hash("world_spec"),
    worldApproved: boolean("world_approved").notNull().default(false),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id),
    message: text("message").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("place_revisions_place_idx").on(t.placeId, t.createdAt)],
);

export const captures = pgTable(
  "captures",
  {
    id: text("id").primaryKey(),
    placeId: text("place_id")
      .notNull()
      .references(() => places.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    video: hash("video").notNull(),
    videoBytes: bigint("video_bytes", { mode: "number" }).notNull(),
    mediaType: text("media_type").notNull(),
    durationMs: integer("duration_ms").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }),
    status: text("status").$type<CaptureStatus>().notNull().default("uploaded"),
    /** The city it's joining, if it was filmed for one. */
    worldId: text("world_id").references(() => worlds.id, { onDelete: "cascade" }),
    /** How far along it is, in a word code knows (shown in the player's own words). */
    phase: text("phase"),
    /** Its key in that city, once it has joined. */
    placeKey: text("place_key"),
    createdAt: createdAt(),
  },
  (t) => [index("captures_owner_idx").on(t.ownerId), index("captures_place_idx").on(t.placeId)],
);

export const pipelineRuns = pgTable(
  "pipeline_runs",
  {
    id: text("id").primaryKey(),
    captureId: text("capture_id")
      .notNull()
      .references(() => captures.id, { onDelete: "cascade" }),
    pipelineHash: hash("pipeline_hash").notNull(),
    status: text("status").$type<RunStatus>().notNull(),
    stages: jsonb("stages").$type<StageRecord[]>().notNull().default([]),
    scene: hash("scene"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("pipeline_runs_capture_idx").on(t.captureId)],
);

/** Memo table for generation: recipe hash → stage record. Shared, content-addressed, no PII. */
export const recipes = pgTable("recipes", {
  recipeHash: hash("recipe_hash").primaryKey(),
  record: jsonb("record").$type<StageRecord>().notNull(),
  createdAt: createdAt(),
});

export const artifacts = pgTable("artifacts", {
  hash: hash("hash").primaryKey(),
  mediaType: text("media_type").notNull(),
  bytes: bigint("bytes", { mode: "number" }).notNull(),
  createdAt: createdAt(),
});

export const artifactRefKind = pgEnum("artifact_ref_kind", [
  "capture",
  "place_revision",
  "world",
  "character",
]);

/** Which records reference which artifacts; the basis for authorising artifact reads. */
export const artifactRefs = pgTable(
  "artifact_refs",
  {
    hash: hash("hash").notNull(),
    kind: artifactRefKind("kind").notNull(),
    recordId: text("record_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.hash, t.kind, t.recordId] }),
    index("artifact_refs_record_idx").on(t.kind, t.recordId),
  ],
);

export const worlds = pgTable(
  "worlds",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    currency: text("currency").notNull(),
    visibility: text("visibility").$type<WorldVisibility>().notNull().default("private"),
    status: text("status").$type<WorldStatus>().notNull().default("building"),
    /** The city spec (an artifact a model wrote), once written. */
    city: hash("city"),
    /** What the owner asked for, in their words. Display only. */
    description: text("description").notNull().default(""),
    settings: jsonb("settings").$type<WorldSettings>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("worlds_owner_idx").on(t.ownerId),
    index("worlds_public_idx").on(t.visibility).where(sql`${t.visibility} = 'public'`),
  ],
);

export const worldRole = pgEnum("world_role", ["owner", "editor", "player", "viewer"]);

/**
 * A world's director: its own notes (model-only, never returned to anyone), when it last
 * acted, and its calls today. Read and written by trusted jobs only.
 */
export const worldDirectors = pgTable("world_directors", {
  worldId: text("world_id")
    .primaryKey()
    .references(() => worlds.id, { onDelete: "cascade" }),
  memory: text("memory").notNull().default(""),
  lastMinute: integer("last_minute").notNull().default(-1),
  day: text("day").notNull().default(""),
  calls: integer("calls").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const worldMembers = pgTable(
  "world_members",
  {
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: worldRole("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.userId] }),
    index("world_members_user_idx").on(t.userId),
  ],
);

export const worldPlaces = pgTable(
  "world_places",
  {
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    /** The place's key in the city spec. */
    key: text("key").notNull(),
    placeId: text("place_id")
      .notNull()
      .references(() => places.id, { onDelete: "cascade" }),
    /** Pinned revision: the place's owner editing it changes nothing here until a job re-pins. */
    revision: hash("revision").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.key] }),
    index("world_places_place_idx").on(t.placeId),
  ],
);

/**
 * Threads: what each player is in the middle of, written for them by their world's director.
 * A player reads and advances only their own (the realm does it as them). Only trusted jobs add
 * them, apart from the aim a new character starts with.
 */
export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    data: jsonb("data").$type<Thread>().notNull(),
    state: text("state").$type<Thread["state"]>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("threads_world_user_idx").on(t.worldId, t.userId, t.state)],
);

/**
 * What each person a world wrote remembers of the players they've met: their own note, kept
 * by the conversation stage, read by nothing else. Trusted jobs only.
 */
export const personMemories = pgTable(
  "person_memories",
  {
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    placeKey: text("place_key").notNull(),
    personKey: text("person_key").notNull(),
    memory: text("memory").notNull().default(""),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.worldId, t.placeKey, t.personKey] })],
);

export const characters = pgTable(
  "characters",
  {
    id: text("id").primaryKey(),
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The live character (money and needs as of when they last left a place). */
    data: jsonb("data").$type<Character>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("characters_world_idx").on(t.worldId),
    uniqueIndex("characters_world_owner_key").on(t.worldId, t.ownerId),
  ],
);

/** What players say in a place. Text only, bounded, shown as text. */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    /** City key of the place, and which copy of it (a private place's owner, or ""). */
    placeKey: text("place_key").notNull(),
    instance: text("instance").notNull(),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The speaker as shown (their character's name). */
    speaker: text("speaker").notNull(),
    text: text("text").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("chat_room_idx").on(t.worldId, t.placeKey, t.instance, t.createdAt)],
);

/**
 * Append-only log of player intents per world, written through `appendCommand`. Nothing in the
 * game writes or replays it yet: the realm runs each room's sim live and saves characters.
 */
export const commandLog = pgTable(
  "command_log",
  {
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    tick: bigint("tick", { mode: "number" }).notNull(),
    actorId: text("actor_id")
      .notNull()
      .references(() => users.id),
    command: jsonb("command").$type<CommandLogEntry>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.worldId, t.seq] })],
);
