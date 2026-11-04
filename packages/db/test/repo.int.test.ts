/**
 * Integration tests against real Postgres + PostGIS. Each run creates a throwaway database,
 * applies the real migrations, and drops it afterwards. Skipped when DATABASE_URL is unset.
 */
import { fileURLToPath } from "node:url";
import { hashJson } from "@aye/artifacts";
import type { ArtifactHash, PlaceId, PlaceRevision, UserId } from "@aye/schema";
import { sampleFlat, sampleSettings } from "@aye/schema/fixtures";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Actor,
  appendCommand,
  approveWorld,
  ConflictError,
  canReadArtifact,
  commitRevision,
  connect,
  createPlace,
  type Db,
  getCapture,
  getPlace,
  listPublicPlacesNear,
  systemCommitRevision,
  systemRecordArtifacts,
  tables,
  updatePlace,
} from "../src/index.ts";

const url = process.env["DATABASE_URL"];
const dbName = `aye_test_${process.pid}_${Date.now()}`;
const alice: Actor = { kind: "user", userId: "usr_alice" as UserId };
const bob: Actor = { kind: "user", userId: "usr_bob" as UserId };
const anon: Actor = { kind: "anonymous" };
const h = (s: string) => hashJson(s) as ArtifactHash;

describe.skipIf(!url)("repositories enforce object-level access", () => {
  let admin: ReturnType<typeof postgres>;
  let conn: ReturnType<typeof connect>;
  let db: Db;

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${dbName}`);
    const testUrl = new URL(url as string);
    testUrl.pathname = `/${dbName}`;
    conn = connect(testUrl.toString(), { max: 2 });
    db = conn.db;
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
    await db.insert(tables.users).values([
      { id: "usr_alice", handle: "alice" },
      { id: "usr_bob", handle: "bob" },
      { id: "usr_carol", handle: "carol" },
    ]);
  }, 60_000);

  afterAll(async () => {
    await conn?.close();
    await admin?.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
  });

  it("private places are invisible to others, and look exactly like missing ones", async () => {
    await createPlace(db, alice, {
      id: "plc_alicehome" as PlaceId,
      name: "Home",
      visibility: "private",
      geo: null,
    });
    expect(await getPlace(db, alice, "plc_alicehome")).not.toBeNull();
    expect(await getPlace(db, bob, "plc_alicehome")).toBeNull();
    expect(await getPlace(db, anon, "plc_alicehome")).toBeNull();
    expect(await getPlace(db, bob, "plc_doesnotexist")).toBeNull();
  });

  it("non-owners cannot modify, even public places", async () => {
    await createPlace(db, alice, {
      id: "plc_alicepub" as PlaceId,
      name: "Street",
      visibility: "public",
      geo: null,
    });
    expect(await updatePlace(db, bob, "plc_alicepub", { name: "pwned" })).toBeNull();
    expect((await getPlace(db, bob, "plc_alicepub"))?.name).toBe("Street");
    expect((await updatePlace(db, alice, "plc_alicepub", { name: "Our street" }))?.name).toBe(
      "Our street",
    );
  });

  it("world membership grants read access to the places in that world", async () => {
    await db.insert(tables.worlds).values({
      id: "wld_shared",
      ownerId: "usr_alice",
      name: "Shared",
      currency: "NGN",
      settings: sampleSettings,
    });
    await db.insert(tables.worldMembers).values([
      { worldId: "wld_shared", userId: "usr_alice", role: "owner" },
      { worldId: "wld_shared", userId: "usr_bob", role: "viewer" },
    ]);
    await db
      .insert(tables.worldPlaces)
      .values({ worldId: "wld_shared", key: "home", placeId: "plc_alicehome", revision: h("rev") });
    expect(await getPlace(db, bob, "plc_alicehome")).not.toBeNull();
    expect(
      await getPlace(db, { kind: "user", userId: "usr_carol" as UserId }, "plc_alicehome"),
    ).toBeNull();
  });

  it("viewers cannot append commands; players and owners can", async () => {
    expect(
      await appendCommand(db, bob, "wld_shared", 10, { type: "cancel", agent: "chr_x" }),
    ).toBeNull();
    expect(
      await appendCommand(db, alice, "wld_shared", 10, { type: "cancel", agent: "chr_x" }),
    ).toBe(1);
    expect(
      await appendCommand(db, alice, "wld_shared", 11, { type: "cancel", agent: "chr_x" }),
    ).toBe(2);
    expect(
      await appendCommand(db, anon, "wld_shared", 12, { type: "cancel", agent: "chr_x" }),
    ).toBeNull();
  });

  it("raw captures and their video are owner-only, even when the hash is known", async () => {
    const video = h("alice-video");
    await db.insert(tables.captures).values({
      id: "cap_alice1",
      placeId: "plc_alicehome",
      ownerId: "usr_alice",
      video,
      videoBytes: 10,
      mediaType: "video/mp4",
      durationMs: 1000,
    });
    await db
      .insert(tables.artifactRefs)
      .values({ hash: video, kind: "capture", recordId: "cap_alice1" });
    expect(await getCapture(db, alice, "cap_alice1")).not.toBeNull();
    expect(await getCapture(db, bob, "cap_alice1")).toBeNull();
    expect(await canReadArtifact(db, alice, video)).toBe(true);
    expect(await canReadArtifact(db, bob, video)).toBe(false);
    expect(await canReadArtifact(db, anon, video)).toBe(false);
    expect(await canReadArtifact(db, alice, h("unreferenced"))).toBe(false);
  });

  it("revisions: owner-only commits, optimistic concurrency, artifacts readable via the place", async () => {
    // A real scene: first revisions come from the compile worker via the trusted path.
    const base = { hash: hashJson(sampleFlat), mediaType: "application/json", bytes: 100 };
    const rev: PlaceRevision = {
      placeId: "plc_alicepub" as PlaceId,
      parent: null,
      base,
      edits: [],
      scene: base,
      world: null,
      authorId: "usr_alice" as UserId,
      message: "first",
      createdAt: new Date().toISOString(),
    };
    const revHash = hashJson(rev);
    expect(
      await commitRevision(db, { kind: "user", userId: "usr_bob" as UserId }, revHash, {
        ...rev,
        authorId: "usr_bob" as UserId,
      }),
    ).toBe(false);
    // The user path refuses: nothing links this scene to Alice yet.
    expect(await commitRevision(db, alice, revHash, rev)).toBe(false);
    expect(await systemCommitRevision(db, "usr_alice" as UserId, revHash, rev, sampleFlat)).toBe(
      true,
    );
    // Stale parent: someone else moved head since.
    await expect(
      commitRevision(db, alice, hashJson({ ...rev, message: "stale" }), {
        ...rev,
        message: "stale",
      }),
    ).rejects.toThrow(ConflictError);
    // Public place → its scene artifact is readable by anyone, including anonymous.
    expect(await canReadArtifact(db, anon, base.hash)).toBe(true);
  });

  it("a revision cannot be used to grant yourself access to someone else's artifact", async () => {
    // Bob knows the hash of Alice's private video and tries to "reference" it from his own place.
    const bobActor: Actor = { kind: "user", userId: "usr_bob" as UserId };
    await createPlace(db, bobActor, {
      id: "plc_bobs" as PlaceId,
      name: "Bob's",
      visibility: "public",
      geo: null,
    });
    const stolen = { hash: h("alice-video"), mediaType: "video/mp4", bytes: 10 };
    const rev: PlaceRevision = {
      placeId: "plc_bobs" as PlaceId,
      parent: null,
      base: stolen,
      edits: [],
      scene: stolen,
      world: null,
      authorId: "usr_bob" as UserId,
      message: "gimme",
      createdAt: new Date().toISOString(),
    };
    expect(await commitRevision(db, bobActor, hashJson(rev), rev)).toBe(false);
    expect(await canReadArtifact(db, bobActor, stolen.hash)).toBe(false);
    expect(await canReadArtifact(db, anon, stolen.hash)).toBe(false);
  });

  it("worlds: written by the worker, approved only by the owner, never hand-written", async () => {
    await createPlace(db, alice, {
      id: "plc_rules" as PlaceId,
      name: "Rules",
      visibility: "public",
      geo: null,
    });
    const scene = { hash: hashJson(sampleFlat), mediaType: "application/json", bytes: 100 };
    const rulebook = { hash: h("rulebook"), mediaType: "application/json", bytes: 50 };
    const forged = { hash: h("forged-rulebook"), mediaType: "application/json", bytes: 50 };
    await systemRecordArtifacts(db, [scene, rulebook, forged]);
    const proposed: PlaceRevision = {
      placeId: "plc_rules" as PlaceId,
      parent: null,
      base: scene,
      edits: [],
      scene,
      world: { spec: rulebook, approved: false },
      authorId: "usr_alice" as UserId,
      message: "compiled",
      createdAt: new Date().toISOString(),
    };
    const head = hashJson(proposed);
    expect(await systemCommitRevision(db, "usr_alice" as UserId, head, proposed, sampleFlat)).toBe(
      true,
    );
    expect(await canReadArtifact(db, anon, rulebook.hash)).toBe(true);

    // Owners can't approve by editing, or swap in a world of their own.
    const edit = (world: PlaceRevision["world"]) => {
      const r = { ...proposed, parent: head, world, message: "edit" };
      return commitRevision(db, alice, hashJson(r), r);
    };
    expect(await edit({ spec: rulebook, approved: true })).toBe(false);
    expect(await edit({ spec: forged, approved: false })).toBe(false);
    expect(await edit(null)).toBe(false);

    // Only the owner, only the world spec proposed at the head they reviewed.
    expect(await approveWorld(db, bob, "plc_rules", head, rulebook.hash)).toBeNull();
    expect(await approveWorld(db, anon, "plc_rules", head, rulebook.hash)).toBeNull();
    expect(await approveWorld(db, alice, "plc_rules", head, forged.hash)).toBeNull();
    expect(await approveWorld(db, alice, "plc_rules", h("stale"), rulebook.hash)).toBeNull();
    const approved = await approveWorld(db, alice, "plc_rules", head, rulebook.hash);
    expect(approved).not.toBeNull();
    expect((await getPlace(db, alice, "plc_rules"))?.head).toBe(approved);
    expect(await approveWorld(db, alice, "plc_rules", approved!, rulebook.hash)).toBeNull();

    // Later edits carry the approval forward unchanged.
    const next = {
      ...proposed,
      parent: approved,
      world: { spec: rulebook, approved: true },
      message: "move sofa",
    };
    expect(await commitRevision(db, alice, hashJson(next), next)).toBe(true);
  });

  it("geo search returns public places only, coarsened for non-owners", async () => {
    const geo = { lat: 6.524379, lng: 3.379206, bearingDeg: 0, precision: "exact" as const };
    await createPlace(db, alice, {
      id: "plc_buka" as PlaceId,
      name: "Buka",
      visibility: "public",
      geo,
    });
    await createPlace(db, alice, {
      id: "plc_secret" as PlaceId,
      name: "Secret",
      visibility: "private",
      geo,
    });
    const found = await listPublicPlacesNear(db, bob, { lat: 6.5244, lng: 3.3792 }, 1000);
    expect(found.map((p) => p.id)).toEqual(["plc_buka"]);
    expect(found[0]?.geo).toEqual({ lat: 6.524, lng: 3.379, bearingDeg: 0, precision: "street" });
    const own = await getPlace(db, alice, "plc_buka");
    expect(own?.geo).toEqual(geo);
  });
});
