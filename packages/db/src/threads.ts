/**
 * Threads (see `Thread` in @aye/schema): a player's own, read and advanced only by them (the
 * realm does it on their behalf, as them). Trusted jobs add them (their world's director), and a
 * new character's aim is added once, as that player. Every rule is in the SQL predicate; another
 * player's thread is simply not there.
 */
import { Character, THREAD_BOUNDS, type Thread, Thread as ThreadSchema } from "@aye/schema";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { type Actor, isUser } from "./policy.ts";
import { characters, threads, worldMembers } from "./schema.ts";

const uidOf = (actor: Actor): string | null => (isUser(actor) ? actor.userId : null);

/** Your threads in a world (open first, then the latest), if you play in it. */
export async function listMyThreads(db: Db, actor: Actor, worldId: string): Promise<Thread[]> {
  const uid = uidOf(actor);
  if (uid === null) return [];
  const rows = await db
    .select({ data: threads.data })
    .from(threads)
    .where(
      and(
        eq(threads.worldId, worldId),
        eq(threads.userId, uid),
        sql`exists (select 1 from ${worldMembers} m where m.world_id = ${threads.worldId} and m.user_id = ${uid})`,
      ),
    )
    .orderBy(sql`${threads.state} = 'open' desc`, desc(threads.createdAt))
    .limit(20);
  return rows.map((r) => r.data);
}

/** Save how far one of your threads has come. Someone else's: false. */
export async function saveMyThread(
  db: Db,
  actor: Actor,
  worldId: string,
  thread: Thread,
): Promise<boolean> {
  const uid = uidOf(actor);
  if (uid === null) return false;
  const data = ThreadSchema.parse(thread);
  const rows = await db
    .update(threads)
    .set({ data, state: data.state, updatedAt: new Date() })
    .where(and(eq(threads.id, data.id), eq(threads.worldId, worldId), eq(threads.userId, uid)))
    .returning({ id: threads.id });
  return rows.length > 0;
}

/** Start a player off with their own thread (what they're working towards), once. */
export async function addMyThread(
  db: Db,
  actor: Actor,
  worldId: string,
  thread: Thread,
): Promise<boolean> {
  const uid = uidOf(actor);
  if (uid === null) return false;
  const data = ThreadSchema.parse(thread);
  const rows = await db
    .insert(threads)
    .values({ id: data.id, worldId, userId: uid, data, state: data.state })
    .onConflictDoNothing()
    .returning({ id: threads.id });
  return rows.length > 0;
}

// ── For trusted jobs only ──────────────────────────────────────────────────────────────

/** Give a player a thread, unless they already carry as many as anyone should. */
export async function systemAddThread(
  db: Db,
  worldId: string,
  userId: string,
  thread: Thread,
): Promise<boolean> {
  const data = ThreadSchema.parse(thread);
  const [open] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(threads)
    .where(
      and(
        eq(threads.worldId, worldId),
        eq(threads.userId, userId),
        eq(threads.state, "open"),
        // What they're working towards isn't one of the things on their plate today.
        sql`${threads.data}->>'aim' is null`,
      ),
    );
  if ((open?.n ?? 0) >= THREAD_BOUNDS.open) return false;
  await db
    .insert(threads)
    .values({ id: data.id, worldId, userId, data, state: data.state })
    .onConflictDoNothing();
  return true;
}

/** Open threads of a world whose time ran out by city minute `minute` are missed. */
export async function systemExpireThreads(db: Db, worldId: string, minute: number) {
  await db
    .update(threads)
    .set({
      state: "missed",
      data: sql`jsonb_set(${threads.data}, '{state}', '"missed"')`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(threads.worldId, worldId),
        eq(threads.state, "open"),
        sql`(${threads.data}->>'due')::int + ${THREAD_BOUNDS.graceMinutes} <= ${Math.floor(minute)}`,
      ),
    );
}

/** How many of a player's latest threads the director is reminded of. */
const RECENT_THREADS = 4;
/** The most threads looked through for them, across a world's players. */
const RECENT_THREADS_SCANNED = 200;

/** The players of a world who have played since `since`, with what they're carrying. */
export async function systemActivePlayers(db: Db, worldId: string, since: Date) {
  const rows = await db
    .select({ userId: characters.ownerId, data: characters.data })
    .from(characters)
    .where(and(eq(characters.worldId, worldId), gt(characters.updatedAt, since)));
  const open = await db
    .select({ userId: threads.userId, data: threads.data })
    .from(threads)
    .where(and(eq(threads.worldId, worldId), eq(threads.state, "open")));
  // What each has been given lately, whatever came of it, newest first.
  const lately = await db
    .select({ userId: threads.userId, data: threads.data })
    .from(threads)
    .where(eq(threads.worldId, worldId))
    .orderBy(desc(threads.createdAt))
    .limit(RECENT_THREADS_SCANNED);
  // A row that no longer reads is one player's problem, not the whole city's turn.
  return rows.flatMap((r) => {
    const character = Character.safeParse(r.data);
    if (!character.success) return [];
    return [
      {
        userId: r.userId,
        character: character.data,
        open: open.filter((t) => t.userId === r.userId).map((t) => t.data),
        recent: lately
          .filter((t) => t.userId === r.userId)
          .slice(0, RECENT_THREADS)
          .map((t) => t.data),
      },
    ];
  });
}

/** A player's character in a world, for a trusted job they've already been authorised for. */
export async function systemGetCharacter(db: Db, worldId: string, userId: string) {
  const [row] = await db
    .select({ data: characters.data })
    .from(characters)
    .where(and(eq(characters.worldId, worldId), eq(characters.ownerId, userId)))
    .limit(1);
  return row ? Character.parse(row.data) : null;
}
