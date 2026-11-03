/**
 * Speaking in a place, against a real database with an offline model: with nobody there the place
 * itself can answer, offering what's really there, but it never greets anyone, never remembers
 * and never pretends to be a person.
 */
import { fileURLToPath } from "node:url";
import { encodeJson, hashJson, MemoryArtifactStore, MemoryRecipeIndex } from "@aye/artifacts";
import {
  connect,
  createWorld,
  type Db,
  registerUser,
  systemCommitRevision,
  systemEnsurePlace,
  systemPersonMemories,
  systemPinPlace,
  systemRecordArtifacts,
  systemSetWorld,
} from "@aye/db";
import type { Conversationalist } from "@aye/pipeline";
import {
  type ArtifactHash,
  type PlaceId,
  type PlaceRevision,
  placesOf,
  type UserId,
  type WorldId,
} from "@aye/schema";
import { sampleCity, sampleFlat, sampleSettings, sampleSpec } from "@aye/schema/fixtures";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ConverseJob, runConverseJob } from "../src/converse-job.ts";

const url = process.env["DATABASE_URL"];

describe.skipIf(!url)("speaking in an empty place", () => {
  const dbName = `aye_converse_${Date.now()}`;
  const owner = { kind: "user" as const, userId: "usr_conv" as UserId };
  const world = "wld_conv" as WorldId;
  const store = new MemoryArtifactStore();
  const index = new MemoryRecipeIndex();
  const placeKey = placesOf(sampleCity)[0]?.key as string;
  const placeName = placesOf(sampleCity)[0]?.name as string;
  const kind = sampleSpec.kinds.find((k) => k.actions.length > 0) ?? sampleSpec.kinds[0];
  const offerLabel = kind?.actions[0]?.label as string;
  let admin: postgres.Sql;
  let conn: ReturnType<typeof connect>;
  let db: Db;
  let calls = 0;
  let briefs: unknown[] = [];

  const voice: Conversationalist = {
    model: { provider: "test", model: "voice", version: "1" },
    prompt: "talk",
    effort: "low",
    async reply(brief) {
      calls++;
      briefs.push(brief);
      return {
        speaker: placeName,
        text: "You can use what's here.",
        remember: "a secret",
        offer: offerLabel,
      };
    },
  };
  const job = (over: Partial<ConverseJob>): ConverseJob => ({
    worldId: world,
    placeKey: placeKey as ConverseJob["placeKey"],
    instance: "",
    playerName: "Ada",
    said: "what can I do here?",
    arrived: false,
    present: [],
    recent: [],
    ...over,
  });

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${dbName}`);
    const testUrl = new URL(url as string);
    testUrl.pathname = `/${dbName}`;
    conn = connect(testUrl.toString(), { max: 4 });
    db = conn.db;
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url)),
    });
    await registerUser(db, { id: owner.userId, handle: "owner", password: "a long password" });
    await createWorld(db, owner, {
      id: world,
      name: "Testville",
      description: "A small test town",
      currency: "NGN",
      visibility: "public",
      settings: sampleSettings,
    });
    const city = await store.put(encodeJson(sampleCity), "application/json");
    const placeId = "plc_conv" as PlaceId;
    await systemEnsurePlace(db, { id: placeId, ownerId: owner.userId, name: "A flat" });
    const scene = await store.put(encodeJson(sampleFlat), "application/json");
    const spec = await store.put(encodeJson({ ...sampleSpec, people: [] }), "application/json");
    await systemRecordArtifacts(db, [scene, spec, city]);
    const rev: PlaceRevision = {
      placeId,
      parent: null,
      base: scene,
      edits: [],
      scene,
      world: { spec, approved: false },
      authorId: owner.userId,
      message: "test",
      createdAt: new Date().toISOString(),
    };
    const hash = hashJson(rev) as ArtifactHash;
    await systemCommitRevision(db, owner.userId, hash, rev, sampleFlat);
    await systemPinPlace(db, world, { key: placeKey, placeId, revision: hash });
    await systemSetWorld(db, world, { city: city.hash, status: "ready" });
  }, 60_000);

  afterAll(async () => {
    await conn?.close();
    await admin?.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
  });

  it("answers when spoken to, as the place, offering what's really there", async () => {
    calls = 0;
    briefs = [];
    const reply = await runConverseJob(job({}), { db, store, index, voice });
    expect(calls).toBe(1);
    expect(reply?.text).toBe("You can use what's here.");
    expect(reply?.offer?.label).toBe(offerLabel);
    expect(briefs[0]).toMatchObject({ empty: true });
    // It remembers nothing: nobody was there to remember it.
    expect((await systemPersonMemories(db, world, placeKey)).size).toBe(0);
  });

  it("says nothing when someone just walks in", async () => {
    calls = 0;
    const reply = await runConverseJob(job({ arrived: true, said: "" }), {
      db,
      store,
      index,
      voice,
    });
    expect(reply).toBeNull();
    expect(calls).toBe(0);
  });
});
