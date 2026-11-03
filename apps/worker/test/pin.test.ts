/**
 * Pinning only ever points at a saved revision, even when two jobs move a place at once.
 */
import { fileURLToPath } from "node:url";
import { hashJson } from "@aye/artifacts";
import {
  connect,
  createWorld,
  type Db,
  registerUser,
  systemEnsurePlace,
  systemGetPinnedPlace,
} from "@aye/db";
import type { ArtifactHash, PlaceId, PlaceRevision, UserId, WorldId } from "@aye/schema";
import { sampleFlat, sampleSettings } from "@aye/schema/fixtures";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commitAndPin } from "../src/pin.ts";

const url = process.env["DATABASE_URL"];

describe.skipIf(!url)("commitAndPin", () => {
  const dbName = `aye_pin_test_${process.pid}_${Date.now()}`;
  const alice = "usr_alice" as UserId;
  const world = "wld_pins" as WorldId;
  const placeId = "plc_pins" as PlaceId;
  let admin: ReturnType<typeof postgres>;
  let conn: ReturnType<typeof connect>;
  let db: Db;
  const sceneRef = {
    hash: hashJson(sampleFlat) as ArtifactHash,
    mediaType: "application/json",
    bytes: 1,
  };
  const rev = (parent: ArtifactHash | null, message: string): PlaceRevision => ({
    placeId,
    parent,
    base: sceneRef,
    edits: [],
    scene: sceneRef,
    world: null,
    authorId: alice,
    message,
    createdAt: new Date().toISOString(),
  });
  const target = { worldId: world, key: "flat", ownerId: alice };
  const pinned = async () => (await systemGetPinnedPlace(db, world, "flat"))?.revision ?? null;

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${dbName}`);
    const testUrl = new URL(url as string);
    testUrl.pathname = `/${dbName}`;
    conn = connect(testUrl.toString(), { max: 2 });
    db = conn.db;
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url)),
    });
    await registerUser(db, { id: alice, handle: "alice", password: "alice password" });
    await createWorld(
      db,
      { kind: "user", userId: alice },
      {
        id: world,
        name: "Pins",
        description: "",
        currency: "NGN",
        visibility: "private",
        settings: sampleSettings,
      },
    );
    await systemEnsurePlace(db, { id: placeId, ownerId: alice, name: "Flat" });
  }, 60_000);

  afterAll(async () => {
    await conn?.close();
    await admin?.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
  });

  it("saves then pins; a rebuild goes on top of what was there, never lost to it", async () => {
    const first = await commitAndPin(db, target, rev(null, "built"), sampleFlat);
    expect(first).not.toBeNull();
    expect(await pinned()).toBe(first);
    // Built again from scratch (no parent): the place already has a head; the rebuild wins.
    const again = await commitAndPin(db, target, rev(null, "rebuilt"), sampleFlat);
    expect(again).not.toBeNull();
    expect(again).not.toBe(first);
    expect(await pinned()).toBe(again);
  });

  it("rebases onto a head another job moved, instead of pinning nothing", async () => {
    const head = (await pinned()) as ArtifactHash;
    const dressed = await commitAndPin(db, target, rev(head, "dressed"), sampleFlat);
    expect(dressed).not.toBeNull();
    // A second job still thinks the head is the old one.
    const furnished = await commitAndPin(db, target, rev(head, "furnished"), sampleFlat);
    expect(furnished).not.toBeNull();
    expect(furnished).not.toBe(dressed);
    expect(await pinned()).toBe(furnished);
    const rows = await db.execute<{ parent: string }>(
      sql`select parent from place_revisions where hash = ${furnished}`,
    );
    expect([...rows][0]?.parent).toBe(dressed);
  });
});
