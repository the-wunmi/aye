/**
 * Building one place with offline models against a real database: from a recording or a
 * description, with the owner's edits rebased, malformed jobs refused and raw evidence unlinked.
 */
import { fileURLToPath } from "node:url";
import { hashJson, MemoryArtifactStore } from "@aye/artifacts";
import { canReadArtifact, commitRevision, connect, type Db, getPlace, tables } from "@aye/db";
import {
  fakeCalls,
  fakeCapture,
  fakeDescriber,
  fakeWorldAuthor,
  understandingFromScene,
} from "@aye/pipeline/fake";
import { EditOp, type PlaceId, type PlaceRevision, type UserId, WorldSpec } from "@aye/schema";
import { sampleFlat } from "@aye/schema/fixtures";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCompileJob } from "../src/compile-job.ts";

const url = process.env["DATABASE_URL"];

describe.skipIf(!url)("capture.compile job", () => {
  const dbName = `aye_worker_test_${process.pid}_${Date.now()}`;
  const alice = { kind: "user" as const, userId: "usr_alice" as UserId };
  let admin: ReturnType<typeof postgres>;
  let conn: ReturnType<typeof connect>;
  let db: Db;
  const store = new MemoryArtifactStore();
  const calls = fakeCalls();
  const understanding = understandingFromScene(sampleFlat);
  const providers = {
    capture: fakeCapture({ understanding }, calls),
    describer: fakeDescriber(understanding, calls),
    author: fakeWorldAuthor(calls),
  };
  const deps = () => ({ db, store, providers, signal: new AbortController().signal });
  const recording = { source: { kind: "recording", captureId: "cap_flat01" }, currency: "NGN" };

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
    const video = await store.put(new TextEncoder().encode("mp4 bytes"), "video/mp4");
    await db.insert(tables.users).values({ id: "usr_alice", handle: "alice" });
    await db.insert(tables.places).values([
      { id: "plc_flat01", ownerId: "usr_alice", name: "Flat" },
      { id: "plc_words01", ownerId: "usr_alice", name: "Yard" },
    ]);
    await db.insert(tables.captures).values({
      id: "cap_flat01",
      placeId: "plc_flat01",
      ownerId: "usr_alice",
      video: video.hash,
      videoBytes: video.bytes,
      mediaType: video.mediaType,
      durationMs: 30_000,
    });
  }, 60_000);

  afterAll(async () => {
    await conn?.close();
    await admin?.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
  });

  it("builds a place from a recording: layout and an unapproved world", async () => {
    const result = await runCompileJob(recording, deps());
    const place = await getPlace(db, alice, "plc_flat01");
    expect(place?.head).toBe(result?.revision);
    const [cap] = await db
      .select()
      .from(tables.captures)
      .where(eq(tables.captures.id, "cap_flat01"));
    expect(cap?.status).toBe("ready");
    // A world was written for the place and waits for the owner's approval.
    const [rev] = await db
      .select()
      .from(tables.placeRevisions)
      .where(eq(tables.placeRevisions.hash, result!.revision));
    expect(rev?.worldApproved).toBe(false);
    const spec = WorldSpec.parse(
      JSON.parse(new TextDecoder().decode((await store.get(rev!.worldSpec!))!)),
    );
    expect(spec.things).toHaveLength(sampleFlat.objects.length);
    expect(calls.author).toBe(1);
    expect(await canReadArtifact(db, alice, rev!.worldSpec!)).toBe(true);
  });

  it("builds a place from a description, with no recording at all", async () => {
    const result = await runCompileJob(
      {
        source: {
          kind: "description",
          placeId: "plc_words01",
          text: "A compound yard in Surulere",
        },
        currency: "NGN",
      },
      deps(),
    );
    expect((await getPlace(db, alice, "plc_words01"))?.head).toBe(result?.revision);
    expect(calls.describe).toBe(1);
  });

  it("recompiling rebases the owner's edits and makes no new model calls", async () => {
    // Owner moves the sofa: a new revision on top of the compiled one.
    const place = await getPlace(db, alice, "plc_flat01");
    const [head] = await db
      .select()
      .from(tables.placeRevisions)
      .where(eq(tables.placeRevisions.hash, place!.head!));
    const bytes = await store.get(head!.scene);
    const scene = JSON.parse(new TextDecoder().decode(bytes!));
    const sofa = scene.objects.find((o: { label: string }) => o.label.includes("leather"));
    const moved = { ...sofa, transform: { ...sofa.transform, position: [1500, 0, 2900] } };
    const edit = EditOp.parse({ op: "object.put", value: moved });
    const edited: PlaceRevision = {
      placeId: "plc_flat01" as PlaceId,
      parent: place!.head,
      base: { hash: head!.base, mediaType: "application/json", bytes: 1 },
      edits: [edit],
      scene: { hash: head!.scene, mediaType: "application/json", bytes: 1 },
      world: {
        spec: { hash: head!.worldSpec!, mediaType: "application/json", bytes: 1 },
        approved: false,
      },
      authorId: alice.userId,
      message: "moved the sofa",
      createdAt: new Date().toISOString(),
    };
    expect(await commitRevision(db, alice, hashJson(edited), edited)).toBe(true);

    const before = { ...calls };
    const again = await runCompileJob(recording, deps());
    expect(calls).toEqual(before);

    const [rev] = await db
      .select()
      .from(tables.placeRevisions)
      .where(eq(tables.placeRevisions.hash, again!.revision));
    expect(rev?.edits).toHaveLength(1);
    const rebased = JSON.parse(new TextDecoder().decode((await store.get(rev!.scene))!));
    expect(
      rebased.objects.find((o: { id: string }) => o.id === sofa.id).transform.position,
    ).toEqual([1500, 0, 2900]);
  });

  it("rejects malformed job payloads before touching anything", async () => {
    await expect(runCompileJob({ ...recording, extra: 1 }, deps())).rejects.toThrow();
    await expect(
      runCompileJob(
        { source: { kind: "recording", captureId: "../etc" }, currency: "NGN" },
        deps(),
      ),
    ).rejects.toThrow();
    await expect(
      runCompileJob(
        { source: { kind: "description", placeId: "plc_words01", text: "" }, currency: "NGN" },
        deps(),
      ),
    ).rejects.toThrow();
  });

  it("never links raw evidence: masks stay private even to the owner's place readers", async () => {
    const place = await getPlace(db, alice, "plc_flat01");
    const [rev] = await db
      .select()
      .from(tables.placeRevisions)
      .where(eq(tables.placeRevisions.hash, place!.head!));
    const mallory = { kind: "user" as const, userId: "usr_mallory" as UserId };
    expect(await canReadArtifact(db, mallory, rev!.worldSpec!)).toBe(false);
    expect(await canReadArtifact(db, alice, rev!.scene)).toBe(true);
  });
});
