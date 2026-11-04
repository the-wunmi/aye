/**
 * Accounts and sessions: how an HTTP request or a WebSocket becomes an Actor.
 *
 * These run before there is an actor, so they are not actor-scoped; they are the only code
 * that turns credentials into one. The rules:
 * - Passwords are hashed with scrypt (memory-hard; OWASP's N=2^15, r=8, p=3), salted per user,
 *   stored self-describing so parameters can be raised later. Never logged, never returned.
 * - Unknown handles still cost a full hash, so timing doesn't reveal who has an account.
 * - Session cookies carry 32 random bytes; only their SHA-256 is stored, so a database leak
 *   can't be replayed as sessions. Sessions expire and can be revoked.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import type { UserId } from "@aye/schema";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./client.ts";
import type { Actor } from "./policy.ts";
import { sessions, users } from "./schema.ts";

export const Handle = z
  .string()
  .trim()
  .min(3)
  .max(20)
  .regex(/^[A-Za-z0-9_]+$/, "letters, numbers and _ only");
export const Password = z.string().min(10, "at least 10 characters").max(200);

export const SESSION_DAYS = 30;
const SCRYPT = { N: 2 ** 15, r: 8, p: 3, keyLen: 32 } as const;
const MAXMEM = 64 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, p: typeof SCRYPT): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(
      password.normalize("NFKC"),
      salt,
      p.keyLen,
      { N: p.N, r: p.r, p: p.p, maxmem: MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Constant-time check against a stored hash. Malformed hashes never match. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  // Only accept parameters we would set: a tampered row can't make a hash cost the earth.
  if (N !== SCRYPT.N || r !== SCRYPT.r || p !== SCRYPT.p) return false;
  const salt = Buffer.from(parts[4] as string, "base64url");
  const expected = Buffer.from(parts[5] as string, "base64url");
  if (salt.length !== 16 || expected.length !== SCRYPT.keyLen) return false;
  const actual = await scrypt(password, salt, SCRYPT);
  return timingSafeEqual(actual, expected);
}

/** A hash nobody's password matches, spent on unknown handles to keep timing flat. */
let decoy: Promise<string> | null = null;

export type RegisterResult = { ok: true; userId: UserId } | { ok: false; reason: "taken" };

export async function registerUser(
  db: Db,
  input: { id: UserId; handle: string; password: string },
): Promise<RegisterResult> {
  const handle = Handle.parse(input.handle);
  const passwordHash = await hashPassword(Password.parse(input.password));
  const rows = await db
    .insert(users)
    .values({ id: input.id, handle, passwordHash })
    .onConflictDoNothing()
    .returning({ id: users.id });
  return rows[0] ? { ok: true, userId: rows[0].id as UserId } : { ok: false, reason: "taken" };
}

/**
 * Someone playing without signing up: a real account in every way, except nobody can log in to it,
 * so it lasts only as long as its session unless they claim it.
 */
export async function createGuest(db: Db, id: UserId): Promise<{ handle: string }> {
  const handle = `guest_${randomBytes(6).toString("hex")}`;
  await db.insert(users).values({ id, handle, passwordHash: null });
  return { handle };
}

/** No password yet means a guest. */
export async function isGuest(db: Db, userId: UserId): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.passwordHash)))
    .limit(1);
  return Boolean(row);
}

/** A guest takes a name and password, keeping all they have. Only ever their own, and only once. */
export async function claimGuest(
  db: Db,
  userId: UserId,
  input: { handle: string; password: string },
): Promise<"ok" | "taken" | "not_a_guest"> {
  const handle = Handle.parse(input.handle);
  const passwordHash = await hashPassword(Password.parse(input.password));
  const [clash] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(sql`lower(${users.handle})`, handle.toLowerCase()), ne(users.id, userId)))
    .limit(1);
  if (clash) return "taken";
  try {
    const rows = await db
      .update(users)
      .set({ handle, passwordHash })
      .where(and(eq(users.id, userId), isNull(users.passwordHash)))
      .returning({ id: users.id });
    return rows[0] ? "ok" : "not_a_guest";
  } catch {
    // Someone took the name between the check and now: the unique index said no.
    return "taken";
  }
}

/** The user for a handle and password, or null. Same cost whether or not the handle exists. */
export async function checkLogin(
  db: Db,
  input: { handle: string; password: string },
): Promise<{ userId: UserId; handle: string } | null> {
  const handle = Handle.safeParse(input.handle);
  const password = Password.safeParse(input.password);
  const [row] = handle.success
    ? await db
        .select({ id: users.id, handle: users.handle, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(sql`lower(${users.handle})`, handle.data.toLowerCase()))
        .limit(1)
    : [];
  decoy ??= hashPassword(randomBytes(24).toString("base64url"));
  const stored = row?.passwordHash ?? (await decoy);
  const ok = await verifyPassword(password.success ? password.data : "x".repeat(10), stored);
  return ok && row?.passwordHash && password.success
    ? { userId: row.id as UserId, handle: row.handle }
    : null;
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** A new session; the returned token goes in an HttpOnly cookie and nowhere else. */
export async function createSession(db: Db, userId: UserId): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({
    tokenHash: tokenHash(token),
    userId,
    expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000),
  });
  return token;
}

const TokenShape = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** The actor a session token stands for; anonymous if it is malformed, unknown or expired. */
export async function resolveSession(
  db: Db,
  token: string | undefined,
): Promise<{ actor: Actor; handle: string | null }> {
  if (!token || !TokenShape.safeParse(token).success) {
    return { actor: { kind: "anonymous" }, handle: null };
  }
  const [row] = await db
    .select({ userId: sessions.userId, handle: users.handle })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row
    ? { actor: { kind: "user", userId: row.userId as UserId }, handle: row.handle }
    : { actor: { kind: "anonymous" }, handle: null };
}

export async function revokeSession(db: Db, token: string | undefined): Promise<void> {
  if (!token || !TokenShape.safeParse(token).success) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash(token)));
}
