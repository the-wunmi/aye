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
  listRemovablePlaceKeys,
  registerUser,
  systemGetCapture,
  systemGetWorld,
  systemRecipesTaking,
  systemRecordArtifacts,
  systemSetWorld,
} from "@aye/db";
import type { CityJoiner, ObjectReconstructor, Painter, ReconstructPlanner } from "@aye/pipeline";
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
import { runRemoveJob } from "../src/remove-job.ts";

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

  /** A real model's file, as far as anything reading it can tell. */
  const aModel = () => {
    const text = new TextEncoder().encode(
      JSON.stringify({
        accessors: [{ count: 3 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      }).padEnd(120, " "),
    );
    const bytes = new Uint8Array(20 + text.byteLength);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, bytes.byteLength, true);
    view.setUint32(12, text.byteLength, true);
    view.setUint32(16, 0x4e4f534a, true);
    bytes.set(text, 20);
    return bytes;
  };
  const planner: ReconstructPlanner = {
    model: { provider: "test", model: "plan", version: "1" },
    prompt: "plan",
    effort: "low",
    async plan(things) {
      return { things: [{ n: things[0]?.n ?? 0, views: [{ frame: 0, concept: "a thing" }] }] };
    },
  };

  it("opens first, then swaps its real things in, without losing what happened meanwhile", async () => {
    const filmed = await film("a video worth rebuilding");
    let openWhenAsked = false;
    let key = "";
    const reconstructor: ObjectReconstructor = {
      model: { provider: "test", model: "rebuild", version: "1" },
      async reconstruct() {
        // It's open by now: someone could be standing in it.
        const row = await systemGetCapture(db, filmed.id);
        key = row?.placeKey as string;
        openWhenAsked = row?.status === "ready";
        return aModel();
      },
    };
    const base = deps();
    const r = await runCaptureJob(
      { worldId: world, captureId: filmed.id, note: "", at: [32, 32] },
      { ...base, providers: { ...base.providers, rebuilder: { planner, reconstructor } } },
    );
    expect(openWhenAsked).toBe(true);
    expect(r?.placeKey).toBe(key);
    const pinned = await getPinnedPlace(db, other, world, key);
    const spec = WorldSpec.parse(
      JSON.parse(
        new TextDecoder().decode((await store.get(pinned?.spec as ArtifactHash)) as Uint8Array),
      ),
    );
    const mesh = spec.things.find((t) => t.mesh)?.mesh as ArtifactHash;
    expect(mesh).toBeTruthy();
    expect(await canReadArtifact(db, other, mesh)).toBe(true);
  });

  it("is still a good place if rebuilding fails", async () => {
    const filmed = await film("a video that won't rebuild");
    const reconstructor: ObjectReconstructor = {
      model: { provider: "test", model: "rebuild", version: "2" },
      async reconstruct() {
        throw new Error("reconstruct: HTTP 500");
      },
    };
    const base = deps();
    const r = await runCaptureJob(
      { worldId: world, captureId: filmed.id, note: "", at: [34, 34] },
      { ...base, providers: { ...base.providers, rebuilder: { planner, reconstructor } } },
    );
    expect(r?.placeKey).toBeTruthy();
    expect((await systemGetCapture(db, filmed.id))?.status).toBe("ready");
    const pinned = await getPinnedPlace(db, other, world, r?.placeKey as string);
    expect(pinned?.spec).toBeTruthy();
  });

  it("takes a filmed place away for good, frames and all, only for those allowed", async () => {
    const filmed = await film("a video to take back");
    const base = deps();
    const r = await runCaptureJob(
      { worldId: world, captureId: filmed.id, note: "", at: [36, 36] },
      base,
    );
    const key = r?.placeKey as string;
    const pinned = await getPinnedPlace(db, other, world, key);
    const remove = (userId: string, nonce: string) =>
      runRemoveJob({ worldId: world, place: key, userId, nonce }, { db, store });
    const scene = pinned?.scene as ArtifactHash;

    // What was made straight from the video, frames first, including before any blurring.
    const sampled = await systemRecipesTaking(db, filmed.video.hash);
    const frameSet = sampled.flatMap((x) => x.jsonOutputs)[0] as ArtifactHash;
    expect(frameSet).toBeTruthy();
    const frameHashes = (
      JSON.parse(new TextDecoder().decode((await store.get(frameSet)) as Uint8Array)) as {
        frames: { image: { hash: ArtifactHash } }[];
      }
    ).frames.map((f) => f.image.hash);
    expect(frameHashes.length).toBeGreaterThan(0);
    for (const h of frameHashes) expect(await store.has(h)).toBe(true);

    // Someone else in the city can't.
    expect(await remove(other.userId, "abcdef01")).toEqual({
      ok: false,
      reason: "That isn't yours to remove.",
    });
    expect(await getPinnedPlace(db, other, world, key)).not.toBeNull();
    expect(await store.has(filmed.video.hash)).toBe(true);

    // Whoever filmed it can.
    expect(await remove(player.userId, "abcdef02")).toMatchObject({ ok: true });
    expect(await getPinnedPlace(db, other, world, key)).toBeNull();
    const world2 = await systemGetWorld(db, world);
    const city = CitySpec.parse(
      JSON.parse(
        new TextDecoder().decode((await store.get(world2?.city as ArtifactHash)) as Uint8Array),
      ),
    );
    expect(city.items.some((i) => i.key === key)).toBe(false);
    expect(await systemGetCapture(db, filmed.id)).toBeNull();
    // The video, and what was made from it, are really gone.
    expect(await store.has(filmed.video.hash)).toBe(false);
    expect(await store.has(scene)).toBe(false);
    expect(await store.has(frameSet)).toBe(false);
    for (const h of frameHashes) expect(await store.has(h)).toBe(false);
    // Nothing can replay it either.
    expect(await systemRecipesTaking(db, filmed.video.hash)).toEqual([]);
    expect(await canReadArtifact(db, other, scene)).toBe(false);
    // And it's done: a second try finds nothing.
    expect((await remove(player.userId, "abcdef03")).ok).toBe(false);
  });

  it("lets the city's owner take away what was filmed there, and no more", async () => {
    const filmed = await film("a video the city owner removes");
    const base = deps();
    const r = await runCaptureJob(
      { worldId: world, captureId: filmed.id, note: "", at: [38, 38] },
      base,
    );
    const key = r?.placeKey as string;
    expect(await listRemovablePlaceKeys(db, other, world)).not.toContain(key);
    expect(await listRemovablePlaceKeys(db, owner, world)).toContain(key);
    expect(await listRemovablePlaceKeys(db, player, world)).toContain(key);
    expect(
      await runRemoveJob(
        { worldId: world, place: key, userId: owner.userId, nonce: "abcdef04" },
        { db, store },
      ),
    ).toMatchObject({ ok: true });
    expect(await getPinnedPlace(db, owner, world, key)).toBeNull();
  });

  it("keeps what another place still uses, even when it's only named inside it", async () => {
    const filmed = await film("a video whose picture another place shares");
    const r = await runCaptureJob(
      { worldId: world, captureId: filmed.id, note: "", at: [44, 44] },
      deps(),
    );
    const key = r?.placeKey as string;
    const made = await systemRecipesTaking(db, filmed.video.hash);
    const frames = made.flatMap((x) => x.jsonOutputs)[0] as ArtifactHash;
    // The live city names something made from this video, inside itself.
    const before = await systemGetWorld(db, world);
    const city = JSON.parse(
      new TextDecoder().decode((await store.get(before?.city as ArtifactHash)) as Uint8Array),
    );
    const sharing = await store.put(encodeJson({ ...city, tagline: frames }), "application/json");
    await systemRecordArtifacts(db, [sharing]);
    await systemSetWorld(db, world, { city: sharing.hash });
    const result = await runRemoveJob(
      { worldId: world, place: key, userId: player.userId, nonce: "abcdef06" },
      { db, store },
    );
    expect(result).toMatchObject({ ok: true });
    // The place and its video are gone; what the city still names isn't.
    expect(await getPinnedPlace(db, other, world, key)).toBeNull();
    expect(await store.has(filmed.video.hash)).toBe(false);
    expect(await store.has(frames)).toBe(true);
    // Put the city back as it was for whatever comes next.
    const after = await systemGetWorld(db, world);
    const left = JSON.parse(
      new TextDecoder().decode((await store.get(after?.city as ArtifactHash)) as Uint8Array),
    );
    const restored = await store.put(
      encodeJson({ ...left, tagline: city.tagline }),
      "application/json",
    );
    await systemRecordArtifacts(db, [restored]);
    await systemSetWorld(db, world, { city: restored.hash });
  });

  it("leaves a video alone if someone else filmed the same bytes", async () => {
    const one = await film("the very same video");
    const two = await film("the very same video");
    const base = deps();
    const r = await runCaptureJob(
      { worldId: world, captureId: one.id, note: "", at: [40, 40] },
      base,
    );
    await runCaptureJob({ worldId: world, captureId: two.id, note: "", at: [41, 41] }, base);
    expect(
      await runRemoveJob(
        { worldId: world, place: r?.placeKey as string, userId: player.userId, nonce: "abcdef05" },
        { db, store },
      ),
    ).toMatchObject({ ok: true });
    expect(await store.has(two.video.hash)).toBe(true);
    expect(await systemGetCapture(db, two.id)).not.toBeNull();
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
