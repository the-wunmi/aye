/**
 * HTTP-level security tests. The DB-backed suite creates a throwaway database, applies the
 * real migrations, and drives the app through `app.request` exactly as a client would.
 */
import { fileURLToPath } from "node:url";
import { encodeJson, hashJson, MemoryArtifactStore } from "@aye/artifacts";
import { connect, type Db, systemCommitRevision, tables } from "@aye/db";
import type { PlaceId, PlaceRevision, UserId } from "@aye/schema";
import { sampleFlat, sampleSpec } from "@aye/schema/fixtures";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { contentLoader } from "../src/content.ts";
import { type Env, loadEnv } from "../src/env.ts";
import { rateLimit } from "../src/rate-limit.ts";

const url = process.env["DATABASE_URL"];

describe("loadEnv", () => {
  it("refuses the dev auth header in production", () => {
    expect(() =>
      loadEnv({ NODE_ENV: "production", DATABASE_URL: "postgres://u:p@h/db", AYE_DEV_AUTH: "1" }),
    ).toThrow(/AYE_DEV_AUTH/);
  });

  it("reports which keys are invalid without echoing secret values", () => {
    try {
      loadEnv({ DATABASE_URL: "mysql://user:hunter2@host/db" });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toContain("DATABASE_URL");
      expect(String(error)).not.toContain("hunter2");
    }
  });
});

describe("rateLimit", () => {
  it("returns 429 past the limit, per key", async () => {
    const app = new Hono();
    app.use(rateLimit({ windowMs: 60_000, max: 2, key: (c) => c.req.header("x-k") ?? "" }));
    app.get("/", (c) => c.text("ok"));
    const hit = async (k: string) => (await app.request("/", { headers: { "x-k": k } })).status;
    expect([await hit("a"), await hit("a"), await hit("a"), await hit("b")]).toEqual([
      200, 200, 429, 200,
    ]);
  });
});

describe.skipIf(!url)("API", () => {
  const dbName = `aye_api_test_${process.pid}_${Date.now()}`;
  let admin: ReturnType<typeof postgres>;
  let conn: ReturnType<typeof connect>;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  const store = new MemoryArtifactStore();

  const as = (user: string | null, init: RequestInit = {}) => ({
    ...init,
    headers: {
      "content-type": "application/json",
      ...(user ? { "x-aye-dev-user": user } : {}),
      ...init.headers,
    },
  });

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
    await db.insert(tables.users).values([
      { id: "usr_alice", handle: "alice" },
      { id: "usr_bob", handle: "bob" },
    ]);
    const env: Env = loadEnv({
      NODE_ENV: "test",
      DATABASE_URL: testUrl.toString(),
      AYE_DEV_AUTH: "1",
    });
    app = createApp({
      env,
      db,
      store,
      content: contentLoader(store),
      enqueueCapture: async () => {},
      questions: { enqueue: async () => "question-x", status: async () => null },
      enqueueCity: async () => {},
      asks: { enqueue: async () => "ask-x", status: async () => null },
    });
  }, 60_000);

  afterAll(async () => {
    await conn?.close();
    await admin?.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
  });

  it("sends strict security headers", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("requires sign-in to create, and rejects unknown or malformed fields", async () => {
    const body = JSON.stringify({ name: "Home" });
    expect((await app.request("/places", as(null, { method: "POST", body }))).status).toBe(401);
    const extra = JSON.stringify({ name: "Home", kind: "home", ownerId: "usr_bob" });
    expect(
      (await app.request("/places", as("usr_alice", { method: "POST", body: extra }))).status,
    ).toBe(400);
    expect(
      (await app.request("/places", as("usr_alice", { method: "POST", body: "{not json" }))).status,
    ).toBe(400);
  });

  it("another user's private place is indistinguishable from a missing one", async () => {
    const res = await app.request(
      "/places",
      as("usr_alice", { method: "POST", body: JSON.stringify({ name: "Home" }) }),
    );
    expect(res.status).toBe(201);
    const { place } = (await res.json()) as { place: { id: string; ownerId: string } };
    expect(place.ownerId).toBe("usr_alice");

    const theirs = await app.request(`/places/${place.id}`, as("usr_bob"));
    const missing = await app.request("/places/plc_doesnotexist0", as("usr_bob"));
    expect(theirs.status).toBe(404);
    expect(await theirs.text()).toBe(await missing.text());

    const patch = await app.request(
      `/places/${place.id}`,
      as("usr_bob", { method: "PATCH", body: JSON.stringify({ name: "pwned" }) }),
    );
    expect(patch.status).toBe(404);
    expect((await app.request("/places/../../etc", as("usr_bob"))).status).toBe(404);
    expect((await app.request("/places/PLC_' or 1=1--", as("usr_bob"))).status).toBe(400);
  });

  it("ignores the dev identity header when it is not a valid user id", async () => {
    const res = await app.request(
      "/places",
      as("usr_alice'; drop table users;--", {
        method: "POST",
        body: JSON.stringify({ name: "x" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects oversized bodies", async () => {
    const big = JSON.stringify({ name: "x".repeat(2 * 1024 * 1024) });
    expect(
      (await app.request("/places", as("usr_alice", { method: "POST", body: big }))).status,
    ).toBe(413);
  });

  it("serves artifacts only through readable records, sandboxed", async () => {
    const scene = await store.put(encodeJson(sampleFlat), "application/json");
    const placeId = "plc_alicestreet" as PlaceId;
    await db.insert(tables.places).values({
      id: placeId,
      ownerId: "usr_alice",
      name: "Street",
      visibility: "private",
    });
    await db
      .insert(tables.artifacts)
      .values({ hash: scene.hash, mediaType: scene.mediaType, bytes: scene.bytes });
    const rev: PlaceRevision = {
      placeId,
      parent: null,
      base: scene,
      edits: [],
      scene,
      world: null,
      authorId: "usr_alice" as UserId,
      message: "from capture",
      createdAt: new Date().toISOString(),
    };
    expect(
      await systemCommitRevision(db, "usr_alice" as UserId, hashJson(rev), rev, sampleFlat),
    ).toBe(true);

    expect((await app.request(`/artifacts/${scene.hash}`, as("usr_bob"))).status).toBe(404);
    expect((await app.request(`/artifacts/${scene.hash}`, as(null))).status).toBe(404);
    const own = await app.request(`/artifacts/${scene.hash}`, as("usr_alice"));
    expect(own.status).toBe(200);
    expect(own.headers.get("content-security-policy")).toContain("sandbox");
    expect(own.headers.get("cache-control")).toContain("private");
    expect((await app.request("/artifacts/b3:../../secret", as("usr_alice"))).status).toBe(400);
  });

  it("serves a place's world to readers and lets only the owner approve it", async () => {
    const scene = await store.put(encodeJson(sampleFlat), "application/json");
    const spec = await store.put(encodeJson(sampleSpec), "application/json");
    const placeId = "plc_aliceflat" as PlaceId;
    await db.insert(tables.places).values({
      id: placeId,
      ownerId: "usr_alice",
      name: "Flat",
      visibility: "private",
    });
    await db
      .insert(tables.artifacts)
      .values([scene, spec].map((r) => ({ hash: r.hash, mediaType: r.mediaType, bytes: r.bytes })))
      .onConflictDoNothing();
    const rev: PlaceRevision = {
      placeId,
      parent: null,
      base: scene,
      edits: [],
      scene,
      world: { spec, approved: false },
      authorId: "usr_alice" as UserId,
      message: "built",
      createdAt: new Date().toISOString(),
    };
    const head = hashJson(rev);
    expect(await systemCommitRevision(db, "usr_alice" as UserId, head, rev, sampleFlat)).toBe(true);

    const read = await app.request(`/places/${placeId}/world`, as("usr_alice"));
    expect(read.status).toBe(200);
    const body = (await read.json()) as { head: string; world: { approved: boolean } };
    expect(body.head).toBe(head);
    expect(body.world.approved).toBe(false);
    expect((await app.request(`/places/${placeId}/world`, as("usr_bob"))).status).toBe(404);

    const approve = (who: string | null, payload: unknown) =>
      app.request(
        `/places/${placeId}/world/approve`,
        as(who, { method: "POST", body: JSON.stringify(payload) }),
      );
    const good = { head, spec: spec.hash };
    expect((await approve(null, good)).status).toBe(401);
    expect((await approve("usr_bob", good)).status).toBe(404);
    expect((await approve("usr_alice", { head })).status).toBe(400);
    expect((await approve("usr_alice", { ...good, approved: true })).status).toBe(400);
    expect((await approve("usr_alice", { ...good, spec: scene.hash })).status).toBe(404);
    expect((await approve("usr_alice", good)).status).toBe(201);
    expect((await approve("usr_alice", good)).status).toBe(404);
    const after = (await (
      await app.request(`/places/${placeId}/world`, as("usr_alice"))
    ).json()) as {
      world: { approved: boolean };
    };
    expect(after.world.approved).toBe(true);
  });
});
