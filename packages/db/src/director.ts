/**
 * The director's own state, and what it needs to read and write a world (trusted jobs only:
 * never from an HTTP handler). Its notes are model-only: no actor-scoped read returns them,
 * and nothing links them to the world's readable artifacts.
 *
 * A world's city spec is written by more than one job (building, dressing, the director), so
 * the director swaps it in only if it's still the one it read: a turn that raced another
 * write is dropped, never merged over it.
 */
import type { ArtifactHash } from "@aye/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { characters, personMemories, worldDirectors, worlds } from "./schema.ts";

export interface DirectorState {
  memory: string;
  /** The city minute (absolute) of its last turn, or -1. */
  lastMinute: number;
  /** Model calls made on `day` (a UTC date), for a daily budget. */
  day: string;
  calls: number;
}

export async function systemGetDirector(db: Db, worldId: string): Promise<DirectorState> {
  const [row] = await db
    .select()
    .from(worldDirectors)
    .where(eq(worldDirectors.worldId, worldId))
    .limit(1);
  return row
    ? { memory: row.memory, lastMinute: row.lastMinute, day: row.day, calls: row.calls }
    : { memory: "", lastMinute: -1, day: "", calls: 0 };
}

export async function systemSaveDirector(
  db: Db,
  worldId: string,
  state: DirectorState,
): Promise<void> {
  await db
    .insert(worldDirectors)
    .values({ worldId, ...state, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: worldDirectors.worldId,
      set: { ...state, updatedAt: new Date() },
    });
}

/** Set a world's city to `next` only if it is still `prev`. True if it was swapped. */
export async function systemSwapWorldCity(
  db: Db,
  worldId: string,
  prev: ArtifactHash,
  next: ArtifactHash,
): Promise<boolean> {
  const rows = await db
    .update(worlds)
    .set({ city: next, updatedAt: new Date() })
    .where(and(eq(worlds.id, worldId), eq(worlds.city, prev)))
    .returning({ id: worlds.id });
  return rows.length > 0;
}

/** Worlds ready to be lived in (the director's to look after), with their clocks. */
export async function systemReadyWorlds(db: Db) {
  return db
    .select({
      id: worlds.id,
      createdAt: worlds.createdAt,
      settings: worlds.settings,
      city: worlds.city,
    })
    .from(worlds)
    .where(eq(worlds.status, "ready"));
}

/** Players in each place of a world (not on the way somewhere), by the place's city key. */
export async function systemPlayersByPlace(db: Db, worldId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({
      place: sql<string | null>`${characters.data}->>'place'`,
      n: sql<number>`count(*)::int`,
    })
    .from(characters)
    .where(and(eq(characters.worldId, worldId), isNull(sql`${characters.data}->'transit'->>'to'`)))
    .groupBy(sql`${characters.data}->>'place'`);
  const out = new Map<string, number>();
  for (const r of rows) if (r.place) out.set(r.place, r.n);
  return out;
}

/** What the people of a place remember (their own notes), by person key. */
export async function systemPersonMemories(
  db: Db,
  worldId: string,
  placeKey: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({ person: personMemories.personKey, memory: personMemories.memory })
    .from(personMemories)
    .where(and(eq(personMemories.worldId, worldId), eq(personMemories.placeKey, placeKey)));
  return new Map(rows.map((r) => [r.person, r.memory]));
}

export async function systemRememberPerson(
  db: Db,
  worldId: string,
  placeKey: string,
  personKey: string,
  memory: string,
): Promise<void> {
  await db
    .insert(personMemories)
    .values({ worldId, placeKey, personKey, memory })
    .onConflictDoUpdate({
      target: [personMemories.worldId, personMemories.placeKey, personMemories.personKey],
      set: { memory, updatedAt: new Date() },
    });
}
