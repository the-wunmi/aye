/**
 * Actor-scoped access to worlds, characters and chat (same rules as repo.ts: the
 * authorisation is in the SQL predicate, and not-allowed looks like not-found).
 *
 * - A world is readable by its members, and by anyone signed in once it is public and ready.
 * - Joining a public world makes you a player. Players, editors and owners can play.
 * - A character belongs to one player and one world; only its owner reads or saves it, and
 *   only while they can play the world.
 * - Chat is readable and writable by those who can play the world; a private place's chat
 *   (instance = its owner's id) only by that owner.
 */

import type {
  ArtifactHash,
  Character,
  CharacterId,
  UserId,
  World,
  WorldId,
  WorldPlace,
  WorldSettings,
  WorldVisibility,
} from "@aye/schema";
import { Character as CharacterSchema } from "@aye/schema";
import { and, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { type Actor, isUser } from "./policy.ts";
import {
  artifactRefs,
  captures,
  characters,
  chatMessages,
  placeRevisions,
  places,
  worldMembers,
  worldPlaces,
  worlds,
} from "./schema.ts";

const uidOf = (actor: Actor): string | null => (isUser(actor) ? actor.userId : null);

function isMember(uid: string, worldIdCol: SQL | typeof worlds.id): SQL {
  return sql`exists (select 1 from ${worldMembers} m where m.world_id = ${worldIdCol} and m.user_id = ${uid})`;
}

function canPlay(uid: string, worldIdCol: SQL | typeof worlds.id): SQL {
  return sql`exists (select 1 from ${worldMembers} m where m.world_id = ${worldIdCol} and m.user_id = ${uid} and m.role in ('owner', 'editor', 'player'))`;
}

/** SQL: the actor may read this world. */
function worldReadable(actor: Actor): SQL {
  const uid = uidOf(actor);
  if (uid === null) return sql`false`;
  return or(
    and(eq(worlds.visibility, "public"), eq(worlds.status, "ready")),
    isMember(uid, worlds.id),
  ) as SQL;
}

export interface WorldSummary {
  id: WorldId;
  name: string;
  description: string;
  visibility: WorldVisibility;
  status: World["status"];
  city: ArtifactHash | null;
  owner: boolean;
  /** You've joined it (or made it), so it's yours to come back to. */
  joined: boolean;
  /** When it was made: same-named cities need telling apart. */
  madeAt: string;
  /** What a model wrote for this point in its first build. Display only. */
  buildNote: string | null;
}

function toSummary(
  row: typeof worlds.$inferSelect,
  uid: string | null,
  joined = row.ownerId === uid,
): WorldSummary {
  return {
    id: row.id as WorldId,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    status: row.status,
    city: row.city,
    owner: row.ownerId === uid,
    joined,
    madeAt: row.createdAt.toISOString(),
    buildNote: row.buildNote,
  };
}

export async function createWorld(
  db: Db,
  actor: Actor,
  input: {
    id: WorldId;
    name: string;
    description: string;
    currency: string;
    visibility: WorldVisibility;
    settings: WorldSettings;
  },
): Promise<WorldSummary> {
  const uid = uidOf(actor);
  if (uid === null) throw new Error("anonymous actors cannot create worlds");
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(worlds)
      .values({ ...input, ownerId: uid, status: "building" })
      .returning();
    await tx.insert(worldMembers).values({ worldId: input.id, userId: uid, role: "owner" });
    return toSummary(row as typeof worlds.$inferSelect, uid);
  });
}

/** Worlds you belong to and public ready ones, newest first. */
const MIN_BUILDS_FOR_TYPICAL = 3;

export async function listWorlds(db: Db, actor: Actor, limit = 50): Promise<WorldSummary[]> {
  const uid = uidOf(actor);
  if (uid === null) return [];
  const rows = await db
    .select()
    .from(worlds)
    .where(worldReadable(actor))
    .orderBy(desc(worlds.createdAt))
    .limit(Math.min(limit, 200));
  const mine = await db
    .select({ worldId: worldMembers.worldId })
    .from(worldMembers)
    .where(eq(worldMembers.userId, uid));
  const joined = new Set(mine.map((m) => m.worldId));
  return rows.map((r) => toSummary(r, uid, joined.has(r.id)));
}

/**
 * Finished cities anyone may see, for people who haven't signed up yet. It's only what a public
 * city already shows its visitors, and nothing about who made it.
 */
export async function listOpenCities(db: Db, limit = 12) {
  return db
    .select({ id: worlds.id, name: worlds.name, description: worlds.description })
    .from(worlds)
    .where(and(eq(worlds.visibility, "public"), eq(worlds.status, "ready")))
    .orderBy(desc(worlds.createdAt))
    .limit(Math.min(limit, 50));
}

/** How long recent first builds took, in minutes, once there are enough to go on. */
export async function typicalBuildMinutes(
  db: Db,
): Promise<{ lowMin: number; highMin: number } | null> {
  const rows = await db.execute(
    sql`select count(*)::int as n,
          percentile_cont(0.5) within group (order by m) as low,
          percentile_cont(0.9) within group (order by m) as high
        from (
          select extract(epoch from ready_at - created_at) / 60 as m
          from worlds where ready_at is not null
          order by created_at desc limit 30
        ) recent`,
  );
  const row = (rows as unknown as { n: number; low: number | null; high: number | null }[])[0];
  if (!row || row.n < MIN_BUILDS_FOR_TYPICAL || row.low === null || row.high === null) return null;
  return { lowMin: Math.round(row.low), highMin: Math.ceil(row.high) };
}

export interface WorldDetail extends WorldSummary {
  /** When the world began: its clock runs from here. */
  createdAt: string;
  settings: WorldSettings;
  currency: string;
  places: WorldPlace[];
  role: "owner" | "editor" | "player" | "viewer" | null;
}

export async function getWorld(db: Db, actor: Actor, id: string): Promise<WorldDetail | null> {
  const uid = uidOf(actor);
  const [row] = await db
    .select()
    .from(worlds)
    .where(and(eq(worlds.id, id), worldReadable(actor)))
    .limit(1);
  if (!row || uid === null) return null;
  const [places, member] = await Promise.all([
    db.select().from(worldPlaces).where(eq(worldPlaces.worldId, id)).orderBy(worldPlaces.key),
    db
      .select({ role: worldMembers.role })
      .from(worldMembers)
      .where(and(eq(worldMembers.worldId, id), eq(worldMembers.userId, uid)))
      .limit(1),
  ]);
  return {
    ...toSummary(row, uid),
    createdAt: row.createdAt.toISOString(),
    settings: row.settings,
    currency: row.currency,
    places: places.map((p) => ({
      key: p.key,
      placeId: p.placeId as WorldPlace["placeId"],
      revision: p.revision as ArtifactHash,
    })),
    role: member[0]?.role ?? null,
  };
}

/**
 * Delete a world you own, with everything that belongs to it (members, characters, chat,
 * pinned places, its director), and stop it granting any artifact. Only its owner can, and
 * the rule is in the predicate: anyone else, or a world that doesn't exist, gets false.
 */
export async function deleteWorld(db: Db, actor: Actor, id: string): Promise<boolean> {
  const uid = uidOf(actor);
  if (uid === null) return false;
  return db.transaction(async (tx) => {
    const gone = await tx
      .delete(worlds)
      .where(and(eq(worlds.id, id), eq(worlds.ownerId, uid)))
      .returning({ id: worlds.id });
    if (gone.length === 0) return false;
    await tx
      .delete(artifactRefs)
      .where(and(eq(artifactRefs.kind, "world"), eq(artifactRefs.recordId, id)));
    return true;
  });
}

/** Join a public, ready world as a player. Returns your role, or null if you can't. */
export async function joinWorld(db: Db, actor: Actor, id: string) {
  const uid = uidOf(actor);
  if (uid === null) return null;
  await db.execute(sql`
    insert into ${worldMembers} (world_id, user_id, role)
    select ${worlds.id}, ${uid}, 'player' from ${worlds}
    where ${worlds.id} = ${id} and ${worlds.visibility} = 'public' and ${worlds.status} = 'ready'
    on conflict do nothing`);
  const [row] = await db
    .select({ role: worldMembers.role })
    .from(worldMembers)
    .where(and(eq(worldMembers.worldId, id), eq(worldMembers.userId, uid)))
    .limit(1);
  return row?.role ?? null;
}

/** Owner-only: make a world public (or private again). Others see it only once it's ready. */
export async function setWorldVisibility(
  db: Db,
  actor: Actor,
  id: string,
  visibility: WorldVisibility,
): Promise<boolean> {
  const uid = uidOf(actor);
  if (uid === null) return false;
  const rows = await db
    .update(worlds)
    .set({ visibility, updatedAt: new Date() })
    .where(and(eq(worlds.id, id), eq(worlds.ownerId, uid)))
    .returning({ id: worlds.id });
  return rows.length > 0;
}

/** Every place's world spec in a world the actor can read, member or not: for counting them. */
export async function listPinnedSpecs(
  db: Db,
  actor: Actor,
  worldId: string,
): Promise<ArtifactHash[]> {
  const rows = await db
    .select({ spec: placeRevisions.worldSpec })
    .from(worldPlaces)
    .innerJoin(placeRevisions, eq(placeRevisions.hash, worldPlaces.revision))
    .innerJoin(worlds, eq(worlds.id, worldPlaces.worldId))
    .where(and(eq(worldPlaces.worldId, worldId), worldReadable(actor)));
  return rows.flatMap((r) => (r.spec ? [r.spec] : []));
}

/** The keys of a world's places this actor owns, if they play there: theirs to rearrange. */
export async function listOwnedPlaceKeys(db: Db, actor: Actor, worldId: string): Promise<string[]> {
  const uid = uidOf(actor);
  if (uid === null) return [];
  const rows = await db
    .select({ key: worldPlaces.key })
    .from(worldPlaces)
    .innerJoin(places, eq(places.id, worldPlaces.placeId))
    .where(
      and(
        eq(worldPlaces.worldId, worldId),
        eq(places.ownerId, uid),
        canPlay(uid, sql`${worldPlaces.worldId}`),
      ),
    );
  return rows.map((r) => r.key);
}

/**
 * A place as pinned in a world, for someone who can play it: the scene and world spec of its
 * pinned revision. Null if they can't play the world, or nothing is pinned under that key.
 */
/**
 * The keys of a world's filmed places this actor may take away: what they filmed, or anything
 * filmed in a city they own. A place a model built isn't something filming can undo.
 */
export async function listRemovablePlaceKeys(
  db: Db,
  actor: Actor,
  worldId: string,
): Promise<string[]> {
  const uid = uidOf(actor);
  if (uid === null) return [];
  const rows = await db
    .selectDistinct({ key: worldPlaces.key })
    .from(worldPlaces)
    .innerJoin(places, eq(places.id, worldPlaces.placeId))
    .innerJoin(captures, eq(captures.placeId, worldPlaces.placeId))
    .innerJoin(worlds, eq(worlds.id, worldPlaces.worldId))
    .where(
      and(
        eq(worldPlaces.worldId, worldId),
        or(eq(places.ownerId, uid), eq(worlds.ownerId, uid)),
        canPlay(uid, sql`${worldPlaces.worldId}`),
      ),
    );
  return rows.map((r) => r.key);
}

export async function getPinnedPlace(
  db: Db,
  actor: Actor,
  worldId: string,
  key: string,
): Promise<{
  placeId: string;
  revision: ArtifactHash;
  scene: ArtifactHash;
  spec: ArtifactHash | null;
} | null> {
  const uid = uidOf(actor);
  if (uid === null) return null;
  const [row] = await db
    .select({
      placeId: worldPlaces.placeId,
      revision: worldPlaces.revision,
      scene: placeRevisions.scene,
      spec: placeRevisions.worldSpec,
    })
    .from(worldPlaces)
    .innerJoin(placeRevisions, eq(placeRevisions.hash, worldPlaces.revision))
    .where(
      and(
        eq(worldPlaces.worldId, worldId),
        eq(worldPlaces.key, key),
        canPlay(uid, sql`${worldPlaces.worldId}`),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ── Characters ──────────────────────────────────────────────────────────────────────

/** Create your character in a world you can play. One per player per world; null otherwise. */
export async function createCharacter(
  db: Db,
  actor: Actor,
  character: Omit<Character, "ownerId" | "updatedAt">,
): Promise<Character | null> {
  const uid = uidOf(actor);
  if (uid === null) return null;
  const now = new Date();
  const data: Character = {
    ...character,
    ownerId: uid as UserId,
    updatedAt: now.toISOString(),
  };
  const rows = await db.execute<{ id: string }>(sql`
    insert into ${characters} (id, world_id, owner_id, data, updated_at)
    select ${character.id}, ${character.worldId}, ${uid}, ${JSON.stringify(data)}::jsonb, ${now.toISOString()}::timestamptz
    where ${canPlay(uid, sql`${character.worldId}`)}
    on conflict do nothing
    returning id`);
  return rows.length > 0 ? data : null;
}

/** Your character in a world, if you have one and can still play there. */
export async function getMyCharacter(
  db: Db,
  actor: Actor,
  worldId: string,
): Promise<Character | null> {
  const uid = uidOf(actor);
  if (uid === null) return null;
  const [row] = await db
    .select({ data: characters.data })
    .from(characters)
    .where(
      and(
        eq(characters.worldId, worldId),
        eq(characters.ownerId, uid),
        canPlay(uid, sql`${characters.worldId}`),
      ),
    )
    .limit(1);
  // Saved before a field existed? It reads back with that field's default.
  return row ? CharacterSchema.parse(row.data) : null;
}

/**
 * Save your character's live state (money, needs, where they are). Only the owner, only their
 * own character, only in a world they can play. The realm server calls this with the
 * connected player's actor; the values come from the authoritative sim, never the client.
 */
export async function saveCharacter(db: Db, actor: Actor, character: Character): Promise<boolean> {
  const uid = uidOf(actor);
  if (uid === null || character.ownerId !== uid) return false;
  const data: Character = { ...character, updatedAt: new Date().toISOString() };
  const rows = await db
    .update(characters)
    .set({ data, updatedAt: new Date() })
    .where(
      and(
        eq(characters.id, character.id as CharacterId),
        eq(characters.ownerId, uid),
        eq(characters.worldId, character.worldId),
        canPlay(uid, sql`${characters.worldId}`),
      ),
    )
    .returning({ id: characters.id });
  return rows.length > 0;
}

// ── Chat ────────────────────────────────────────────────────────────────────────────

export interface ChatRow {
  id: string;
  speaker: string;
  text: string;
  at: string;
}

/** Who may see a place copy's chat: anyone who can play, unless it's someone's private copy. */
function instanceVisible(uid: string, instance: string): boolean {
  return instance === "" || instance === uid;
}

export async function postChat(
  db: Db,
  actor: Actor,
  line: {
    id: string;
    worldId: string;
    placeKey: string;
    instance: string;
    speaker: string;
    text: string;
  },
): Promise<ChatRow | null> {
  const uid = uidOf(actor);
  if (uid === null || !instanceVisible(uid, line.instance)) return null;
  const now = new Date();
  const rows = await db.execute<{ id: string }>(sql`
    insert into ${chatMessages} (id, world_id, place_key, instance, author_id, speaker, text, created_at)
    select ${line.id}, ${line.worldId}, ${line.placeKey}, ${line.instance}, ${uid}, ${line.speaker}, ${line.text}, ${now.toISOString()}::timestamptz
    where ${canPlay(uid, sql`${line.worldId}`)}
    returning id`);
  return rows.length > 0
    ? { id: line.id, speaker: line.speaker, text: line.text, at: now.toISOString() }
    : null;
}

/** The latest lines in a place, oldest first. */
export async function recentChat(
  db: Db,
  actor: Actor,
  where: { worldId: string; placeKey: string; instance: string },
  limit = 30,
): Promise<ChatRow[]> {
  const uid = uidOf(actor);
  if (uid === null || !instanceVisible(uid, where.instance)) return [];
  const rows = await db
    .select({
      id: chatMessages.id,
      speaker: chatMessages.speaker,
      text: chatMessages.text,
      at: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.worldId, where.worldId),
        eq(chatMessages.placeKey, where.placeKey),
        eq(chatMessages.instance, where.instance),
        canPlay(uid, sql`${chatMessages.worldId}`),
      ),
    )
    .orderBy(desc(chatMessages.createdAt))
    .limit(Math.min(limit, 100));
  return rows.reverse().map((r) => ({ ...r, at: r.at.toISOString() }));
}

// ── For trusted jobs only (see system.ts) ───────────────────────────────────────────

/** The world as the builder needs it. Never from an HTTP handler. */
export async function systemGetWorld(db: Db, id: string) {
  const [row] = await db.select().from(worlds).where(eq(worlds.id, id)).limit(1);
  return row ?? null;
}

export async function systemSetWorld(
  db: Db,
  id: string,
  patch: { city?: ArtifactHash; status?: World["status"]; currency?: string; name?: string },
): Promise<void> {
  await db
    .update(worlds)
    .set({
      ...patch,
      updatedAt: new Date(),
      // Only the first time: later passes finish the same city, and that's not how long it took.
      ...(patch.status === "ready" ? { readyAt: sql`coalesce(${worlds.readyAt}, now())` } : {}),
    })
    .where(eq(worlds.id, id));
}

/** A line for whoever's waiting. It's only ever a note, so it can't fail a build. */
export async function systemSetBuildNote(db: Db, id: string, buildNote: string): Promise<void> {
  await db
    .update(worlds)
    .set({ buildNote })
    .where(eq(worlds.id, id))
    .catch(() => undefined);
}

/** A build that crashed: fail the world only if it never opened, in the same statement. */
export async function systemFailIfBuilding(db: Db, id: string): Promise<void> {
  await db
    .update(worlds)
    .set({ status: "failed", updatedAt: new Date() })
    .where(and(eq(worlds.id, id), eq(worlds.status, "building")));
}

/** Pin a built place into a world under its city key (replacing an older build). */
export async function systemPinPlace(db: Db, worldId: string, place: WorldPlace): Promise<void> {
  await db
    .insert(worldPlaces)
    .values({ worldId, ...place })
    .onConflictDoUpdate({
      target: [worldPlaces.worldId, worldPlaces.key],
      set: { placeId: place.placeId, revision: place.revision },
    });
}

export async function systemPinnedKeys(db: Db, worldId: string, keys: string[]) {
  if (keys.length === 0) return [];
  const rows = await db
    .select({ key: worldPlaces.key })
    .from(worldPlaces)
    .where(and(eq(worldPlaces.worldId, worldId), inArray(worldPlaces.key, keys)));
  return rows.map((r) => r.key);
}

/** A place for a city, owned by the city's owner; private (world members read it). Idempotent. */
export async function systemEnsurePlace(
  db: Db,
  place: { id: string; ownerId: string; name: string },
): Promise<void> {
  await db
    .insert(places)
    .values({ ...place, visibility: "private" })
    .onConflictDoNothing();
}

/**
 * Record that a world references artifacts (its city spec, what its places are made of), so its
 * members may read them.
 */
export async function systemLinkWorldArtifacts(
  db: Db,
  worldId: string,
  hashes: readonly ArtifactHash[],
): Promise<void> {
  if (hashes.length === 0) return;
  await db
    .insert(artifactRefs)
    .values(hashes.map((hash) => ({ hash, kind: "world" as const, recordId: worldId })))
    .onConflictDoNothing();
}

/** A world's pinned place with its revision, for jobs. Never from an HTTP handler. */
export async function systemGetPinnedPlace(db: Db, worldId: string, key: string) {
  const [row] = await db
    .select({
      placeId: worldPlaces.placeId,
      revision: worldPlaces.revision,
      scene: placeRevisions.scene,
      base: placeRevisions.base,
      spec: placeRevisions.worldSpec,
      edits: placeRevisions.edits,
    })
    .from(worldPlaces)
    .innerJoin(placeRevisions, eq(placeRevisions.hash, worldPlaces.revision))
    .where(and(eq(worldPlaces.worldId, worldId), eq(worldPlaces.key, key)))
    .limit(1);
  return row ?? null;
}
