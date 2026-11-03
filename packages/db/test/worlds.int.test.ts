/**
 * Accounts, worlds, characters and chat against real Postgres: the cross-user cases above all.
 * Skipped when DATABASE_URL is unset.
 */
import { fileURLToPath } from "node:url";
import { hashJson } from "@aye/artifacts";
import type { ArtifactHash, Character, CharacterId, PlaceId, UserId, WorldId } from "@aye/schema";
import { sampleSettings, sampleSpec } from "@aye/schema/fixtures";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Actor,
  canReadArtifact,
  checkLogin,
  connect,
  createCharacter,
  createPlace,
  createSession,
  createWorld,
  type Db,
  deleteWorld,
  getMyCharacter,
  getWorld,
  hashPassword,
  joinWorld,
  listMyThreads,
  listWorlds,
  postChat,
  recentChat,
  registerUser,
  resolveSession,
  revokeSession,
  saveCharacter,
  saveMyThread,
  setWorldVisibility,
  systemActivePlayers,
  systemAddThread,
  systemLinkWorldArtifacts,
  systemPinPlace,
  systemRecordArtifacts,
  systemSetWorld,
  verifyPassword,
} from "../src/index.ts";
import { characters } from "../src/schema.ts";

const url = process.env["DATABASE_URL"];
const dbName = `aye_wtest_${process.pid}_${Date.now()}`;
const user = (id: string): Actor => ({ kind: "user", userId: id as UserId });
const anon: Actor = { kind: "anonymous" };

describe("passwords", () => {
  // scrypt is slow on purpose; under a busy machine a few hashes can take seconds.
  it("hash, verify, and refuse tampered or foreign hashes", { timeout: 30_000 }, async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored.startsWith("scrypt$32768$8$3$")).toBe(true);
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("correct horse batterY", stored)).toBe(false);
    // Raised work factors from a tampered row are refused, not computed.
    expect(await verifyPassword("x", stored.replace("$32768$", "$1073741824$"))).toBe(false);
    expect(await verifyPassword("x", "md5$abc")).toBe(false);
  });
});

describe.skipIf(!url)("accounts, worlds, characters and chat", () => {
  let admin: ReturnType<typeof postgres>;
  let conn: ReturnType<typeof connect>;
  let db: Db;
  const alice = user("usr_alice");
  const bob = user("usr_bob");
  const carol = user("usr_carol");

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${dbName}`);
    const testUrl = new URL(url as string);
    testUrl.pathname = `/${dbName}`;
    conn = connect(testUrl.toString(), { max: 4 });
    db = conn.db;
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
    for (const [id, handle] of [
      ["usr_alice", "alice"],
      ["usr_bob", "bob"],
      ["usr_carol", "carol"],
    ] as const) {
      expect(
        await registerUser(db, { id: id as UserId, handle, password: `${handle} password!` }),
      ).toEqual({
        ok: true,
        userId: id,
      });
    }
  }, 60_000);

  afterAll(async () => {
    await conn?.close();
    await admin?.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
  });

  it("handles are unique regardless of case", async () => {
    expect(
      await registerUser(db, {
        id: "usr_alice2" as UserId,
        handle: "ALICE",
        password: "another password",
      }),
    ).toEqual({ ok: false, reason: "taken" });
  });

  it("logs in with the right password only, by handle in any case", async () => {
    expect(await checkLogin(db, { handle: "Alice", password: "alice password!" })).toMatchObject({
      userId: "usr_alice",
    });
    expect(await checkLogin(db, { handle: "alice", password: "bob password!" })).toBeNull();
    expect(await checkLogin(db, { handle: "nobody", password: "alice password!" })).toBeNull();
    expect(await checkLogin(db, { handle: "a'; drop table users;--", password: "x" })).toBeNull();
  });

  it("sessions resolve to their user until revoked; junk tokens are anonymous", async () => {
    const token = await createSession(db, "usr_alice" as UserId);
    expect((await resolveSession(db, token)).actor).toEqual(alice);
    const forged = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect((await resolveSession(db, forged)).actor).toEqual(anon);
    expect((await resolveSession(db, "not-a-token")).actor).toEqual(anon);
    expect((await resolveSession(db, undefined)).actor).toEqual(anon);
    await revokeSession(db, token);
    expect((await resolveSession(db, token)).actor).toEqual(anon);
  });

  const world = "wld_city" as WorldId;

  it("a building world is only visible to its owner", async () => {
    await createWorld(db, alice, {
      id: world,
      name: "Testville",
      description: "a small town",
      currency: "NGN",
      visibility: "public",
      settings: { ...sampleSettings, ticksPerRealSecond: 10 },
    });
    expect(await getWorld(db, alice, world)).toMatchObject({ role: "owner", status: "building" });
    expect(await getWorld(db, bob, world)).toBeNull();
    expect(await getWorld(db, anon, world)).toBeNull();
    expect(await joinWorld(db, bob, world)).toBeNull();
    expect((await listWorlds(db, bob)).map((w) => w.id)).not.toContain(world);
  });

  it("once public and ready, others can see it and join as players", async () => {
    await systemSetWorld(db, world, { status: "ready", city: hashJson("city") as ArtifactHash });
    const home = await createPlace(db, alice, {
      id: "plc_home" as PlaceId,
      name: "Home",
      visibility: "private",
      geo: null,
    });
    await systemPinPlace(db, world, {
      key: "home",
      placeId: home.id,
      revision: hashJson("rev") as ArtifactHash,
    });
    expect((await listWorlds(db, bob)).map((w) => w.id)).toContain(world);
    expect(await joinWorld(db, bob, world)).toBe("player");
    expect(await joinWorld(db, bob, world)).toBe("player");
    expect((await getWorld(db, bob, world))?.places.map((p) => p.key)).toEqual(["home"]);
    // Only the owner changes visibility.
    expect(await setWorldVisibility(db, bob, world, "private")).toBe(false);
  });

  const character = (owner: string, id: string): Omit<Character, "ownerId" | "updatedAt"> => ({
    id: id as CharacterId,
    worldId: world,
    vehicle: null,
    billed: { day: -1, owes: 0 },
    home: null,
    person: { ...(sampleSpec.people[0] as Character["person"]), key: `p_${owner}`, name: owner },
    start: "fresh",
    place: null,
    transit: null,
  });

  it("characters: one per player per world, only for players, only readable by their owner", async () => {
    expect(await createCharacter(db, bob, character("bob", "chr_bob"))).not.toBeNull();
    expect(await createCharacter(db, bob, character("bob", "chr_bob2"))).toBeNull();
    // Carol hasn't joined: no character for her.
    expect(await createCharacter(db, carol, character("carol", "chr_carol"))).toBeNull();
    expect(await createCharacter(db, anon, character("anon", "chr_anon"))).toBeNull();
    expect((await getMyCharacter(db, bob, world))?.id).toBe("chr_bob");
    expect(await getMyCharacter(db, alice, world)).toBeNull();
    expect(await getMyCharacter(db, carol, world)).toBeNull();
  });

  it("a character saved before a field existed reads back with its default", async () => {
    const mine = (await getMyCharacter(db, bob, world)) as Character;
    const { billed: _billed, home: _home, ...old } = mine;
    await db
      .update(characters)
      .set({ data: old as Character, updatedAt: new Date() })
      .where(eq(characters.id, mine.id));
    expect((await getMyCharacter(db, bob, world))?.billed).toEqual({ day: -1, owes: 0 });
    const active = await systemActivePlayers(db, world, new Date(Date.now() - 60_000));
    expect(active.find((a) => a.character.id === mine.id)?.character.billed.owes).toBe(0);
    await saveCharacter(db, bob, mine);
  });

  it("only the owner saves a character; nobody can save someone else's", async () => {
    const mine = (await getMyCharacter(db, bob, world)) as Character;
    expect(await saveCharacter(db, bob, { ...mine, place: "home" })).toBe(true);
    expect((await getMyCharacter(db, bob, world))?.place).toBe("home");
    // Alice can't save Bob's, even claiming to own it.
    expect(await saveCharacter(db, alice, { ...mine, ownerId: "usr_alice" as UserId })).toBe(false);
    expect(await saveCharacter(db, alice, mine)).toBe(false);
    expect((await getMyCharacter(db, bob, world))?.place).toBe("home");
  });

  it("chat: players talk in shared places; private copies are their owner's alone", async () => {
    const room = { worldId: world, placeKey: "spot", instance: "" };
    expect(
      await postChat(db, bob, { id: "msg_1", ...room, speaker: "Bob", text: "hello" }),
    ).not.toBeNull();
    expect(
      await postChat(db, carol, { id: "msg_2", ...room, speaker: "Carol", text: "hi" }),
    ).toBeNull();
    expect((await recentChat(db, alice, room)).map((m) => m.text)).toEqual(["hello"]);
    expect(await recentChat(db, carol, room)).toEqual([]);

    const bobsHome = { worldId: world, placeKey: "home", instance: "usr_bob" };
    expect(
      await postChat(db, bob, { id: "msg_3", ...bobsHome, speaker: "Bob", text: "home" }),
    ).not.toBeNull();
    expect(
      await postChat(db, alice, { id: "msg_4", ...bobsHome, speaker: "A", text: "x" }),
    ).toBeNull();
    expect(await recentChat(db, alice, bobsHome)).toEqual([]);
    expect((await recentChat(db, bob, bobsHome)).map((m) => m.text)).toEqual(["home"]);
  });

  it("a world is deleted only by its owner, and then grants nothing", async () => {
    const doomed = "wld_doomed" as WorldId;
    await createWorld(db, alice, {
      id: doomed,
      name: "Doomed",
      description: "",
      currency: "NGN",
      visibility: "public",
      settings: sampleSettings,
    });
    const city = hashJson({ doomed: true }) as ArtifactHash;
    await systemRecordArtifacts(db, [{ hash: city, mediaType: "application/json", bytes: 2 }]);
    await systemLinkWorldArtifacts(db, doomed, [city]);
    await systemSetWorld(db, doomed, { city, status: "ready" });
    expect(await joinWorld(db, bob, doomed)).not.toBeNull();
    expect(await canReadArtifact(db, bob, city)).toBe(true);
    // A player, a stranger, or nobody can't; a world that isn't there is the same "no".
    expect(await deleteWorld(db, bob, doomed)).toBe(false);
    expect(await deleteWorld(db, carol, doomed)).toBe(false);
    expect(await deleteWorld(db, { kind: "anonymous" }, doomed)).toBe(false);
    expect(await deleteWorld(db, alice, "wld_nothere")).toBe(false);
    expect(await getWorld(db, bob, doomed)).not.toBeNull();
    // Its owner can, and then it's gone for everyone, with what it granted.
    expect(await deleteWorld(db, alice, doomed)).toBe(true);
    expect(await getWorld(db, alice, doomed)).toBeNull();
    expect(await canReadArtifact(db, bob, city)).toBe(false);
  });

  it("threads: yours alone to read and advance; only trusted jobs add them, a few at a time", async () => {
    const t = (n: number) => ({
      id: `thr_rent${n}xxxxxx`,
      title: "Rent is due",
      about: "Find the money by Friday.",
      icon: "\u{1F3E0}",
      steps: [{ check: "have_money" as const, atLeast: 50_000, text: "Have GHS 500" }],
      progress: 0,
      reward: 10_000,
      from: 0,
      due: 3000,
      state: "open" as const,
    });
    const bobId = "usr_bob";
    expect(await systemAddThread(db, world, bobId, t(1))).toBe(true);
    expect((await listMyThreads(db, bob, world)).map((x) => x.id)).toEqual(["thr_rent1xxxxxx"]);
    // Not Alice's to read or move, even knowing its id.
    expect(await listMyThreads(db, alice, world)).toEqual([]);
    expect(await saveMyThread(db, alice, world, { ...t(1), progress: 1, state: "done" })).toBe(
      false,
    );
    expect(await saveMyThread(db, { kind: "anonymous" }, world, t(1))).toBe(false);
    expect(await saveMyThread(db, bob, world, { ...t(1), progress: 1, state: "done" })).toBe(true);
    expect((await listMyThreads(db, bob, world))[0]?.state).toBe("done");
    // At most three open at once.
    for (const n of [2, 3, 4]) await systemAddThread(db, world, bobId, t(n));
    expect(await systemAddThread(db, world, bobId, t(5))).toBe(false);
    const open = (await listMyThreads(db, bob, world)).filter((x) => x.state === "open");
    expect(open).toHaveLength(3);
  });
});
