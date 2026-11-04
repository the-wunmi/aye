/**
 * Actor-scoped access to places, captures and artifacts. With worlds.ts and threads.ts, the only
 * way application code reads or writes user data.
 *
 * Every function takes the Actor and puts the authorisation rule into the SQL predicate, so
 * a row the actor may not see is never loaded — there is no "fetch by id, then check" path
 * to forget. Unauthorised and missing look the same (null / false), so ids reveal nothing.
 * The rules mirror policy.ts, which is the readable, unit-tested statement of them.
 */

import { hashJson } from "@aye/artifacts";
import {
  type ArtifactHash,
  type ArtifactRef,
  type GeoAnchor,
  type Place,
  type PlaceId,
  PlaceRevision,
  type Scene,
  type UserId,
  type Visibility,
  type WorldId,
} from "@aye/schema";
import { and, eq, exists, ne, or, type SQL, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { type Actor, geoForViewer, isUser, type WorldRole } from "./policy.ts";
import {
  artifactRefs,
  artifacts,
  captures,
  characters,
  commandLog,
  placeRevisions,
  places,
  worldMembers,
  worldPlaces,
} from "./schema.ts";
import type { CommandLogEntry } from "./types.ts";

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

const actorId = (actor: Actor): string | null => (isUser(actor) ? actor.userId : null);

/** SQL: the actor is a member of some world that includes `placeIdColumn`. */
function inMemberWorld(actor: Actor, placeIdColumn: SQL | typeof places.id): SQL {
  const uid = actorId(actor);
  if (uid === null) return sql`false`;
  return sql`exists (
    select 1 from ${worldPlaces} wp
    join ${worldMembers} wm on wm.world_id = wp.world_id
    where wp.place_id = ${placeIdColumn} and wm.user_id = ${uid}
  )`;
}

/** SQL predicate equivalent of policy.canReadPlace. */
function placeReadable(actor: Actor): SQL {
  const uid = actorId(actor);
  return or(
    uid === null ? sql`false` : eq(places.ownerId, uid),
    ne(places.visibility, "private"),
    inMemberWorld(actor, places.id),
  ) as SQL;
}

function toPlace(row: typeof places.$inferSelect, actor: Actor): Place {
  const stored: GeoAnchor | null =
    row.geo === null
      ? null
      : { lat: row.geo.y, lng: row.geo.x, bearingDeg: row.bearingDeg, precision: row.geoPrecision };
  return {
    id: row.id as PlaceId,
    ownerId: row.ownerId as UserId,
    name: row.name,
    visibility: row.visibility,
    geo: geoForViewer(stored, actorId(actor) === row.ownerId),
    head: row.head,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── Places ─────────────────────────────────────────────────────────────────────────

export async function getPlace(db: Db, actor: Actor, id: string): Promise<Place | null> {
  const [row] = await db
    .select()
    .from(places)
    .where(and(eq(places.id, id), placeReadable(actor)))
    .limit(1);
  return row ? toPlace(row, actor) : null;
}

export async function listOwnPlaces(db: Db, actor: Actor, limit = 100): Promise<Place[]> {
  const uid = actorId(actor);
  if (uid === null) return [];
  const rows = await db
    .select()
    .from(places)
    .where(eq(places.ownerId, uid))
    .orderBy(places.createdAt)
    .limit(Math.min(limit, 500));
  return rows.map((r) => toPlace(r, actor));
}

/** Public places within `radiusM` of a point. Locations come back coarsened for non-owners. */
export async function listPublicPlacesNear(
  db: Db,
  actor: Actor,
  near: { lat: number; lng: number },
  radiusM: number,
  limit = 50,
): Promise<Place[]> {
  const point = sql`ST_SetSRID(ST_MakePoint(${near.lng}, ${near.lat}), 4326)::geography`;
  const rows = await db
    .select()
    .from(places)
    .where(
      and(
        eq(places.visibility, "public"),
        sql`${places.geo} is not null`,
        sql`ST_DWithin(${places.geo}::geography, ${point}, ${Math.min(radiusM, 50_000)})`,
      ),
    )
    .limit(Math.min(limit, 200));
  return rows.map((r) => toPlace(r, actor));
}

export interface NewPlace {
  id: PlaceId;
  name: string;
  visibility: Visibility;
  geo: GeoAnchor | null;
}

export async function createPlace(db: Db, actor: Actor, input: NewPlace): Promise<Place> {
  const uid = actorId(actor);
  if (uid === null) throw new Error("anonymous actors cannot create places");
  const [row] = await db
    .insert(places)
    .values({
      id: input.id,
      ownerId: uid,
      name: input.name,
      visibility: input.visibility,
      geo: input.geo ? { x: input.geo.lng, y: input.geo.lat } : null,
      geoPrecision: input.geo?.precision ?? "none",
      bearingDeg: input.geo?.bearingDeg ?? 0,
    })
    .returning();
  return toPlace(row as typeof places.$inferSelect, actor);
}

/** Owner-only. Returns null when the place does not exist *or* the actor does not own it. */
export async function updatePlace(
  db: Db,
  actor: Actor,
  id: string,
  patch: Partial<Pick<NewPlace, "name" | "visibility">>,
): Promise<Place | null> {
  const uid = actorId(actor);
  if (uid === null) return null;
  const [row] = await db
    .update(places)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(places.id, id), eq(places.ownerId, uid)))
    .returning();
  return row ? toPlace(row, actor) : null;
}

/**
 * Commit a new revision and move the place's head, owner-only, with optimistic concurrency:
 * fails with ConflictError if someone else moved the head since `revision.parent`.
 *
 * Referencing an artifact from a record is what grants access to it, so a user may only
 * reference artifacts they can *already* read. Otherwise any owner could "reference" a hash
 * they merely know (say, someone else's video) and gain access to it.
 */
export async function commitRevision(
  db: Db,
  actor: Actor,
  revisionHash: ArtifactHash,
  revision: PlaceRevision,
): Promise<boolean> {
  const uid = actorId(actor);
  if (uid === null || revision.authorId !== uid) return false;
  const rev = PlaceRevision.parse(revision);
  for (const hash of new Set([rev.base.hash, rev.scene.hash])) {
    if (!(await canReadArtifact(db, actor, hash))) return false;
  }
  // A world is written by the harness and approved through approveWorld only, so an ordinary
  // edit must carry its parent's world unchanged: nobody hand-writes a spec into a shared world.
  const parentWorld = rev.parent === null ? null : await worldOf(db, uid, rev.parent);
  if (parentWorld === undefined) return false;
  if (
    (rev.world?.spec.hash ?? null) !== (parentWorld?.spec ?? null) ||
    (rev.world?.approved ?? false) !== (parentWorld?.approved ?? false)
  ) {
    return false;
  }
  return insertRevision(db, uid, revisionHash, rev, [rev.base.hash, rev.scene.hash]);
}

/** A revision's world, if the owner `uid` owns its place; undefined when not found. */
async function worldOf(
  db: Db,
  uid: string,
  revisionHash: ArtifactHash,
): Promise<{ spec: ArtifactHash; approved: boolean } | null | undefined> {
  const [row] = await db
    .select({ spec: placeRevisions.worldSpec, approved: placeRevisions.worldApproved })
    .from(placeRevisions)
    .innerJoin(places, eq(places.id, placeRevisions.placeId))
    .where(and(eq(placeRevisions.hash, revisionHash), eq(places.ownerId, uid)))
    .limit(1);
  if (!row) return undefined;
  return row.spec === null ? null : { spec: row.spec, approved: row.approved };
}

/** The world at a place's head, for anyone who can read the place. */
export async function getPlaceWorld(
  db: Db,
  actor: Actor,
  placeId: string,
): Promise<{ head: ArtifactHash; spec: ArtifactHash | null; approved: boolean } | null> {
  const [row] = await db
    .select({
      head: placeRevisions.hash,
      spec: placeRevisions.worldSpec,
      approved: placeRevisions.worldApproved,
    })
    .from(places)
    .innerJoin(placeRevisions, eq(placeRevisions.hash, places.head))
    .where(and(eq(places.id, placeId), placeReadable(actor)))
    .limit(1);
  return row ?? null;
}

/**
 * The owner approves the world written for the head of their place. Commits a new revision
 * identical to the head except that its world is approved. `spec` must be the one at the head
 * (so a stale review can't approve a world that was since rewritten)
 * and `head` the head the owner reviewed. Returns the new revision hash, or null when the
 * place isn't theirs or nothing matching is awaiting approval.
 */
export async function approveWorld(
  db: Db,
  actor: Actor,
  placeId: string,
  head: ArtifactHash,
  spec: ArtifactHash,
  now: Date = new Date(),
): Promise<ArtifactHash | null> {
  const uid = actorId(actor);
  if (uid === null) return null;
  const [row] = await db
    .select({ rev: placeRevisions })
    .from(placeRevisions)
    .innerJoin(places, eq(places.id, placeRevisions.placeId))
    .where(
      and(
        eq(places.id, placeId),
        eq(places.ownerId, uid),
        eq(places.head, head),
        eq(placeRevisions.hash, head),
      ),
    )
    .limit(1);
  if (!row || row.rev.worldSpec !== spec || row.rev.worldApproved) return null;
  const refs = await db
    .select()
    .from(artifacts)
    .where(
      or(
        eq(artifacts.hash, row.rev.base),
        eq(artifacts.hash, row.rev.scene),
        eq(artifacts.hash, spec),
      ),
    );
  const ref = (hash: ArtifactHash) => {
    const a = refs.find((r) => r.hash === hash);
    if (!a) throw new Error(`approveWorld: artifact ${hash} is not recorded`);
    return { hash, mediaType: a.mediaType, bytes: a.bytes };
  };
  const revision = PlaceRevision.parse({
    placeId,
    parent: head,
    base: ref(row.rev.base),
    edits: row.rev.edits,
    scene: ref(row.rev.scene),
    world: { spec: ref(spec), approved: true },
    authorId: uid,
    message: "Approve world",
    createdAt: now.toISOString(),
  });
  const revisionHash = hashJson(revision);
  const ok = await insertRevision(db, uid, revisionHash, revision, [
    revision.base.hash,
    revision.scene.hash,
    spec,
  ]);
  return ok ? revisionHash : null;
}

/**
 * Trusted path for the compile worker, which commits pipeline output on the owner's behalf.
 * What gets linked is derived from the revision itself (base, scene and world spec),
 * never from a caller-supplied list. Evidence masks come from raw video, so they are never
 * linked and stay private. Never call this from an HTTP handler.
 */
export async function systemCommitRevision(
  db: Db,
  ownerId: UserId,
  revisionHash: ArtifactHash,
  revision: PlaceRevision,
  scene: Scene,
): Promise<boolean> {
  const rev = PlaceRevision.parse(revision);
  if (rev.authorId !== ownerId || hashJson(scene) !== rev.scene.hash) {
    throw new Error("systemCommitRevision: scene does not match the revision");
  }
  return insertRevision(db, ownerId, revisionHash, rev, [
    rev.base.hash,
    rev.scene.hash,
    ...(rev.world ? [rev.world.spec.hash] : []),
  ]);
}

async function insertRevision(
  db: Db,
  uid: string,
  revisionHash: ArtifactHash,
  rev: PlaceRevision,
  referenced: readonly ArtifactHash[],
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const moved = await tx
      .update(places)
      .set({ head: revisionHash, updatedAt: new Date() })
      .where(
        and(
          eq(places.id, rev.placeId),
          eq(places.ownerId, uid),
          rev.parent === null ? sql`${places.head} is null` : eq(places.head, rev.parent),
        ),
      )
      .returning({ id: places.id });
    if (moved.length === 0) {
      const [owned] = await tx
        .select({ id: places.id })
        .from(places)
        .where(and(eq(places.id, rev.placeId), eq(places.ownerId, uid)));
      if (!owned) return false;
      throw new ConflictError("place head moved; rebase your edits onto the new head");
    }
    await tx
      .insert(placeRevisions)
      .values({
        hash: revisionHash,
        placeId: rev.placeId,
        parent: rev.parent,
        base: rev.base.hash,
        scene: rev.scene.hash,
        edits: rev.edits,
        worldSpec: rev.world?.spec.hash ?? null,
        worldApproved: rev.world?.approved ?? false,
        authorId: uid,
        message: rev.message,
      })
      .onConflictDoNothing();
    await tx
      .insert(artifactRefs)
      .values(
        [...new Set(referenced)].map((hash) => ({
          hash,
          kind: "place_revision" as const,
          recordId: revisionHash,
        })),
      )
      .onConflictDoNothing();
    return true;
  });
}

// ── Captures (raw video: owner-only, always) ────────────────────────────────────────

export async function getCapture(db: Db, actor: Actor, id: string) {
  const uid = actorId(actor);
  if (uid === null) return null;
  const [row] = await db
    .select()
    .from(captures)
    .where(and(eq(captures.id, id), eq(captures.ownerId, uid)))
    .limit(1);
  return row ?? null;
}

/**
 * A new capture of a place the actor owns: the owner is in the SQL predicate, so someone
 * else's place id creates nothing (null, like a place that doesn't exist). The video is
 * recorded as an artifact but linked to nothing: raw captures are the owner's alone, always.
 */
export async function createCapture(
  db: Db,
  actor: Actor,
  input: {
    id: string;
    placeId: string;
    video: ArtifactRef;
    durationMs: number;
    worldId: string | null;
  },
) {
  const uid = actorId(actor);
  if (uid === null) return null;
  return db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ id: places.id })
      .from(places)
      .where(and(eq(places.id, input.placeId), eq(places.ownerId, uid)))
      .limit(1);
    if (!owned) return null;
    await tx
      .insert(artifacts)
      .values({
        hash: input.video.hash,
        mediaType: input.video.mediaType,
        bytes: input.video.bytes,
      })
      .onConflictDoNothing();
    const [row] = await tx
      .insert(captures)
      .values({
        id: input.id,
        placeId: input.placeId,
        ownerId: uid,
        video: input.video.hash,
        videoBytes: input.video.bytes,
        mediaType: input.video.mediaType,
        durationMs: input.durationMs,
        worldId: input.worldId,
      })
      .returning();
    return row ?? null;
  });
}

// ── Worlds ─────────────────────────────────────────────────────────────────────────

export async function roleIn(
  db: Db,
  actor: Actor,
  worldId: WorldId | string,
): Promise<WorldRole | null> {
  const uid = actorId(actor);
  if (uid === null) return null;
  const [row] = await db
    .select({ role: worldMembers.role })
    .from(worldMembers)
    .where(and(eq(worldMembers.worldId, worldId), eq(worldMembers.userId, uid)))
    .limit(1);
  return row?.role ?? null;
}

/**
 * Append an intent to a world's log. Players and up only. No game code calls this yet, and
 * nothing replays the log (see `commandLog`).
 */
export async function appendCommand(
  db: Db,
  actor: Actor,
  worldId: string,
  tick: number,
  command: CommandLogEntry,
): Promise<number | null> {
  const uid = actorId(actor);
  if (uid === null) return null;
  const role = await roleIn(db, actor, worldId);
  if (role === null || role === "viewer") return null;
  const [row] = await db
    .insert(commandLog)
    .values({
      worldId,
      seq: sql`(select coalesce(max(${commandLog.seq}), 0) + 1 from ${commandLog} where ${commandLog.worldId} = ${worldId})`,
      tick,
      actorId: uid,
      command,
    })
    .returning({ seq: commandLog.seq });
  return row?.seq ?? null;
}

// ── Artifacts ──────────────────────────────────────────────────────────────────────

/**
 * May the actor download this artifact? Only via a record they can read that references it.
 * Knowing (or guessing) a hash grants nothing.
 */
export async function canReadArtifact(db: Db, actor: Actor, hash: ArtifactHash): Promise<boolean> {
  const uid = actorId(actor);
  const member = (worldIdCol: SQL) =>
    uid === null
      ? sql`false`
      : sql`exists (select 1 from ${worldMembers} m where m.world_id = ${worldIdCol} and m.user_id = ${uid})`;
  const viaCapture = and(
    eq(artifactRefs.kind, "capture"),
    uid === null
      ? sql`false`
      : exists(
          db
            .select({ one: sql`1` })
            .from(captures)
            .where(and(eq(captures.id, artifactRefs.recordId), eq(captures.ownerId, uid))),
        ),
  );
  const viaRevision = and(
    eq(artifactRefs.kind, "place_revision"),
    exists(
      db
        .select({ one: sql`1` })
        .from(placeRevisions)
        .innerJoin(places, eq(places.id, placeRevisions.placeId))
        .where(and(eq(placeRevisions.hash, artifactRefs.recordId), placeReadable(actor))),
    ),
  );
  const viaWorld = and(eq(artifactRefs.kind, "world"), member(sql`${artifactRefs.recordId}`));
  const viaCharacter = and(
    eq(artifactRefs.kind, "character"),
    exists(
      db
        .select({ one: sql`1` })
        .from(characters)
        .where(and(eq(characters.id, artifactRefs.recordId), member(sql`${characters.worldId}`))),
    ),
  );
  const [row] = await db
    .select({ one: sql`1` })
    .from(artifactRefs)
    .where(and(eq(artifactRefs.hash, hash), or(viaCapture, viaRevision, viaWorld, viaCharacter)))
    .limit(1);
  return row !== undefined;
}
