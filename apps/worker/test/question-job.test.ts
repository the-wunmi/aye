/** A question about a place, against a real database with an offline agent. */
import { fileURLToPath } from "node:url";
import { encodeJson, hashJson, MemoryArtifactStore, MemoryRecipeIndex } from "@aye/artifacts";
import {
  connect,
  createWorld,
  type Db,
  registerUser,
  systemCommitRevision,
  systemEnsurePlace,
  systemPinPlace,
  systemRecordArtifacts,
} from "@aye/db";
import type { WorldAgent } from "@aye/pipeline";
import type { ArtifactHash, PlaceId, PlaceRevision, UserId, WorldId } from "@aye/schema";
import { sampleFlat, sampleSettings, sampleSpec } from "@aye/schema/fixtures";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runQuestionJob } from "../src/question-job.ts";

const url = process.env["DATABASE_URL"];
const WHEELS = {
  widthMm: 700,
  stepMm: 20,
  stairs: false,
  slopePermille: 83,
  speedMmPerS: 900,
  reachUpMm: 1_200,
  changes: [],
};

describe.skipIf(!url)("asking about a place", () => {
  const dbName = `aye_question_test_${process.pid}_${Date.now()}`;
  const owner = { kind: "user" as const, userId: "usr_owner" as UserId };
  const world = "wld_asked" as WorldId;
  let admin: ReturnType<typeof postgres>;
  let conn: ReturnType<typeof connect>;
  let db: Db;
  const store = new MemoryArtifactStore();
  let turns = 0;
  const agent: WorldAgent = {
    model: { provider: "test", model: "agent", version: "1" },
    prompt: "ask",
    effort: "low",
    async turn() {
      turns++;
      return {
        content: "",
        toolCalls:
          turns === 1
            ? [{ id: "a", name: "try_body", args: JSON.stringify(WHEELS) }]
            : [
                {
                  id: "b",
                  name: "finish",
                  args: JSON.stringify({
                    verdict: "Yes.",
                    answer: "Yes.",
                    nextStep: "",
                    followUps: [],
                    untested: false,
                    findings: [],
                  }),
                },
              ],
      };
    },
  };

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
    const placeId = "plc_asked" as PlaceId;
    await systemEnsurePlace(db, { id: placeId, ownerId: owner.userId, name: "A flat" });
    const scene = await store.put(encodeJson(sampleFlat), "application/json");
    const spec = await store.put(encodeJson(sampleSpec), "application/json");
    await systemRecordArtifacts(db, [scene, spec]);
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
    await systemPinPlace(db, world, { key: "flat", placeId, revision: hash });
  }, 60_000);

  afterAll(async () => {
    await conn?.close();
    await admin?.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
  });

  const job = (over = {}) => ({
    worldId: world,
    placeKey: "flat",
    question: "Could a wheelchair user get around?",
    nonce: "abc123",
    ...over,
  });
  const deps = () => ({ db, store, index: new MemoryRecipeIndex(), agent });

  it("answers about the place as it's pinned, from tests", async () => {
    const r = await runQuestionJob(job() as never, deps());
    expect(r).toEqual({ ok: true, answer: expect.objectContaining({ answer: "Yes.", tests: 1 }) });
  });

  it("says no answer for a place that isn't there", async () => {
    const r = await runQuestionJob(job({ placeKey: "nowhere" }) as never, deps());
    expect(r).toEqual({ ok: false });
  });
});
