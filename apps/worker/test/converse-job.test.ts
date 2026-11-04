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
  const livedKey = "a_busy_flat";
  const kind = sampleSpec.kinds.find((k) => k.actions.length > 0) ?? sampleSpec.kinds[0];
  const offerLabel = kind?.actions[0]?.label as string;
  let admin: postgres.Sql;
  let conn: ReturnType<typeof connect>;
  let db: Db;
  let calls = 0;
  let briefs: unknown[] = [];
  let script: Record<string, unknown> | null = null;

  const voice: Conversationalist = {
    model: { provider: "test", model: "voice", version: "1" },
    prompt: "talk",
    effort: "low",
    async reply(brief) {
      calls++;
      briefs.push(brief);
      return (
        script ?? {
          speaker: placeName,
          text: "You can use what's here.",
          remember: "a secret",
          offer: offerLabel,
        }
      );
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
    // The same place, with its people in.
    const lived = await store.put(encodeJson(sampleSpec), "application/json");
    await systemRecordArtifacts(db, [lived]);
    const livedPlace = "plc_conv2" as PlaceId;
    await systemEnsurePlace(db, { id: livedPlace, ownerId: owner.userId, name: "A busy flat" });
    const livedRev: PlaceRevision = {
      ...rev,
      placeId: livedPlace,
      world: { spec: lived, approved: false },
    };
    const livedHash = hashJson(livedRev) as ArtifactHash;
    await systemCommitRevision(db, owner.userId, livedHash, livedRev, sampleFlat);
    await systemPinPlace(db, world, { key: livedKey, placeId: livedPlace, revision: livedHash });
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

  it("lets people talk among themselves, act and join in, but only who's here", async () => {
    const [one, two] = sampleSpec.people;
    if (!one || !two) throw new Error("the sample needs two people");
    const present = [one.key, two.key] as ConverseJob["present"];
    const overheard = {
      overheard: true,
      said: "",
      playerName: "",
      placeKey: livedKey as ConverseJob["placeKey"],
    };
    script = {
      speaker: one.name,
      text: "Busy day.",
      remember: "",
      offer: offerLabel,
      warmth: 1,
      does: offerLabel,
      alsoSaid: [
        { speaker: two.name, text: "Tell me about it." },
        { speaker: "Someone who isn't here", text: "Hello." },
      ],
    };
    // It takes two: with one person there, no model is asked.
    calls = 0;
    const alone = await runConverseJob(job({ ...overheard, present: [one.key as never] }), {
      db,
      store,
      index,
      voice,
    });
    expect(alone).toBeNull();
    expect(calls).toBe(0);
    const reply = await runConverseJob(job({ ...overheard, present }), { db, store, index, voice });
    expect(briefs.at(-1)).toMatchObject({ overheard: true });
    expect(reply?.text).toBe("Busy day.");
    expect(reply?.does?.label).toBe(offerLabel);
    expect(reply?.alsoSaid).toEqual([
      { person: two.key, name: two.name, text: "Tell me about it." },
    ]);
    // Nobody spoke to them, so nothing's offered to anyone and nobody feels differently.
    expect(reply?.offer).toBeUndefined();
    expect(reply?.warmth).toBe(0);
    // A place with nobody in it can answer, but has nobody to act or join in.
    const empty = await runConverseJob(job({ said: "anyone here at all?" }), {
      db,
      store,
      index,
      voice: {
        ...voice,
        reply: async () => ({ ...script, speaker: placeName }),
      },
    });
    expect(empty?.does).toBeUndefined();
    expect(empty?.alsoSaid).toBeUndefined();
    script = null;
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
