/**
 * Building a whole city with offline models: the city is written, every place on it is laid
 * out and given a world, pinned into the world, and the world becomes playable. A second run
 * makes no model calls and builds nothing twice.
 */
import { fileURLToPath } from "node:url";
import { MemoryArtifactStore } from "@aye/artifacts";
import {
  canReadArtifact,
  connect,
  createWorld,
  type Db,
  getPinnedPlace,
  getWorld,
  joinWorld,
  registerUser,
  systemGetWorld,
  systemSetWorld,
} from "@aye/db";
import {
  fakeCalls,
  fakeCityAuthor,
  fakeDescriber,
  fakeLookCritic,
  fakeLookDesigner,
  fakeWorldAuthor,
  understandingFromScene,
} from "@aye/pipeline/fake";
import {
  type ArtifactHash,
  type CitySpec,
  placesOf,
  type UserId,
  type WorldId,
  WorldSpec,
} from "@aye/schema";
import { sampleCity, sampleFlat, sampleSettings } from "@aye/schema/fixtures";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAskJob } from "../src/ask-job.ts";
import { runCityJob } from "../src/city-job.ts";
import { runMoveJob } from "../src/move-job.ts";

const url = process.env["DATABASE_URL"];

/** The sample city with enough public places to be worth playing. */
const spot = sampleCity.items.find((i) => i.key === "mama_s_spot")!;
const playableCity: CitySpec = {
  ...sampleCity,
  items: [
    ...sampleCity.items,
    ...["market", "beach", "hub"].map((key, i) => ({
      ...spot,
      key,
      name: key,
      where: { ...spot.where, at: [300 + i * 400, 1700] as [number, number] },
      // Somewhere has to be open whenever someone turns up.
      traits: { ...spot.traits, place: { hours: null } },
    })),
  ],
};

describe.skipIf(!url)("city build job", () => {
  const dbName = `aye_city_test_${process.pid}_${Date.now()}`;
  const alice = { kind: "user" as const, userId: "usr_alice" as UserId };
  const bob = { kind: "user" as const, userId: "usr_bob" as UserId };
  let admin: ReturnType<typeof postgres>;
  let conn: ReturnType<typeof connect>;
  let db: Db;
  const store = new MemoryArtifactStore();
  const calls = fakeCalls();
  const understanding = understandingFromScene(sampleFlat);
  const providers = {
    city: fakeCityAuthor(calls, playableCity),
    critic: fakeLookCritic(),
    designer: fakeLookDesigner(),
    get quick() {
      return { city: this.city, describer: this.describer, author: this.author };
    },
    describer: fakeDescriber(understanding, calls),
    author: fakeWorldAuthor(calls),
  };
  const world = "wld_town" as WorldId;

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
    await registerUser(db, { id: alice.userId, handle: "alice", password: "alice password" });
    await registerUser(db, { id: bob.userId, handle: "bob", password: "bob password!!" });
    await createWorld(db, alice, {
      id: world,
      name: "Building…",
      description: "A small test town",
      currency: "NGN",
      visibility: "public",
      settings: sampleSettings,
    });
  }, 60_000);

  afterAll(async () => {
    await conn?.close();
    await admin?.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
  });

  it("writes the city, builds and pins every place, and opens the world", async () => {
    // Record whether the world was already open as each step began.
    const openAt = new Map<string, boolean>();
    const step = async <T>(name: string, fn: () => Promise<T>) => {
      openAt.set(name, (await getWorld(db, alice, world))?.status === "ready");
      return fn();
    };
    const result = await runCityJob(
      { worldId: world },
      { db, store, providers, signal: new AbortController().signal, step },
    );
    // People can play once a home and the nearest public place stand; the rest come after.
    expect(openAt.get("place:your_flat")).toBe(false);
    expect(openAt.get("place:market")).toBe(true);
    expect(openAt.get("dress-city")).toBe(true);
    expect(result).toMatchObject({ status: "ready", missing: [] });
    const detail = await getWorld(db, alice, world);
    // Someone waiting read what the model wrote, and code only chose how far along to show.
    expect(sampleCity.buildingLines).toContain(detail?.buildNote);
    expect(detail?.status).toBe("ready");
    expect(detail?.name).toBe("Testville");
    expect(detail?.places.map((p) => p.key).sort()).toEqual(
      placesOf(playableCity)
        .map((p) => p.key)
        .sort(),
    );
    // Members can read the city spec; someone outside can't, until they join.
    const cityHash = detail?.city;
    expect(cityHash).toBeTruthy();
    expect(await canReadArtifact(db, alice, cityHash!)).toBe(true);
    expect(await canReadArtifact(db, bob, cityHash!)).toBe(false);
    expect(await joinWorld(db, bob, world)).toBe("player");
    expect(await canReadArtifact(db, bob, cityHash!)).toBe(true);
  });

  it("a rerun calls no models and builds nothing twice", async () => {
    const before = { ...calls };
    const result = await runCityJob(
      { worldId: world },
      { db, store, providers, signal: new AbortController().signal },
    );
    expect(result.status).toBe("ready");
    expect(calls).toEqual(before);
  });

  it("never redesigns a city that exists, even if its author would now write another", async () => {
    const cityBefore = (await getWorld(db, alice, world))?.city;
    // A different model version: no cached answer can stand in for the redesign.
    const base = fakeCityAuthor(fakeCalls(), { ...playableCity, name: "Elsewhere" });
    const otherAuthor = { ...base, model: { ...base.model, version: "redesigned" } };
    const result = await runCityJob(
      { worldId: world, phase: "finish" },
      {
        db,
        store,
        providers: {
          ...providers,
          city: otherAuthor,
          quick: { ...providers.quick, city: otherAuthor },
        },
        signal: new AbortController().signal,
      },
    );
    expect(result.status).toBe("ready");
    const after = await getWorld(db, alice, world);
    expect(after?.city).toBe(cityBefore);
    expect(after?.name).toBe("Testville");
  });

  it("asking a thing for something new commits and pins a new revision of the place", async () => {
    const before = await getPinnedPlace(db, alice, world, "mama_s_spot");
    expect(before?.spec).toBeTruthy();
    const read = async (hash: ArtifactHash) =>
      WorldSpec.parse(
        JSON.parse(new TextDecoder().decode((await store.get(hash)) ?? new Uint8Array())),
      );
    const object = (await read(before?.spec as ArtifactHash)).things[0]?.object as string;
    const result = await runAskJob(
      {
        worldId: world,
        place: "mama_s_spot",
        object,
        request: "chill my drink",
        nonce: "abcdef12",
      },
      {
        db,
        store,
        providers: {
          author: providers.author,
          critic: providers.critic,
          designer: providers.designer,
        },
        signal: new AbortController().signal,
      },
    );
    expect(result).toMatchObject({ ok: true, added: ["chill my drink"] });
    const after = await getPinnedPlace(db, alice, world, "mama_s_spot");
    expect(after?.revision).not.toBe(before?.revision);
    const spec = await read(after?.spec as ArtifactHash);
    const kind = spec.kinds.find(
      (k) => k.key === spec.things.find((t) => t.object === object)?.kind,
    );
    expect(kind?.actions.some((a) => a.label === "chill my drink")).toBe(true);
  });

  it("asking in a place someone else filmed keeps it standing, under its own owner", async () => {
    const before = await getPinnedPlace(db, alice, world, "mama_s_spot");
    const placeId = before?.placeId as string;
    await db.execute(sql`update places set owner_id = ${bob.userId} where id = ${placeId}`);
    try {
      const spec = WorldSpec.parse(
        JSON.parse(
          new TextDecoder().decode(
            (await store.get(before?.spec as ArtifactHash)) ?? new Uint8Array(),
          ),
        ),
      );
      const result = await runAskJob(
        {
          worldId: world,
          place: "mama_s_spot",
          object: spec.things[0]?.object as string,
          request: "polish this",
          nonce: "abcdef34",
        },
        {
          db,
          store,
          providers: {
            author: providers.author,
            critic: providers.critic,
            designer: providers.designer,
          },
          signal: new AbortController().signal,
        },
      );
      expect(result).toMatchObject({ ok: true });
      // A pin that points at nothing would make this null: nobody could go in.
      const after = await getPinnedPlace(db, alice, world, "mama_s_spot");
      expect(after?.spec).toBeTruthy();
      expect(after?.revision).not.toBe(before?.revision);
    } finally {
      await db.execute(sql`update places set owner_id = ${alice.userId} where id = ${placeId}`);
    }
  });

  it("moving a thing saves it as an edit, and refuses what can't be", async () => {
    const before = await getPinnedPlace(db, alice, world, "mama_s_spot");
    const read = async (hash: ArtifactHash) =>
      JSON.parse(new TextDecoder().decode((await store.get(hash)) ?? new Uint8Array())) as {
        objects: { id: string; transform: { position: number[]; yawDeg: number } }[];
        spaces: { polygon: number[][] }[];
      };
    const scene = await read(before?.scene as ArtifactHash);
    const object = scene.objects.find((o) => (o.transform.position[1] ?? 0) === 0);
    const [x = 0, , z = 0] = object?.transform.position ?? [];
    const yawDeg = Math.round(object?.transform.yawDeg ?? 0);
    const job = (
      to: { xMm: number; zMm: number; yawDeg: number },
      userId: string = alice.userId,
    ) => ({
      worldId: world,
      place: "mama_s_spot",
      moves: [{ object: object?.id, ...to }],
      userId,
      nonce: "abcdef99",
    });

    // Not theirs, and through the wall: nothing happens.
    expect(await runMoveJob(job({ xMm: x, zMm: z, yawDeg }, bob.userId), { db, store })).toEqual({
      ok: false,
      reason: "That isn't yours to move.",
    });
    expect(
      await runMoveJob(job({ xMm: 9_000_000, zMm: 9_000_000, yawDeg }), { db, store }),
    ).toMatchObject({ ok: false });
    expect((await getPinnedPlace(db, alice, world, "mama_s_spot"))?.revision).toBe(
      before?.revision,
    );

    // Somewhere it fits: found by trying, the way a hand would.
    let moved: Awaited<ReturnType<typeof runMoveJob>> = { ok: false, reason: "" };
    let to = { xMm: x, zMm: z, yawDeg };
    for (let r = 100; r <= 3000 && !moved.ok; r += 100) {
      for (const [dx, dz] of [
        [r, 0],
        [-r, 0],
        [0, r],
        [0, -r],
      ] as const) {
        to = { xMm: x + dx, zMm: z + dz, yawDeg };
        moved = await runMoveJob(job(to), { db, store });
        if (moved.ok) break;
      }
    }
    expect(moved.ok).toBe(true);
    const after = await getPinnedPlace(db, alice, world, "mama_s_spot");
    expect(after?.revision).not.toBe(before?.revision);
    // Still standing, with what it does untouched.
    expect(after?.spec).toBe(before?.spec);
    const nextScene = await read(after?.scene as ArtifactHash);
    const placed = nextScene.objects.find((o) => o.id === object?.id);
    expect(placed?.transform.position[0]).toBe(to.xMm);
    expect(placed?.transform.position[2]).toBe(to.zMm);
    expect(nextScene.objects).toHaveLength(scene.objects.length);
  });

  it("someone rearranging while a slow ask runs keeps both", async () => {
    const before = await getPinnedPlace(db, alice, world, "mama_s_spot");
    const read = async (hash: ArtifactHash) =>
      JSON.parse(new TextDecoder().decode((await store.get(hash)) ?? new Uint8Array()));
    const scene = await read(before?.scene as ArtifactHash);
    const spec = WorldSpec.parse(await read(before?.spec as ArtifactHash));
    const object = spec.things[0]?.object as string;
    const thing = scene.objects.find(
      (o: { transform: { position: number[] } }) => (o.transform.position[1] ?? 0) === 0,
    );
    const [x = 0, , z = 0] = thing.transform.position as number[];
    let to: { xMm: number; zMm: number; yawDeg: number } | null = null;
    // While the model is thinking, the owner moves something.
    const author = {
      ...providers.author,
      improvise: async (...args: Parameters<typeof providers.author.improvise>) => {
        for (let r = 100; r <= 3000 && !to; r += 100) {
          for (const [dx, dz] of [
            [r, 0],
            [-r, 0],
            [0, r],
            [0, -r],
          ] as const) {
            const tryTo = { xMm: x + dx, zMm: z + dz, yawDeg: Math.round(thing.transform.yawDeg) };
            const moved = await runMoveJob(
              {
                worldId: world,
                place: "mama_s_spot",
                moves: [{ object: thing.id, ...tryTo }],
                userId: alice.userId,
                nonce: "abcdef77",
              },
              { db, store },
            );
            if (moved.ok) {
              to = tryTo;
              break;
            }
          }
        }
        return providers.author.improvise(...args);
      },
    };
    const result = await runAskJob(
      {
        worldId: world,
        place: "mama_s_spot",
        object,
        request: "dust this down",
        nonce: "abcdef78",
      },
      {
        db,
        store,
        providers: { author, critic: providers.critic, designer: providers.designer },
        signal: new AbortController().signal,
      },
    );
    expect(result).toMatchObject({ ok: true });
    expect(to).not.toBeNull();
    const after = await getPinnedPlace(db, alice, world, "mama_s_spot");
    const nextScene = await read(after?.scene as ArtifactHash);
    const placed = nextScene.objects.find((o: { id: string }) => o.id === thing.id);
    // The move survived the ask, and the ask survived the move.
    expect(placed.transform.position[0]).toBe((to as unknown as { xMm: number }).xMm);
    const nextSpec = WorldSpec.parse(await read(after?.spec as ArtifactHash));
    const kind = nextSpec.kinds.find(
      (k) => k.key === nextSpec.things.find((t) => t.object === object)?.kind,
    );
    expect(kind?.actions.some((a) => a.label === "dust this down")).toBe(true);
  });

  it("asking about something that isn't there changes nothing", async () => {
    const result = await runAskJob(
      {
        worldId: world,
        place: "mama_s_spot",
        object: "obj_nothing",
        request: "fly",
        nonce: "abcdef13",
      },
      {
        db,
        store,
        providers: {
          author: providers.author,
          critic: providers.critic,
          designer: providers.designer,
        },
        signal: new AbortController().signal,
      },
    );
    expect(result.ok).toBe(false);
  });

  it("a quick pass opens the city and hands the slow passes on, without doing them", async () => {
    const handed: unknown[] = [];
    let inStep = 0;
    const before = { ...providers.critic };
    const result = await runCityJob(
      { worldId: world, phase: "quick" },
      {
        db,
        store,
        providers,
        signal: new AbortController().signal,
        // Like DBOS: starting a workflow from inside a step is not allowed.
        step: async (_name, fn) => {
          inStep++;
          try {
            return await fn();
          } finally {
            inStep--;
          }
        },
        finishLater: async (next) => {
          expect(inStep).toBe(0);
          handed.push(next);
        },
      },
    );
    expect(result.status).toBe("ready");
    expect(handed).toEqual([{ worldId: world, phase: "finish" }]);
    // No dressing happened in the quick pass.
    expect(providers.critic.calls).toBe(before.calls);
  });

  it("a crash fails a city nobody can enter, and leaves an open one alone", async () => {
    const crash = {
      db,
      store,
      providers,
      signal: new AbortController().signal,
      step: async () => {
        throw new Error("boom");
      },
    };
    await systemSetWorld(db, world, { status: "building" });
    await expect(runCityJob({ worldId: world, phase: "quick" }, crash)).rejects.toThrow("boom");
    expect((await systemGetWorld(db, world))?.status).toBe("failed");
    await systemSetWorld(db, world, { status: "ready" });
    await expect(runCityJob({ worldId: world, phase: "quick" }, crash)).rejects.toThrow("boom");
    expect((await systemGetWorld(db, world))?.status).toBe("ready");
  });

  it("shutting down mid-build isn't a failure", async () => {
    const stop = new AbortController();
    stop.abort();
    await systemSetWorld(db, world, { status: "building" });
    await expect(
      runCityJob(
        { worldId: world, phase: "quick" },
        {
          db,
          store,
          providers,
          signal: stop.signal,
          step: async () => {
            throw new Error("aborted");
          },
        },
      ),
    ).rejects.toThrow("aborted");
    expect((await systemGetWorld(db, world))?.status).toBe("building");
    await systemSetWorld(db, world, { status: "ready" });
  });

  it("refuses malformed jobs at the boundary", async () => {
    await expect(
      runCityJob(
        { worldId: "../etc" },
        { db, store, providers, signal: new AbortController().signal },
      ),
    ).rejects.toThrow();
  });
});
