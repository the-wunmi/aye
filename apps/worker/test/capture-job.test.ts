/**
 * A filmed place joining a city, against a real database with offline models: it lands on the
 * map where the player put it, playable by anyone in the city, without ever exposing the video;
 * and it can't lose to (or overwrite) someone else changing the city at the same moment.
 */
import { fileURLToPath } from "node:url";
import { encodeJson, MemoryArtifactStore, randomId } from "@aye/artifacts";
import {
  canReadArtifact,
  connect,
  createCapture,
  createPlace,
  createWorld,
  type Db,
  getCapture,
  getPinnedPlace,
  getWorld,
  joinWorld,
  registerUser,
  systemGetWorld,
  systemSetWorld,
} from "@aye/db";
import type { CityJoiner, Painter } from "@aye/pipeline";
import {
  fakeCalls,
  fakeCapture,
  fakeDescriber,
  fakeWorldAuthor,
  understandingFromScene,
} from "@aye/pipeline/fake";
import {
  type ArtifactHash,
  CitySpec,
  placesOf,
  type UserId,
  type WorldId,
  WorldSpec,
} from "@aye/schema";
import { sampleCity, sampleFlat, sampleSettings } from "@aye/schema/fixtures";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CaptureJobDeps, runCaptureJob } from "../src/capture-job.ts";

const url = process.env["DATABASE_URL"];

describe.skipIf(!url)("filming a place into a city", () => {
  const dbName = `aye_capture_test_${process.pid}_${Date.now()}`;
  const owner = { kind: "user" as const, userId: "usr_owner" as UserId };
  const player = { kind: "user" as const, userId: "usr_player" as UserId };
  const other = { kind: "user" as const, userId: "usr_other" as UserId };
  const world = "wld_filmed" as WorldId;
  let admin: ReturnType<typeof postgres>;
  let conn: ReturnType<typeof connect>;
  let db: Db;
  const store = new MemoryArtifactStore();
  const understanding = understandingFromScene(sampleFlat);
  const calls = fakeCalls();
  const joiner: CityJoiner = {
    model: { provider: "test", model: "join", version: "1" },
    prompt: "join",
    effort: "low",
    async join(brief) {
      return {
        kind: brief.kinds[0]?.name ?? "",
        name: "Wunmi's Kitchen",
        blurb: "Coffee on.",
        icon: "\u{2615}",
        tags: ["food"],
        look: null,
        asks: [],
      };
    },
  };
  const deps = (over: Partial<CaptureJobDeps> = {}): CaptureJobDeps => ({
    db,
    store,
    providers: {
      capture: fakeCapture({ understanding }, calls),
      describer: fakeDescriber(understanding, calls),
      author: fakeWorldAuthor(),
      joiner,
    },
    signal: new AbortController().signal,
    ...over,
  });
  const cityOf = async () => {
    const row = await systemGetWorld(db, world);
    const bytes = await store.get(row?.city as ArtifactHash);
    return CitySpec.parse(JSON.parse(new TextDecoder().decode(bytes as Uint8Array)));
  };
  /** A video this player filmed for the city. */
  const film = async (bytes: string) => {
    const place = await createPlace(db, player, {
      id: randomId("place") as never,
      name: "Filmed",
      visibility: "private",
      geo: null,
    });
    const video = await store.put(new TextEncoder().encode(bytes), "video/mp4");
    const capture = await createCapture(db, player, {
      id: randomId("capture"),
      placeId: place.id,
      video,
      durationMs: 25_000,
      worldId: world,
    });
    return { id: capture?.id as string, video, placeId: place.id };
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
    for (const a of [owner, player, other]) {
      await registerUser(db, {
        id: a.userId,
        handle: a.userId.slice(4),
        password: "a long password",
      });
    }
    await createWorld(db, owner, {
      id: world,
      name: "Testville",
      description: "A small test town",
      currency: "NGN",
      visibility: "public",
      settings: sampleSettings,
    });
    const ref = await store.put(encodeJson(sampleCity), "application/json");
    await systemSetWorld(db, world, { city: ref.hash, status: "ready" });
    await joinWorld(db, player, world);
    await joinWorld(db, other, world);
  }, 60_000);

  afterAll(async () => {
    await conn?.close();
    await admin?.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
  });

  it("only the owner of a place can add a capture of it", async () => {
    const mine = await film("my video");
    const video = await store.put(new TextEncoder().encode("x"), "video/mp4");
    expect(
      await createCapture(db, other, {
        id: randomId("capture"),
        placeId: mine.placeId,
        video,
        durationMs: 0,
        worldId: world,
      }),
    ).toBeNull();
    expect(await getCapture(db, other, mine.id)).toBeNull();
    expect((await getCapture(db, player, mine.id))?.status).toBe("uploaded");
  });

  it("lands on the map where they put it, and anyone in the city can go in", async () => {
    const filmed = await film("the kitchen video");
    const r = await runCaptureJob(
      { worldId: world, captureId: filmed.id, note: "my kitchen", at: [120, 340] },
      deps(),
    );
    const key = r?.placeKey as string;
    expect(key).toBeTruthy();
    const city = await cityOf();
    const place = placesOf(city).find((p) => p.key === key);
    // What they called it, not what the model would rather call it.
    expect(place?.name).toBe("my kitchen");
    expect(place?.at).toEqual([120, 340]);
    expect(place?.private).toBe(false);
    // Everything the city had is still there.
    for (const p of placesOf(sampleCity)) {
      expect(placesOf(city).some((x) => x.key === p.key)).toBe(true);
    }
    // The owner's told how it went; others can walk in.
    expect(await getCapture(db, player, filmed.id)).toMatchObject({
      status: "ready",
      phase: "ready",
      placeKey: key,
    });
    const pinned = await getPinnedPlace(db, other, world, key);
    expect(pinned?.spec).toBeTruthy();
    expect(await canReadArtifact(db, other, pinned?.scene as ArtifactHash)).toBe(true);
    expect(await canReadArtifact(db, other, pinned?.spec as ArtifactHash)).toBe(true);
    // The video itself never leaves its owner, whoever knows its hash.
    expect(await canReadArtifact(db, other, filmed.video.hash)).toBe(false);
    const world2 = await getWorld(db, other, world);
    expect(JSON.stringify(world2)).not.toContain(filmed.video.hash);
  });

  it("doesn't lose to someone changing the city at the same moment, or overwrite them", async () => {
    const filmed = await film("another video");
    let raced = false;
    const racing: CityJoiner = {
      ...joiner,
      async join(brief, schema, ctx) {
        // The director adds its news just before this place tries to join.
        if (!raced) {
          raced = true;
          const now = await cityOf();
          const next = await store.put(
            encodeJson({ ...now, tagline: "Changed by someone else" }),
            "application/json",
          );
          await systemSetWorld(db, world, { city: next.hash });
        }
        return joiner.join(brief, schema, ctx);
      },
    };
    const base = deps();
    const r = await runCaptureJob(
      { worldId: world, captureId: filmed.id, note: "", at: [10, 10] },
      { ...base, providers: { ...base.providers, joiner: racing } },
    );
    const city = await cityOf();
    expect(city.tagline).toBe("Changed by someone else");
    expect(city.items.some((i) => i.key === r?.placeKey)).toBe(true);
  });

  it("says so when it fails, and the city is untouched", async () => {
    const filmed = await film("a broken video");
    const before = (await systemGetWorld(db, world))?.city;
    const base = deps();
    const broken = {
      ...base.providers.joiner,
      join: async () => {
        throw new Error("model down");
      },
    };
    await expect(
      runCaptureJob(
        { worldId: world, captureId: filmed.id, note: "", at: [5, 5] },
        { ...base, providers: { ...base.providers, joiner: broken } },
      ),
    ).rejects.toThrow();
    expect(await getCapture(db, player, filmed.id)).toMatchObject({
      status: "failed",
      phase: "failed",
      placeKey: null,
    });
    expect((await systemGetWorld(db, world))?.city).toBe(before);
  });

  it("paints it from the redacted frames, and everyone in the city can see the pictures", async () => {
    const filmed = await film("a video worth painting");
    const WEBP = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 9, 9, 9, 9, 9, 9];
    let n = 0;
    const painter: Painter = {
      planModel: { provider: "test", model: "plan", version: "1" },
      imageModel: { provider: "test", model: "image", version: "1" },
      planPrompt: "plan",
      effort: "low",
      async plan() {
        return {
          floors: sampleFlat.spaces.map((_, space) => ({ space, looks: "cement" })),
          walls: "marble",
          notBoxes: [],
          tops: [0],
        };
      },
      async paint() {
        n++;
        return { bytes: new Uint8Array([...WEBP, n]), mediaType: "image/webp" };
      },
    };
    const base = deps();
    const r = await runCaptureJob(
      { worldId: world, captureId: filmed.id, note: "", at: [30, 30] },
      { ...base, providers: { ...base.providers, painter } },
    );
    const pinned = await getPinnedPlace(db, other, world, r?.placeKey as string);
    const bytes = await store.get(pinned?.spec as ArtifactHash);
    const spec = WorldSpec.parse(JSON.parse(new TextDecoder().decode(bytes as Uint8Array)));
    expect(spec.walls.photo).toBeTruthy();
    expect(spec.ground.every((g) => g.photo)).toBe(true);
    const front = spec.things.find((t) => t.front)?.front as ArtifactHash;
    expect(front).toBeTruthy();
    for (const hash of [spec.walls.photo as ArtifactHash, front]) {
      expect(await canReadArtifact(db, other, hash)).toBe(true);
    }
    expect(await canReadArtifact(db, other, filmed.video.hash)).toBe(false);
  });

  it("is still a working place if the painting fails", async () => {
    const filmed = await film("a video that won't paint");
    const painter: Painter = {
      planModel: { provider: "test", model: "plan", version: "1" },
      imageModel: { provider: "test", model: "image", version: "1" },
      planPrompt: "plan",
      effort: "low",
      async plan() {
        throw new Error("model down");
      },
      async paint() {
        throw new Error("model down");
      },
    };
    const base = deps();
    const r = await runCaptureJob(
      { worldId: world, captureId: filmed.id, note: "", at: [40, 40] },
      { ...base, providers: { ...base.providers, painter } },
    );
    expect(r?.placeKey).toBeTruthy();
    expect((await getCapture(db, player, filmed.id))?.status).toBe("ready");
  });
});
