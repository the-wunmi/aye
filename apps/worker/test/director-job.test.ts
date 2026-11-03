/**
 * A world's director, against a real database with an offline model: it acts when it's time
 * and the world is ready, keeps its budget, waits its interval, never swaps a city that
 * changed under it, and keeps its notes to itself.
 */
import { fileURLToPath } from "node:url";
import { encodeJson, MemoryArtifactStore, MemoryRecipeIndex } from "@aye/artifacts";
import {
  connect,
  createCharacter,
  createWorld,
  type Db,
  getWorld,
  listMyThreads,
  registerUser,
  systemGetDirector,
  systemSetWorld,
} from "@aye/db";
import type { Director, DirectorDraft } from "@aye/pipeline";
import { type Character, type CharacterId, CitySpec, type UserId, type WorldId } from "@aye/schema";
import { sampleCity, sampleSettings, sampleSpec } from "@aye/schema/fixtures";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DirectorJobDeps, runDirectorTurn } from "../src/director-job.ts";

const url = process.env["DATABASE_URL"];

const answer = (n: number): DirectorDraft => ({
  aims: [],
  events: [
    {
      name: `Bus strike ${n}`,
      about: "Drivers stay home.",
      icon: "\u{1F6A7}",
      startsInMin: 0,
      lastsMin: 120,
      effects: [{ type: "halted", target: "Bus", permille: 1000 }],
    },
  ],
  end: [],
  headlines: [{ icon: "\u{1F68C}", text: `No buses today (${n})` }],
  threads: [
    {
      player: "Alice",
      title: `Save up ${n}`,
      about: "Put something by.",
      icon: "\u{1F4B0}",
      steps: [
        {
          check: "have_money",
          mark: "",
          place: "",
          action: "",
          person: "",
          amount: 100,
          text: "Save GHS 1",
        },
      ],
      dueInMin: 600,
      reward: 1_000,
      onDone: [],
      onMissed: [],
    },
  ],
  memory: `secret plan ${n}`,
});

describe.skipIf(!url)("the director", () => {
  const dbName = `aye_director_test_${process.pid}_${Date.now()}`;
  const alice = { kind: "user" as const, userId: "usr_alice" as UserId };
  const world = "wld_direct" as WorldId;
  let admin: ReturnType<typeof postgres>;
  let conn: ReturnType<typeof connect>;
  let db: Db;
  const store = new MemoryArtifactStore();
  let calls = 0;
  const director: Director = {
    model: { provider: "test", model: "director", version: "1" },
    prompt: "direct",
    effort: "low",
    async direct() {
      calls++;
      return answer(calls);
    },
  };
  let clock = 0;
  const deps = (over: Partial<DirectorJobDeps> = {}): DirectorJobDeps => ({
    db,
    store,
    index: new MemoryRecipeIndex(),
    director,
    // Three a day: the threads-only turn while it was building, and two full turns.
    config: { everyMin: 180, callsPerDay: 3 },
    now: () => clock,
    building: async () => false,
    ...over,
  });
  const cityOf = async () => {
    const w = await getWorld(db, alice, world);
    const bytes = await store.get(w?.city as never);
    return CitySpec.parse(JSON.parse(new TextDecoder().decode(bytes as Uint8Array)));
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
    await registerUser(db, { id: alice.userId, handle: "alice", password: "alice password" });
    const created = await createWorld(db, alice, {
      id: world,
      name: "Testville",
      description: "A small test town",
      currency: "NGN",
      visibility: "public",
      settings: sampleSettings,
    });
    // Alice plays here: she's around for the director to give a thread to.
    await createCharacter(db, alice, {
      id: "chr_alice" as CharacterId,
      worldId: world,
      vehicle: null,
      billed: { day: -1, owes: 0 },
      home: null,
      person: { ...(sampleSpec.people[0] as Character["person"]), key: "p_alice", name: "Alice" },
      start: "fresh_start",
      place: null,
      transit: null,
    });
    const city = await store.put(encodeJson(sampleCity), "application/json");
    await systemSetWorld(db, world, { city: city.hash });
    // The clock starts when the world does, on a fixed morning: budgets run by the date, so
    // a real clock would fail this just before midnight.
    await db.execute(
      sql`update worlds set created_at = '2026-01-15T06:00:00Z' where id = ${world}`,
    );
    const row = await getWorld(db, alice, world);
    clock = Date.parse(row?.createdAt ?? created.id);
  }, 60_000);

  afterAll(async () => {
    await conn?.close();
    await admin?.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
  });

  it("waits while the city is still being built or isn't ready", async () => {
    expect((await runDirectorTurn({ worldId: world }, deps())).reason).toBe("not ready");
    await systemSetWorld(db, world, { status: "ready" });
    // While it's still being finished, only threads (the city's spec may change under it).
    const r = await runDirectorTurn({ worldId: world }, deps({ building: async () => true }));
    expect(r.reason).toBe("threads only (1)");
    expect(calls).toBe(1);
    expect(await cityOf()).toEqual(sampleCity);
    calls = 0;
    // A welcome for someone who already has something to do: nothing to say, no call.
    const w = await runDirectorTurn({ worldId: world, welcome: "usr_alice" }, deps());
    expect(w.reason).toBe("nobody to welcome");
    expect(calls).toBe(0);
  });

  it("acts on its own: events and headlines on the world's city, notes kept to itself", async () => {
    const r = await runDirectorTurn({ worldId: world }, deps());
    expect(r.status).toBe("acted");
    const city = await cityOf();
    expect(city.events.map((e) => e.name)).toEqual(["Bus strike 1"]);
    expect(city.headlines[0]?.text).toBe("No buses today (1)");
    // Its notes are its own: kept apart, never in what players read.
    expect((await systemGetDirector(db, world)).memory).toBe("secret plan 1");
    expect(JSON.stringify(city)).not.toContain("secret plan");
    // A thread for the player who's around, theirs alone.
    const mine = await listMyThreads(db, alice, world);
    expect(mine.map((t) => t.title)).toEqual(["Save up 1"]);
  });

  it("takes no paid turn for a city nobody has been in lately", async () => {
    const before = calls;
    const later = Date.now() + 2 * 3600 * 1000;
    const r = await runDirectorTurn(
      { worldId: world },
      deps({ config: { everyMin: 180, callsPerDay: null }, now: () => later }),
    );
    expect(r.reason).toBe("nobody around");
    expect(calls).toBe(before);
  });

  it("waits its interval, and keeps to its daily budget", async () => {
    expect((await runDirectorTurn({ worldId: world }, deps())).reason).toBe("not time yet");
    // Three city hours on (ten city minutes a real minute): its second and last call today.
    clock += 18 * 60_000;
    expect((await runDirectorTurn({ worldId: world }, deps())).status).toBe("acted");
    clock += 18 * 60_000;
    expect((await runDirectorTurn({ worldId: world }, deps())).reason).toBe("out of budget today");
    // No budget: no limit.
    const r = await runDirectorTurn(
      { worldId: world },
      deps({ config: { everyMin: 180, callsPerDay: null } }),
    );
    expect(r.status).toBe("acted");
    expect(calls).toBe(3);
  });

  it("never swaps a city that changed while it thought", async () => {
    clock += 18 * 60_000;
    const before = (await systemGetDirector(db, world)).memory;
    const sneaky = deps({ config: { everyMin: 180, callsPerDay: null } });
    const racing: DirectorJobDeps = {
      ...sneaky,
      director: {
        ...director,
        async direct() {
          // Someone else writes the city in the meantime.
          const other = await store.put(
            encodeJson({ ...sampleCity, name: "Rebuilt" }),
            "application/json",
          );
          await systemSetWorld(db, world, { city: other.hash });
          calls++;
          return answer(calls);
        },
      },
    };
    const r = await runDirectorTurn({ worldId: world }, racing);
    expect(r.status).toBe("skipped");
    expect((await cityOf()).name).toBe("Rebuilt");
    // Its old notes stand, and it looks again soon.
    expect((await systemGetDirector(db, world)).memory).toBe(before);
  });

  it("lets threads that ran out of time go, and gives a returning player a new one", async () => {
    // Long after every thread so far was due (they had ten city hours).
    clock += 3 * 24 * 6 * 60_000;
    const r = await runDirectorTurn(
      { worldId: world, welcome: "usr_alice" },
      deps({ config: { everyMin: 180, callsPerDay: null } }),
    );
    expect(r.reason).toMatch(/^threads only/);
    const mine = await listMyThreads(db, alice, world);
    const open = mine.filter((t) => t.state === "open");
    expect(open).toHaveLength(1);
    expect(mine.filter((t) => t.state === "missed").length).toBeGreaterThan(0);
  });
});
