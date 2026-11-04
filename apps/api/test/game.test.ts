/**
 * The game end to end against real Postgres, a real HTTP server and real WebSockets: accounts
 * and sessions, cross-site protection, cities, characters, and the realm (who may connect,
 * travel, shared rooms, chat, and who may command whom). Skipped without DATABASE_URL.
 */

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeJson, hashBytes, hashJson, MemoryArtifactStore } from "@aye/artifacts";
import {
  connect,
  type Db,
  getMyCharacter,
  getPinnedPlace,
  getWorld,
  saveCharacter,
  systemAddThread,
  systemCommitRevision,
  systemEnsurePlace,
  systemGetPinnedPlace,
  systemGetWorld,
  systemLinkWorldArtifacts,
  systemPinPlace,
  systemRecordArtifacts,
  systemSetWorld,
  systemSwapWorldCity,
  tables,
} from "@aye/db";
import {
  type ArtifactHash,
  CitySpec,
  ClientMessage,
  cityMinuteNow,
  moversOf,
  type PlaceId,
  type PlaceRevision,
  placesOf,
  type Scene,
  type ServerMessage,
  type UserId,
} from "@aye/schema";
import { sampleCity, sampleFlat, sampleSpec } from "@aye/schema/fixtures";
import { Sim } from "@aye/sim";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createApp } from "../src/app.ts";
import { contentLoader } from "../src/content.ts";
import { loadEnv } from "../src/env.ts";
import { cleanChat, Realm, SELF_CARE_AFTER_MS } from "../src/realm.ts";
import { attachRealm } from "../src/realm-server.ts";
import { VideoUploads } from "../src/uploads.ts";
import { isSpeechWav, MAX_KEYWORDS, speechKeywords } from "../src/voice.ts";

const url = process.env["DATABASE_URL"];
const ORIGIN = "http://localhost:5173";
/** Right-to-left override: built from its code point, never written into source. */
const RLO = String.fromCodePoint(0x202e);

/** The sample city with its food spot a short walk from home, so trips take seconds. */
const city: CitySpec = {
  ...sampleCity,
  items: sampleCity.items.map((i) =>
    i.key === "mama_s_spot"
      ? {
          ...i,
          where: { ...i.where, at: [650, 450] as [number, number] },
          traits: { place: { hours: null } },
        }
      : i,
  ),
};

describe("chat text", () => {
  it("loses control and invisible characters, and is capped", () => {
    expect(cleanChat(`  hi${RLO}there\u0000  \n friend `)).toBe("hi there friend");
    expect(cleanChat("x".repeat(500))).toHaveLength(280);
  });
});

describe.skipIf(!url)("the game", () => {
  const dbName = `aye_game_test_${process.pid}_${Date.now()}`;
  let admin: ReturnType<typeof postgres>;
  let conn: ReturnType<typeof connect>;
  let db: Db;
  let server: Server;
  let base: string;
  let realm: Realm;
  const homesAsked: string[] = [];
  const movesAsked: { userId: string; job: unknown }[] = [];
  const placesChanged: string[] = [];
  let content: ReturnType<typeof contentLoader>;
  const store = new MemoryArtifactStore();
  const enqueued: string[] = [];
  const asked: string[] = [];
  const questioned: { placeKey: string; question: string }[] = [];
  const heard: { bytes: number; keywords: readonly string[] }[] = [];
  const captures: { worldId: string; captureId: string; note: string; at: number[] }[] = [];
  const cookies: Record<string, string> = {};
  let worldId = "";
  const replyRequests: import("../src/realm.ts").ReplyRequest[] = [];

  const call = async (who: string | null, path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        ...(who && cookies[who] ? { cookie: cookies[who] } : {}),
        ...init.headers,
      },
    });
  const post = (who: string | null, path: string, body: unknown) =>
    call(who, path, { method: "POST", body: JSON.stringify(body) });

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
    const env = loadEnv({
      ALLOW_ANONYMOUS: "1",
      NODE_ENV: "test",
      DATABASE_URL: testUrl.toString(),
      WEB_ORIGIN: ORIGIN,
    });
    content = contentLoader(store);
    const app = createApp({
      env,
      db,
      store,
      content,
      enqueueCity: async (id) => {
        enqueued.push(id);
      },
      enqueueCapture: async (job) => {
        captures.push(job);
      },
      questions: {
        enqueue: async (userId, job) => {
          questioned.push(job);
          return `question-${userId}-${job.nonce}`;
        },
        status: async () => ({
          status: "done" as const,
          result: { ok: true as const, answer: { answer: "Yes." } },
        }),
      },
      transcribe: async (wav, keywords) => {
        heard.push({ bytes: wav.byteLength, keywords });
        if (wav.byteLength > 100) throw new Error("model down");
        return `  good morning${RLO}  Auntie `;
      },
      moves: {
        enqueue: async (userId, job) => {
          movesAsked.push({ userId, job });
          return `move-${userId}-abcdef12`;
        },
        status: async (id) =>
          id.endsWith("-donedone")
            ? {
                status: "done" as const,
                result: { ok: true as const, worldId: "wld_told", place: "told_place" },
              }
            : { status: "working" as const },
      },
      onPlaceChanged: (world, place) => placesChanged.push(`${world}/${place}`),
      uploads: new VideoUploads(
        join(tmpdir(), `aye-uploads-${process.pid}-${Date.now()}`),
        300 * 1024 * 1024,
      ),
      removals: {
        enqueue: async (userId) => `remove-${userId}-abcdef12`,
        status: async (id) =>
          id.endsWith("-donedone")
            ? {
                status: "done" as const,
                result: { ok: true as const, worldId: "wld_gone", place: "gone_place" },
              }
            : { status: "working" as const },
      },
      asks: {
        enqueue: async (userId) => {
          asked.push(userId);
          return `ask-${userId}-abcdef12`;
        },
        status: async () => ({ status: "working" as const }),
      },
      homes: {
        enqueue: async (userId) => {
          homesAsked.push(userId);
          return `home-${userId}-abcdef12`;
        },
        status: async () => ({
          status: "done" as const,
          result: {
            ok: true as const,
            say: "A nice sofa",
            price: 500,
            added: ["Sofa"],
            moved: [],
            removed: [],
            // What the worker keeps for the server: the player must never see these.
            scene: "secret_scene",
            spec: "secret_spec",
            base: "secret_base",
          } as never,
        }),
      },
    });
    realm = new Realm({
      db,
      content,
      // The people of a place answer (an offline stand-in for the model): only when asked.
      replies: async (r) => {
        replyRequests.push(r);
        const who = r.present[0];
        if (!who) return null;
        if (r.said.includes("anyone home")) {
          return { person: who, name: "Someone", text: `Welcome, ${r.playerName}!` };
        }
        if (r.said.includes("get a snack")) {
          return {
            person: who,
            name: "Someone",
            text: "Going now.",
            does: { kind: "fridge", action: "snack", label: "Grab a snack" },
          };
        }
        if (r.said.includes("join in")) {
          return {
            person: who,
            name: "Someone",
            text: "Right.",
            does: { kind: "no_such_kind", action: "nope", label: "Nothing real" },
            alsoSaid: [
              { person: who, name: "Someone", text: "And another thing." },
              { person: "not_here", name: "Nobody", text: "I'm not here." },
            ],
          };
        }
        // Offers: one the place really has, and one it doesn't.
        if (r.said.includes("hungry")) {
          return {
            person: who,
            name: "Someone",
            text: "Cook something.",
            offer: { kind: "fridge", action: "snack", label: "Have a snack" },
          };
        }
        if (r.said.includes("rich")) {
          return {
            person: who,
            name: "Someone",
            text: "Here's a fortune.",
            offer: { kind: "vault", action: "take_all", label: "Take the money" },
          };
        }
        return null;
      },
    });
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    attachRealm(server, { db, content, realm, origins: [ORIGIN] });
  }, 60_000);

  afterAll(async () => {
    for (const ws of sockets) ws.terminate();
    await realm?.stop();
    server?.closeAllConnections();
    await new Promise((r) => server?.close(r));
    await conn?.close();
    await admin?.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
  });

  // ── Accounts ──────────────────────────────────────────────────────────────────────

  it("signs up with an HttpOnly, SameSite session cookie, and knows who you are", async () => {
    for (const handle of ["alice", "bob", "carol"]) {
      const res = await post(null, "/auth/register", { handle, password: `${handle}-password` });
      expect(res.status).toBe(201);
      const cookie = res.headers.get("set-cookie") ?? "";
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      cookies[handle] = cookie.split(";")[0] as string;
    }
    expect(await (await call("alice", "/me")).json()).toEqual({ handle: "alice", guest: false });
    expect((await call(null, "/me")).status).toBe(401);
    expect(
      (await post(null, "/auth/register", { handle: "ALICE", password: "another-password" }))
        .status,
    ).toBe(409);
    expect((await post(null, "/auth/register", { handle: "x", password: "short" })).status).toBe(
      400,
    );
  });

  it("logs in only with the right password, and logs out for real", async () => {
    expect(
      (await post(null, "/auth/login", { handle: "alice", password: "wrong-password" })).status,
    ).toBe(401);
    const res = await post(null, "/auth/login", { handle: "Alice", password: "alice-password" });
    expect(res.status).toBe(200);
    const extra = (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
    expect((await call(null, "/me", { headers: { cookie: extra } })).status).toBe(200);
    await call(null, "/auth/logout", { method: "POST", body: "{}", headers: { cookie: extra } });
    expect((await call(null, "/me", { headers: { cookie: extra } })).status).toBe(401);
  });

  it("refuses cross-site and non-JSON state changes", async () => {
    const evil = await call("alice", "/worlds", {
      method: "POST",
      body: JSON.stringify({ description: "a city from another site" }),
      headers: { origin: "https://evil.example" },
    });
    expect(evil.status).toBe(403);
    const form = await call("alice", "/worlds", {
      method: "POST",
      body: "description=a+city",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(form.status).toBe(415);
  });

  // ── Cities and characters ─────────────────────────────────────────────────────────

  it("creating a city queues its build; it stays private until ready and public", async () => {
    const res = await post("alice", "/worlds", {
      description: "A small test town by a lagoon",
      visibility: "public",
    });
    expect(res.status).toBe(201);
    worldId = ((await res.json()) as { world: { id: string } }).world.id;
    expect(enqueued).toEqual([worldId]);
    expect((await call("bob", `/worlds/${worldId}`)).status).toBe(404);
    expect((await call("bob", `/worlds/${worldId}/making`)).status).toBe(404);
    expect((await post("bob", `/worlds/${worldId}/join`, {})).status).toBe(404);

    // What the worker would do: write the city, build and pin its places, open it.
    const cityRef = await store.put(encodeJson(city), "application/json");
    const scene = await store.put(encodeJson(sampleFlat), "application/json");
    const spec = await store.put(encodeJson(sampleSpec), "application/json");
    await systemRecordArtifacts(db, [cityRef, scene, spec]);
    await systemLinkWorldArtifacts(db, worldId, [cityRef.hash]);
    for (const place of placesOf(city)) {
      const placeId = `plc_${place.key.replace(/_/g, "")}` as PlaceId;
      await systemEnsurePlace(db, { id: placeId, ownerId: (await alice()).id, name: place.name });
      const rev: PlaceRevision = {
        placeId,
        parent: null,
        base: scene,
        edits: [],
        scene,
        world: { spec, approved: false },
        authorId: (await alice()).id as UserId,
        message: "built",
        createdAt: new Date().toISOString(),
      };
      const hash = hashJson(rev) as ArtifactHash;
      await systemCommitRevision(db, rev.authorId, hash, rev, sampleFlat);
      await systemPinPlace(db, worldId, { key: place.key, placeId, revision: hash });
    }
    await systemSetWorld(db, worldId, { city: cityRef.hash, status: "ready", name: city.name });
    // A fast clock, so the short walk between places takes a couple of seconds.
    const [row] = await db.select().from(tables.worlds).where(eq(tables.worlds.id, worldId));
    await db
      .update(tables.worlds)
      .set({ settings: { ...(row?.settings as object), ticksPerRealSecond: 60 } as never })
      .where(eq(tables.worlds.id, worldId));
    expect((await post("bob", `/worlds/${worldId}/join`, {})).status).toBe(200);
    const detail = (await (await call("bob", `/worlds/${worldId}/city`)).json()) as {
      city: CitySpec;
      catalog: Record<string, { actions: unknown[] }>;
    };
    expect(detail.city.name).toBe("Testville");
    expect(Object.keys(detail.catalog).sort()).toEqual(["mama_s_spot", "your_flat"]);
    // Carol hasn't joined: she sees the world exists, but not inside it.
    expect((await call("carol", `/worlds/${worldId}/city`)).status).toBe(404);
    // She can see how much was written for it, as bare counts and nothing else.
    const making = await call("carol", `/worlds/${worldId}/making`);
    expect(making.status).toBe(200);
    const counts = (await making.json()) as Record<string, unknown>;
    expect(counts["places"]).toBe(placesOf(city).length);
    // Counted for a stranger too, not just for those who joined.
    expect(counts["actions"]).toBeGreaterThan(0);
    expect(Object.values(counts).every((v) => typeof v === "number")).toBe(true);
    expect((await call(null, `/worlds/${worldId}/making`)).status).toBe(401);
  });

  async function alice() {
    const [row] = await db.select().from(tables.users).where(eq(tables.users.handle, "alice"));
    return row as { id: string };
  }

  it("only a world's owner deletes it; everyone else gets not-found", async () => {
    const res = await post("alice", "/worlds", {
      description: "A town to throw away",
      visibility: "public",
    });
    const doomed = ((await res.json()) as { world: { id: string } }).world.id;
    const del = (who: string | null, id: string) =>
      call(who, `/worlds/${id}`, { method: "DELETE", body: "{}" });
    expect((await del(null, doomed)).status).toBe(401);
    expect((await del("bob", doomed)).status).toBe(404);
    expect((await del("alice", "not an id")).status).toBe(400);
    // Cross-site, or not JSON: refused before anything happens.
    const forged = await call("alice", `/worlds/${doomed}`, {
      method: "DELETE",
      headers: { origin: "https://evil.example" },
    });
    expect(forged.status).toBe(403);
    expect((await call("alice", `/worlds/${doomed}`)).status).toBe(200);
    expect((await del("alice", doomed)).status).toBe(200);
    expect((await call("alice", `/worlds/${doomed}`)).status).toBe(404);
    expect((await del("alice", doomed)).status).toBe(404);
  });

  it("won't start anyone in a home that isn't built yet", async () => {
    const res = await post("alice", "/worlds", {
      description: "A town whose homes aren't up yet",
      visibility: "private",
    });
    const unbuilt = ((await res.json()) as { world: { id: string } }).world.id;
    const cityRef = await store.put(encodeJson(city), "application/json");
    await systemRecordArtifacts(db, [cityRef]);
    await systemLinkWorldArtifacts(db, unbuilt, [cityRef.hash]);
    await systemSetWorld(db, unbuilt, { city: cityRef.hash, status: "ready", name: city.name });
    const pick = { name: "Ada", start: "fresh_start", skin: 1, top: 0, bottom: 2 };
    const made = await post("alice", `/worlds/${unbuilt}/character`, pick);
    expect(made.status).toBe(409);
    expect(await made.json()).toEqual({ error: "home_not_ready" });
  });

  it("characters are built by the server from the city's choices, one each", async () => {
    const pick = { name: "Ada", start: "fresh_start", skin: 1, top: 0, bottom: 2 };
    expect((await post("bob", `/worlds/${worldId}/character`, { ...pick, skin: 99 })).status).toBe(
      400,
    );
    expect(
      (await post("bob", `/worlds/${worldId}/character`, { ...pick, money: 1e9 })).status,
    ).toBe(400);
    expect(
      (await post("bob", `/worlds/${worldId}/character`, { ...pick, name: "<script>" })).status,
    ).toBe(400);
    const res = await post("bob", `/worlds/${worldId}/character`, { ...pick, name: "Bayo" });
    expect(res.status).toBe(201);
    const { character } = (await res.json()) as { character: { person: { money: number } } };
    expect(character.person.money).toBe(city.starts[0]?.money);
    // They start with something to work towards, as the city wrote it.
    const mine = (await (await call("bob", `/worlds/${worldId}/threads`)).json()) as {
      threads: { title: string; aim?: boolean }[];
    };
    expect(mine.threads.find((t) => t.aim)?.title).toBe(city.starts[0]?.aim?.title);
    expect((await post("bob", `/worlds/${worldId}/character`, pick)).status).toBe(409);
    expect((await post("alice", `/worlds/${worldId}/character`, pick)).status).toBe(201);
    expect((await post("carol", `/worlds/${worldId}/character`, pick)).status).toBe(404);
  });

  it("filming a place: players of the city only, and only they see how it's going", async () => {
    const send = (who: string | null, type: string, query = "", body = "video bytes") =>
      fetch(`${base}/worlds/${worldId}/captures${query}`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "content-type": type,
          ...(who ? { cookie: cookies[who] as string } : {}),
        },
        body,
      });
    // Not signed in; or signed in, but nobody who plays here (it doesn't exist for them).
    expect((await send(null, "video/mp4")).status).toBe(401);
    expect((await send("carol", "video/mp4")).status).toBe(404);
    // Only videos: anything else on this route still has to be JSON.
    expect((await send("bob", "text/plain")).status).toBe(415);
    expect((await send("bob", "application/x-www-form-urlencoded")).status).toBe(415);
    // Other sites can't send one, even with a real session.
    const forged = await fetch(`${base}/worlds/${worldId}/captures`, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "video/mp4",
        cookie: cookies["bob"] as string,
      },
      body: "video bytes",
    });
    expect(forged.status).toBe(403);
    // Video types don't open any other route.
    const elsewhere = await fetch(`${base}/worlds`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "video/mp4",
        cookie: cookies["bob"] as string,
      },
      body: "video bytes",
    });
    expect(elsewhere.status).toBe(415);
    // Malformed: unknown fields, an empty video.
    expect((await send("bob", "video/mp4", "?money=1000")).status).toBe(400);
    expect((await send("bob", "video/mp4", "?x=nope&z=1")).status).toBe(400);
    expect((await send("bob", "video/mp4", "", "")).status).toBe(400);
    expect(captures).toHaveLength(0);

    // A player: it's queued, kept on the map, and what they said goes with it.
    const res = await send("bob", "video/mp4", "?note=my%20kitchen&x=-50&z=999999");
    expect(res.status).toBe(202);
    const { capture } = (await res.json()) as { capture: { id: string } };
    expect(captures).toHaveLength(1);
    const job = captures[0]!;
    expect(job).toMatchObject({ worldId, captureId: capture.id, note: "my kitchen" });
    expect(job.at[0]).toBeGreaterThanOrEqual(0);
    expect(job.at[1]).toBeLessThanOrEqual(city.real?.extentM[1] ?? 4_000);
    // No spot chosen: a short way from where they are.
    const near = await send("bob", "video/mp4");
    expect(near.status).toBe(202);
    // Tapped right on top of somewhere that's already there: moved to open ground.
    const taken = placesOf(city)[0]!;
    const onTop = await send("bob", "video/mp4", `?x=${taken.at[0]}&z=${taken.at[1]}`);
    expect(onTop.status).toBe(202);
    const moved = captures[2]?.at as [number, number];
    expect(Math.hypot(moved[0] - taken.at[0], moved[1] - taken.at[1])).toBeGreaterThan(
      Math.max(...taken.sizeM),
    );
    // ...on open ground: never on top of something already there.
    const [ax, az] = captures[1]!.at as [number, number];
    for (const p of placesOf(city)) {
      expect(Math.hypot(p.at[0] - ax, p.at[1] - az)).toBeGreaterThan(Math.max(...p.sizeM));
    }

    // How it's going is theirs alone; to anyone else it isn't there.
    const path = `/worlds/${worldId}/captures/${capture.id}`;
    const mine = await call("bob", path);
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({ status: "uploaded", phase: null, placeKey: null });
    expect((await call("alice", path)).status).toBe(404);
    expect((await call(null, path)).status).toBe(401);
    // ...and under the wrong city, it isn't there either.
    expect((await call("bob", `/worlds/wld_nope/captures/${capture.id}`)).status).toBe(404);

    // The raw video is the owner's business: knowing its hash gets nobody anything.
    const [row] = await db.select().from(tables.captures).where(eq(tables.captures.id, capture.id));
    expect((await call("alice", `/artifacts/${row?.video}`)).status).toBe(404);
  });

  it("asking about a place: whoever can see it; the answer is the asker's alone", async () => {
    const path = `/worlds/${worldId}/places/mama_s_spot/questions`;
    const question = "Could a wheelchair user get around here?";
    expect((await post(null, path, { question })).status).toBe(401);
    // Malformed: unknown fields, too short, too long.
    expect((await post("bob", path, { question, money: 1 })).status).toBe(400);
    expect((await post("bob", path, { question: "x" })).status).toBe(400);
    expect((await post("bob", path, { question: "x".repeat(501) })).status).toBe(400);
    // A place that isn't there is just not there.
    const nowhere = await post("bob", `/worlds/${worldId}/places/nowhere/questions`, { question });
    expect(nowhere.status).toBe(404);
    expect(questioned).toHaveLength(0);

    const res = await post("bob", path, { question });
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: string };
    expect(questioned[0]).toMatchObject({ placeKey: "mama_s_spot", question });
    expect((await call("bob", `/questions/${job}`)).status).toBe(200);
    // Someone else's answer doesn't exist for you, nor does a made-up id.
    expect((await call("alice", `/questions/${job}`)).status).toBe(404);
    expect((await call(null, `/questions/${job}`)).status).toBe(401);
    expect((await call("bob", "/questions/question-usr_other-abc123")).status).toBe(404);
    expect((await call("bob", "/questions/..%2Fsecret")).status).toBe(404);
  });

  it("talking by voice: players only, real speech only, and nothing kept", async () => {
    const wav = (rate = 16_000, channels = 1, bits = 16, extra = 0) => {
      const b = new Uint8Array(44 + extra);
      const v = new DataView(b.buffer);
      b.set(new TextEncoder().encode("RIFF"), 0);
      b.set(new TextEncoder().encode("WAVEfmt "), 8);
      v.setUint16(20, 1, true);
      v.setUint16(22, channels, true);
      v.setUint32(24, rate, true);
      v.setUint16(34, bits, true);
      return b;
    };
    const send = (who: string | null, body: Uint8Array, type = "audio/wav", query = "") =>
      fetch(`${base}/worlds/${worldId}/voice${query}`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "content-type": type,
          ...(who ? { cookie: cookies[who] as string } : {}),
        },
        body,
      });
    expect((await send(null, wav())).status).toBe(401);
    expect((await send("carol", wav())).status).toBe(404);
    // Only audio on this route; audio on no other.
    expect((await send("bob", wav(), "text/plain")).status).toBe(415);
    const elsewhere = await fetch(`${base}/worlds`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "audio/wav", cookie: cookies["bob"] as string },
      body: wav(),
    });
    expect(elsewhere.status).toBe(415);
    // Not speech as the model takes it, or malformed: never sent.
    expect((await send("bob", new TextEncoder().encode("<script>"))).status).toBe(400);
    expect((await send("bob", wav(44_100))).status).toBe(400);
    expect((await send("bob", wav(16_000, 2))).status).toBe(400);
    expect((await send("bob", wav(), "audio/wav", "?money=1")).status).toBe(400);
    // A chunk that lies about its size can't send the check off the end of the file.
    const lying = wav();
    new DataView(lying.buffer).setUint32(16, 0xffffffff, true);
    lying.set(new TextEncoder().encode("JUNK"), 12);
    expect((await send("bob", lying)).status).toBe(400);
    expect(heard).toHaveLength(0);
    const before = (await db.select().from(tables.artifacts)).length;

    // Heard: cleaned like anything else that ends up in chat, and listening for the place's words.
    const res = await send("bob", wav(), "audio/wav", "?place=mama_s_spot");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "good morning Auntie" });
    expect(heard[0]?.keywords).toContain(city.name);
    // Nothing kept.
    expect((await db.select().from(tables.artifacts)).length).toBe(before);
    // Too much to be a sentence; and a model that's down gives no detail.
    expect((await send("bob", wav(16_000, 1, 16, 4 * 1024 * 1024))).status).toBe(413);
    const down = await send("bob", wav(16_000, 1, 16, 200));
    expect(down.status).toBe(502);
    expect(await down.json()).toEqual({ error: "not_heard" });
  });

  it("asking a thing: players of the world only, and only the asker sees the job", async () => {
    const ask = (who: string, body: unknown) =>
      post(who, `/worlds/${worldId}/places/mama_s_spot/ask`, body);
    const good = { object: "obj_fridge", request: "can I chill my drink here?" };
    expect((await ask("carol", good)).status).toBe(404);
    expect((await ask("bob", { ...good, extra: 1 })).status).toBe(400);
    expect((await ask("bob", { ...good, object: "../etc" })).status).toBe(400);
    const res = await ask("bob", good);
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: string };
    expect((await call("bob", `/asks/${job}`)).status).toBe(200);
    expect((await call("alice", `/asks/${job}`)).status).toBe(404);
    expect(asked).toHaveLength(1);
  });

  it("moving a thing: only in your own home or a place you own, and only a position", async () => {
    const object = "obj_anything";
    const one = { object, xMm: 1000, zMm: 2000, yawDeg: 90 };
    const good = { moves: [one] };
    const move = (who: string | null, place: string, body: unknown) =>
      post(who, `/worlds/${worldId}/places/${place}/move`, body);
    const shared = "mama_s_spot";

    // Nobody, a stranger to the city, and someone who plays here but doesn't own it.
    expect((await move(null, shared, good)).status).toBe(401);
    expect((await move("carol", shared, good)).status).toBe(404);
    expect((await move("bob", shared, good)).status).toBe(404);
    expect(movesAsked).toHaveLength(0);

    // A client names a position and nothing else.
    for (const bad of [
      { ...good, extra: 1 },
      { moves: [] },
      { moves: Array.from({ length: 65 }, () => one) },
      { moves: [{ ...one, extra: 1 }] },
      { moves: [{ ...one, xMm: 1.5 }] },
      { moves: [{ ...one, xMm: 1e12 }] },
      { moves: [{ ...one, yawDeg: 400 }] },
      { moves: [{ ...one, object: "../etc" }] },
      { moves: [{ xMm: 1, zMm: 2, yawDeg: 0 }] },
      one,
    ]) {
      expect((await move("alice", shared, bad)).status).toBe(400);
    }
    expect((await move("alice", "Not%20A%20Key", good)).status).toBe(400);

    // Whoever owns the place can, and the seen job is theirs alone.
    const res = await move("alice", shared, good);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { job: string; home: boolean };
    expect(body.home).toBe(false);
    expect(movesAsked).toHaveLength(1);
    expect(movesAsked[0]?.userId).toBe(await idOf("alice"));
    expect((await call("alice", `/moves/${body.job}`)).status).toBe(200);
    expect((await call("bob", `/moves/${body.job}`)).status).toBe(404);
    expect((await call(null, `/moves/${body.job}`)).status).toBe(401);
    expect((await call("alice", "/moves/not-a-job")).status).toBe(404);

    // Done: rooms are told, and the job's owner hears only that it worked.
    const done = await call("alice", `/moves/move-${await idOf("alice")}-donedone`);
    expect(await done.json()).toEqual({ status: "done", result: { ok: true } });
    expect(placesChanged).toEqual(["wld_told/told_place"]);

    // Your own home goes to your own copy, not to the shared place.
    const actor = { kind: "user" as const, userId: (await idOf("bob")) as UserId };
    const mine = await getMyCharacter(db, actor, worldId);
    const home = city.starts.find((x) => x.key === mine?.start)?.home as string;
    const before = homesAsked.length;
    const atHome = await move("bob", home, good);
    expect(atHome.status).toBe(202);
    expect(((await atHome.json()) as { home: boolean }).home).toBe(true);
    expect(homesAsked).toHaveLength(before + 1);
    expect(movesAsked).toHaveLength(1);

    // What's yours is listed, for you.
    const yours = (who: string) =>
      call(who, `/worlds/${worldId}/city`).then((r) => r.json() as Promise<{ yours: string[] }>);
    expect((await yours("alice")).yours).toContain(shared);
    expect((await yours("bob")).yours).not.toContain(shared);
  });

  it("removing a place: only what was filmed, by whoever filmed it or owns the city", async () => {
    const del = (who: string | null, place: string) =>
      call(who, `/worlds/${worldId}/places/${place}`, { method: "DELETE", body: "{}" });
    const shared = "mama_s_spot";
    expect((await del(null, shared)).status).toBe(401);
    expect((await del("carol", shared)).status).toBe(404);
    expect((await del("alice", "Not%20A%20Key")).status).toBe(400);
    // A place a model built isn't filmed, so not even the city's owner can remove it this way.
    expect((await del("alice", shared)).status).toBe(404);
    expect((await del("bob", shared)).status).toBe(404);
    // Cross-site: refused before anything happens.
    const forged = await call("alice", `/worlds/${worldId}/places/${shared}`, {
      method: "DELETE",
      headers: { origin: "https://evil.example" },
    });
    expect(forged.status).toBe(403);
    // A job names who asked.
    expect((await call("bob", `/removals/remove-${await idOf("alice")}-donedone`)).status).toBe(
      404,
    );
    expect((await call(null, `/removals/remove-${await idOf("alice")}-donedone`)).status).toBe(401);
    const before = placesChanged.length;
    const done = await call("alice", `/removals/remove-${await idOf("alice")}-donedone`);
    expect(await done.json()).toEqual({ status: "done", result: { ok: true } });
    expect(placesChanged.slice(before)).toEqual(["wld_gone/gone_place"]);
  });

  it("uploads name files only from plain ids, even if a route forgot to check", async () => {
    const dir = join(tmpdir(), `aye-uploads-paths-${process.pid}`);
    const u = new VideoUploads(dir, 1024);
    const bytes = new Uint8Array(3);
    const good = "abcdef0123456789";
    await expect(u.piece("usr_a", "../../../etc/passwd", 0, bytes, "video/mp4")).rejects.toThrow();
    await expect(u.piece("../usr_a", good, 0, bytes, "video/mp4")).rejects.toThrow();
    await expect(u.take("usr_a", "../../secret")).rejects.toThrow();
    await expect(u.take("usr_a/..", good)).rejects.toThrow();
    expect(await u.piece("usr_a", good, 0, bytes, "video/mp4")).toBe("ok");
  });

  it("lets guests play, keeps spending for accounts, and lets them claim one", async () => {
    const res = await post(null, "/auth/guest", {});
    expect(res.status).toBe(201);
    const cookie = (res.headers.get("set-cookie") as string).split(";")[0] as string;
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    cookies["guesty"] = cookie;
    const me = (await (await call("guesty", "/me")).json()) as { handle: string; guest: boolean };
    expect(me.guest).toBe(true);
    // They can join and read what's open to anyone.
    expect((await post("guesty", `/worlds/${worldId}/join`, {})).status).toBe(200);
    expect((await call("guesty", `/worlds/${worldId}/city`)).status).toBe(200);
    // Nothing that spends model credit.
    const denied = await post("guesty", "/worlds", {
      description: "A guest trying to build a whole city",
      visibility: "private",
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "account_needed" });
    const place = "mama_s_spot";
    expect(
      (
        await post("guesty", `/worlds/${worldId}/places/${place}/questions`, {
          question: "Could I reach this?",
        })
      ).status,
    ).toBe(403);
    expect(
      (await post("guesty", `/worlds/${worldId}/places/${place}/ask`, { thing: "x", said: "y" }))
        .status,
    ).toBe(403);
    expect((await post("guesty", `/worlds/${worldId}/home`, { wish: "more light" })).status).toBe(
      403,
    );
    expect(
      (
        await call("guesty", `/worlds/${worldId}/captures/pieces?upload=abcdef0123456789&index=0`, {
          method: "POST",
          headers: { "content-type": "video/mp4" },
          body: "aaa",
        })
      ).status,
    ).toBe(403);
    expect(
      (await post("guesty", `/worlds/${worldId}/captures?upload=abcdef0123456789`, {})).status,
    ).toBe(403);
    expect(
      (
        await call("guesty", `/worlds/${worldId}/voice`, {
          method: "POST",
          headers: { "content-type": "audio/wav" },
          body: "RIFF",
        })
      ).status,
    ).toBe(403);
    // A guest can't log in, whatever's sent.
    expect(
      (await post(null, "/auth/login", { handle: me.handle, password: "anything-at-all" })).status,
    ).toBe(401);
    // Claiming: malformed, signed out and a taken name refused.
    expect((await post("guesty", "/auth/claim", { handle: "x", password: "y" })).status).toBe(400);
    expect(
      (
        await post("guesty", "/auth/claim", {
          handle: "ok_name",
          password: "long-enough-pass",
          admin: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (await post(null, "/auth/claim", { handle: "ok_name", password: "long-enough-pass" })).status,
    ).toBe(401);
    expect(
      (await post("guesty", "/auth/claim", { handle: "ALICE", password: "long-enough-pass" }))
        .status,
    ).toBe(409);
    // Someone who already has an account can't overwrite it this way.
    expect(
      (await post("alice", "/auth/claim", { handle: "alice2", password: "long-enough-pass" }))
        .status,
    ).toBe(404);
    // Theirs now: the same session is a real account, and they can log in with it.
    expect(
      (await post("guesty", "/auth/claim", { handle: "was_guest", password: "long-enough-pass" }))
        .status,
    ).toBe(200);
    expect(await (await call("guesty", "/me")).json()).toEqual({
      handle: "was_guest",
      guest: false,
    });
    expect(
      (await post(null, "/auth/login", { handle: "was_guest", password: "long-enough-pass" }))
        .status,
    ).toBe(200);
    expect(
      (await post("guesty", "/auth/claim", { handle: "again_now", password: "long-enough-pass" }))
        .status,
    ).toBe(404);
    expect((await call("guesty", `/worlds/${worldId}/city`)).status).toBe(200);
  });

  it("has no guests where they aren't allowed", async () => {
    const off = createApp({
      env: loadEnv({ NODE_ENV: "test", DATABASE_URL: url as string, WEB_ORIGIN: ORIGIN }),
      db,
      store,
      content,
      enqueueCity: async () => undefined,
      enqueueCapture: async () => undefined,
    } as never);
    const res = await off.request("/auth/guest", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("shows finished public cities to anyone, and nothing more about them", async () => {
    const res = await call(null, "/open-cities");
    expect(res.status).toBe(200);
    const { cities } = (await res.json()) as { cities: Record<string, unknown>[] };
    for (const city of cities) {
      expect(Object.keys(city).sort()).toEqual(["description", "id", "name", "online"]);
    }
    expect(cities.some((c) => c["id"] === worldId)).toBe(true);
    // A private city doesn't appear, even to someone signed in, and building ones don't either.
    const hidden = await post("alice", "/worlds", {
      description: "A private place nobody else should find listed",
      visibility: "private",
    });
    const { world } = (await hidden.json()) as { world: { id: string } };
    const again = (await (await call(null, "/open-cities")).json()) as {
      cities: { id: string }[];
    };
    expect(again.cities.some((c) => c.id === world.id)).toBe(false);
    // How long builds take is here for anyone waiting, once there's enough to say.
    const list = (await (await call("alice", "/worlds")).json()) as {
      worlds: { id: string; online: number; buildPhase: string | null }[];
      typicalBuild: unknown;
    };
    expect(list.worlds.find((w) => w.id === worldId)?.online).toBe(0);
    expect(list).toHaveProperty("typicalBuild");
  });

  it("a video can arrive in pieces, in order, and only its sender can finish it", async () => {
    const piece = (
      who: string | null,
      upload: string,
      index: number,
      body: string | Uint8Array,
      type = "video/mp4",
    ) =>
      call(who, `/worlds/${worldId}/captures/pieces?upload=${upload}&index=${index}`, {
        method: "POST",
        headers: { "content-type": type },
        body,
      });
    const finish = (who: string | null, upload: string) =>
      call(who, `/worlds/${worldId}/captures?upload=${upload}&note=in+pieces`, {
        method: "POST",
        body: "{}",
      });
    const id = "abcdef0123456789";
    expect((await piece(null, id, 0, "aaa")).status).toBe(401);
    expect((await piece("carol", id, 0, "aaa")).status).toBe(404);
    expect((await piece("bob", "../../etc", 0, "aaa")).status).toBe(400);
    expect((await piece("bob", id, -1, "aaa")).status).toBe(400);
    expect((await piece("bob", id, 0, "aaa", "text/plain")).status).toBe(415);
    expect((await piece("bob", id, 0, new Uint8Array(0))).status).toBe(400);
    // JSON gets past the body check everywhere, but it isn't a video.
    expect((await piece("bob", id, 0, "{}", "application/json")).status).toBe(415);
    expect((await finish("bob", "notstartedyet000")).status).toBe(400);
    const forged = await fetch(`${base}/worlds/${worldId}/captures/pieces?upload=${id}&index=0`, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "video/mp4",
        cookie: cookies["bob"] as string,
      },
      body: "aaa",
    });
    expect(forged.status).toBe(403);
    // In order, or not at all.
    expect((await piece("bob", id, 1, "aaa")).status).toBe(409);
    expect((await piece("bob", id, 0, "first-")).status).toBe(200);
    // Sent twice because a line dropped: forgiven, and not added twice.
    expect((await piece("bob", id, 0, "first-")).status).toBe(200);
    expect((await piece("bob", id, 2, "aaa")).status).toBe(409);
    expect((await piece("bob", id, 1, "second")).status).toBe(200);
    // Too big a piece doesn't get read.
    const big = new Uint8Array(17 * 1024 * 1024);
    expect((await piece("bob", id, 2, big)).status).toBe(413);
    // Someone else can't finish it, or take it.
    expect((await finish("alice", id)).status).toBe(400);
    expect((await finish("carol", id)).status).toBe(404);
    expect((await finish(null, id)).status).toBe(401);
    const before = captures.length;
    const res = await finish("bob", id);
    expect(res.status).toBe(202);
    expect(captures).toHaveLength(before + 1);
    const hash = hashBytes(new TextEncoder().encode("first-second"));
    expect(await store.has(hash)).toBe(true);
    // Once.
    expect((await finish("bob", id)).status).toBe(400);
  });

  it("changing a home: only your own, and the plan itself stays with the server", async () => {
    const actor = { kind: "user" as const, userId: (await idOf("bob")) as UserId };
    const mine = await getMyCharacter(db, actor, worldId);
    const home = city.starts.find((x) => x.key === mine?.start)?.home as string;
    const change = (who: string | null, body: unknown) =>
      post(who, `/worlds/${worldId}/home`, body);
    const asked = homesAsked.length;
    const good = { place: home, request: "a green sofa by the window" };
    expect((await change(null, good)).status).toBe(401);
    expect((await change("carol", good)).status).toBe(404);
    expect((await change("bob", { ...good, extra: 1 })).status).toBe(400);
    expect((await change("bob", { ...good, place: "../etc" })).status).toBe(400);
    expect((await change("bob", { place: home, request: "" })).status).toBe(400);
    expect((await change("bob", { ...good, place: "mama_s_spot" })).status).toBe(404);
    const res = await change("bob", good);
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: string };
    expect(homesAsked).toHaveLength(asked + 1);
    const seen = await call("bob", `/homes/${job}`);
    expect(seen.status).toBe(200);
    const body = await seen.text();
    expect(body).toContain("A nice sofa");
    expect(body).not.toContain("secret");
    expect((await call("alice", `/homes/${job}`)).status).toBe(404);
  });

  it("buying a change to a home: only your own job, at the server's price", {
    timeout: 20_000,
  }, async () => {
    const actor = { kind: "user" as const, userId: (await idOf("bob")) as UserId };
    const world = await getWorld(db, actor, worldId);
    const character = await getMyCharacter(db, actor, worldId);
    const home = city.starts.find((x) => x.key === character?.start)?.home as string;
    const pinned = await getPinnedPlace(db, actor, worldId, home);
    const realm2 = new Realm({
      db,
      content,
      homeProposal: async () => ({
        place: home,
        price: 300,
        scene: pinned?.scene as string,
        spec: pinned?.spec as string,
        base: pinned?.scene as string,
      }),
    });
    const got: { t: string; reason?: string; wallet?: number[] }[] = [];
    const sock = {
      readyState: 1,
      bufferedAmount: 0,
      send: (d: string) => void got.push(JSON.parse(d)),
      close() {},
    };
    const session = await realm2.join(sock, {
      actor,
      handle: "bob",
      world: world as NonNullable<typeof world>,
      city,
      character: character as NonNullable<typeof character>,
    });
    const until = async (f: () => boolean) => {
      for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(f()).toBe(true);
    };
    const had = (character as NonNullable<typeof character>).person.money;
    // They've arrived: there's a room to change.
    await until(() => got.some((m) => m.t === "snap"));
    session.message(JSON.stringify({ t: "buy_home", job: "home-usr_someoneelse0-abcdef12" }));
    await until(() => got.some((m) => m.t === "refused" && m.reason === "not_yours"));
    session.message(JSON.stringify({ t: "buy_home", job: `home-${actor.userId}-abcdef12` }));
    await until(() => got.some((m) => m.t === "snap" && (m.wallet ?? []).includes(had - 300)));
    const bought = await getMyCharacter(db, actor, worldId);
    expect(bought?.home?.place).toBe(home);
    // Buying it again isn't possible by naming a price: the client never sends one.
    expect(ClientMessage.safeParse({ t: "buy_home", job: "x", price: 0 }).success).toBe(false);
    session.close();
    await new Promise((r) => setTimeout(r, 300));
    await realm2.stop();
    // Everyone else's tests expect Bob as he was.
    const after = await getMyCharacter(db, actor, worldId);
    await saveCharacter(db, actor, {
      ...(after as NonNullable<typeof after>),
      home: null,
      person: { ...(after as NonNullable<typeof after>).person, money: had },
    });
  });

  // ── The realm ─────────────────────────────────────────────────────────────────────

  interface Client {
    ws: WebSocket;
    got: ServerMessage[];
    next<T extends ServerMessage["t"]>(
      t: T,
      where?: (m: Extract<ServerMessage, { t: T }>) => boolean,
    ): Promise<Extract<ServerMessage, { t: T }>>;
    send(m: unknown): void;
  }

  const sockets: WebSocket[] = [];
  const play = (who: string | null, headers: Record<string, string> = {}) =>
    new Promise<Client>((resolve, reject) => {
      const ws = new WebSocket(`${base.replace("http", "ws")}/worlds/${worldId}/play`, {
        headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who] as string } : {}), ...headers },
      });
      sockets.push(ws);
      const got: ServerMessage[] = [];
      const waiters: { t: string; where: (m: never) => boolean; resolve: (m: never) => void }[] =
        [];
      ws.on("message", (data) => {
        const m = JSON.parse(String(data)) as ServerMessage;
        const w = waiters.find((x) => x.t === m.t && x.where(m as never));
        if (w) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(m as never);
        } else {
          got.push(m);
        }
      });
      ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.on("error", reject);
      ws.on("open", () =>
        resolve({
          ws,
          got,
          send: (m) => ws.send(JSON.stringify(m)),
          next: (t, where = () => true) => {
            const seen = got.find((m) => m.t === t && where(m as never));
            if (seen) {
              got.splice(got.indexOf(seen), 1);
              return Promise.resolve(seen as never);
            }
            return new Promise((res, rej) => {
              waiters.push({ t, where: where as never, resolve: res as never });
              setTimeout(() => rej(new Error(`no ${t} in time`)), 20_000);
            });
          },
        }),
      );
    });

  it("refuses connections without a session, from other sites, or without a character", async () => {
    await expect(play(null)).rejects.toThrow("HTTP 401");
    await expect(play("bob", { origin: "https://evil.example" })).rejects.toThrow("HTTP 403");
    await expect(play("carol")).rejects.toThrow("HTTP 404");
  });

  it("players wake at home, walk to a shared place, see each other and talk", {
    timeout: 30_000,
  }, async () => {
    const bob = await play("bob");
    const home = await bob.next("place");
    expect(home.place).toBe("your_flat");
    const bobKey = home.you;

    let alice = await play("alice");
    expect((await alice.next("place")).place).toBe("your_flat");
    // Homes are private: Alice's flat is her own; Bob isn't in it.
    const aliceHome = await alice.next("roster");
    expect(aliceHome.roster.some((r) => r.key === bobKey)).toBe(false);

    bob.send({ t: "go", place: "mama_s_spot", mode: "walk" });
    const trip = await bob.next("transit");
    expect(trip.fare).toBe(0);
    expect((await bob.next("place")).place).toBe("mama_s_spot");
    alice.send({ t: "go", place: "mama_s_spot", mode: "walk" });
    const at = await alice.next("place");
    const aliceKey = at.you;
    const roster = await bob.next("roster", (m) => m.roster.some((r) => r.key === aliceKey));
    expect(roster.roster.find((r) => r.key === aliceKey)?.player).toBe("alice");
    expect(roster.roster.find((r) => r.key === bobKey)?.player).toBe("bob");

    alice.send({ t: "say", text: `  hello${RLO} Bayo ` });
    const said = await bob.next("said");
    expect(said.line).toMatchObject({ from: "Ada", text: "hello Bayo", agent: aliceKey });

    // Someone who lives here answers, under their own name, for everyone in the room; never
    // as a player's character.
    alice.send({ t: "say", text: "anyone home?" });
    const answered = await bob.next("said", (m) => m.line.from === "Someone");
    expect(answered.line.text).toBe("Welcome, Ada!");
    const asked = replyRequests.find((r) => r.said === "anyone home?");
    expect(asked?.present).not.toContain(aliceKey);
    expect(answered.line.agent).not.toBe(aliceKey);
    expect(asked?.recent.some((l) => l.text === "hello Bayo")).toBe(true);

    // Others can join in, but only people who are here; something unreal is simply not done.
    bob.send({ t: "say", text: "join in please" });
    await bob.next("said", (m) => m.line.text === "Right.");
    const joined = await bob.next("said", (m) => m.line.text === "And another thing.");
    expect(joined.line.from).toBe("Someone");
    // Asked to do something real, one of the world's people sets off to do it.
    bob.send({ t: "say", text: "please get a snack" });
    await bob.next("said", (m) => m.line.text === "Going now.");
    await bob.next("snap", (m) => m.doing.includes("Grab a snack"));

    let strangerSpoke = false;
    alice.send({ t: "say", text: "next up" });
    await bob.next("said", (m) => {
      strangerSpoke ||= m.line.text === "I'm not here.";
      return m.line.text === "next up";
    });
    expect(strangerSpoke).toBe(false);

    // An offer of something really on offer here: a button for whoever asked, nobody else.
    alice.send({ t: "say", text: "I'm hungry" });
    const offered = await alice.next("said", (m) => m.line.text === "Cook something.");
    expect(offered.offer).toMatchObject({ kind: "fridge", action: "snack" });
    // Its name and price are the place's own, whatever the speaker called it.
    const snack = sampleSpec.kinds
      .find((k) => k.key === "fridge")
      ?.actions.find((a) => a.key === "snack");
    expect(offered.offer).toMatchObject({ label: snack?.label, cost: snack?.cost });
    const seen = await bob.next("said", (m) => m.line.text === "Cook something.");
    expect(seen.offer).toBeUndefined();
    // One that isn't real is only words.
    await new Promise((r) => setTimeout(r, 1_100));
    alice.send({ t: "say", text: "make me rich" });
    const fake = await alice.next("said", (m) => m.line.text === "Here's a fortune.");
    expect(fake.offer).toBeUndefined();

    // Snapshots stream in, with the city's clock.
    const snap = await bob.next("snap");
    expect(snap.positions.length).toBeGreaterThan(0);
    expect(snap.clock.day).toBeGreaterThanOrEqual(1);

    // Nobody commands someone else's character.
    bob.send({ t: "do", cmd: { type: "cancel" }, as: aliceKey });
    expect(await bob.next("refused")).toMatchObject({ what: "do", reason: "not_yours" });
    bob.send({ t: "hold", agent: aliceKey });
    expect(await bob.next("refused")).toMatchObject({ what: "hold", reason: "a_player" });
    // Not even in the moment they're on their way out, when they're no longer listed as a player.
    alice.ws.close();
    bob.send({ t: "hold", agent: aliceKey });
    expect((await bob.next("refused")).what).toBe("hold");
    alice = await play("alice");
    await alice.next("place");

    // Taking over someone the world wrote: one holder at a time.
    bob.send({ t: "hold", agent: "tolu" });
    await bob.next("roster", (m) => m.roster.some((r) => r.key === "tolu" && r.heldBy === "bob"));
    alice.send({ t: "hold", agent: "tolu" });
    expect(await alice.next("refused")).toMatchObject({ reason: "taken" });
    bob.send({ t: "do", cmd: { type: "walk", x: 1000, z: 1000 }, as: "tolu" });
    bob.send({ t: "release" });
    await bob.next("roster", (m) => m.roster.some((r) => r.key === "tolu" && r.heldBy === null));

    // Junk is refused, not obeyed.
    bob.ws.send("{nope");
    expect(await bob.next("refused")).toMatchObject({ reason: "invalid" });
    bob.send({ t: "do", cmd: { type: "use", object: "obj_x", action: "eat", money: 1e9 } });
    expect(await bob.next("refused")).toMatchObject({ reason: "invalid" });
    bob.send({ t: "go", place: "nowhere", mode: "walk" });
    expect(await bob.next("refused")).toMatchObject({ what: "go", reason: "unknown" });

    // Leaving saves where they are and what they have, from the sim.
    bob.ws.close();
    await new Promise((r) => setTimeout(r, 600));
    const saved = await getMyCharacter(
      db,
      { kind: "user", userId: (await idOf("bob")) as UserId },
      worldId,
    );
    expect(saved?.place).toBe("mama_s_spot");

    // A trip outlives a disconnect: leaving mid-journey doesn't skip the rest of it.
    alice.send({ t: "go", place: "your_flat", mode: "walk" });
    const going = await alice.next("transit");
    expect(going.etaMs).toBeGreaterThan(1_000);
    alice.ws.close();
    await new Promise((r) => setTimeout(r, 300));
    const again = await play("alice");
    const resumed = await again.next("transit");
    expect(resumed.to).toBe("your_flat");
    expect(resumed.etaMs).toBeGreaterThan(0);
    expect(resumed.etaMs).toBeLessThan(going.etaMs);
    expect((await again.next("place")).place).toBe("your_flat");
    again.ws.close();
  });

  it("a place extended live reaches everyone in it without reconnecting", {
    timeout: 40_000,
  }, async () => {
    const bob = await play("bob");
    const here = await bob.next("place");
    // Someone asked for something new: the place gets a new revision with a new action.
    const pinned = await systemGetPinnedPlace(db, worldId, here.place);
    const spec = sampleSpec;
    const extended = {
      ...spec,
      kinds: spec.kinds.map((k, i) =>
        i === 0
          ? {
              ...k,
              actions: [
                ...k.actions,
                {
                  ...(k.actions[0] as (typeof k.actions)[number]),
                  key: "polish",
                  label: "Polish it",
                },
              ],
            }
          : k,
      ),
    };
    const specRef = await store.put(encodeJson(extended), "application/json");
    const sceneRef = await store.put(encodeJson(sampleFlat), "application/json");
    await systemRecordArtifacts(db, [specRef]);
    const owner = (await alice()).id as UserId;
    const rev: PlaceRevision = {
      placeId: pinned?.placeId as PlaceId,
      parent: pinned?.revision as ArtifactHash,
      base: sceneRef,
      edits: [],
      scene: sceneRef,
      world: { spec: specRef, approved: false },
      authorId: owner,
      message: "asked",
      createdAt: new Date().toISOString(),
    };
    const hash = hashJson(rev) as ArtifactHash;
    expect(await systemCommitRevision(db, owner, hash, rev, sampleFlat)).toBe(true);
    await systemPinPlace(db, worldId, { key: here.place, placeId: rev.placeId, revision: hash });
    const reloaded = await bob.next("place", (m) => JSON.stringify(m.spec).includes("Polish it"));
    expect(reloaded.place).toBe(here.place);
    bob.ws.close();
  });

  it("someone else's home doesn't exist for you, whatever you send", {
    timeout: 40_000,
  }, async () => {
    const bob = await play("bob");
    await bob.next("place");
    const before = await systemGetWorld(db, worldId);
    const now = CitySpec.parse(
      JSON.parse(
        new TextDecoder().decode((await store.get(before?.city as ArtifactHash)) as Uint8Array),
      ),
    );
    const spot = now.items.find((i) => i.key === "mama_s_spot");
    const mover = moversOf(now)[0]?.key as string;
    // A home that belongs to a start bob didn't take.
    const closed = {
      ...now,
      items: now.items.map((i) =>
        i.key === spot?.key
          ? { ...i, traits: { ...i.traits, place: { ...i.traits.place, private: true } } }
          : i,
      ),
    };
    const ref = await store.put(encodeJson(closed), "application/json");
    await systemRecordArtifacts(db, [ref]);
    await systemLinkWorldArtifacts(db, worldId, [ref.hash]);
    expect(await systemSwapWorldCity(db, worldId, before?.city as ArtifactHash, ref.hash)).toBe(
      true,
    );
    try {
      bob.send({ t: "go", place: "mama_s_spot", mode: mover });
      expect(await bob.next("refused")).toMatchObject({ what: "go", reason: "unknown" });
      bob.send({ t: "drive", place: "mama_s_spot" });
      expect(await bob.next("refused")).toMatchObject({ what: "drive", reason: "unknown" });
    } finally {
      await systemSwapWorldCity(db, worldId, ref.hash, before?.city as ArtifactHash);
      bob.ws.close();
    }
  });

  it("a closure the director adds reaches a room people are already in", {
    timeout: 40_000,
  }, async () => {
    const bob = await play("bob");
    const here = (await bob.next("place")) as unknown as { place: string };
    const before = await systemGetWorld(db, worldId);
    const now = CitySpec.parse(
      JSON.parse(
        new TextDecoder().decode((await store.get(before?.city as ArtifactHash)) as Uint8Array),
      ),
    );
    const closed = {
      ...now,
      events: [
        ...now.events,
        {
          key: "shut_for_a_while",
          name: "Shut",
          about: "Closed for now.",
          icon: "\u{1F6A7}",
          from: 0,
          to: 3 * 1440,
          effects: [{ type: "closed" as const, place: here.place }],
        },
      ],
    };
    const ref = await store.put(encodeJson(closed), "application/json");
    await systemRecordArtifacts(db, [ref]);
    await systemLinkWorldArtifacts(db, worldId, [ref.hash]);
    expect(await systemSwapWorldCity(db, worldId, before?.city as ArtifactHash, ref.hash)).toBe(
      true,
    );
    try {
      const shut = await bob.next("snap", (m) => m.shut === 1);
      expect(shut.shut).toBe(1);
    } finally {
      await systemSwapWorldCity(db, worldId, ref.hash, before?.city as ArtifactHash);
      bob.ws.close();
    }
  });

  it("a room playing a place takes a moved thing live, though what it does hasn't changed", {
    timeout: 40_000,
  }, async () => {
    const bob = await play("bob");
    const here = (await bob.next("place")) as unknown as { place: string; scene: Scene };
    const pinned = await systemGetPinnedPlace(db, worldId, here.place);
    const thing = here.scene.objects[0];
    const [x = 0, y = 0, z = 0] = thing?.transform.position ?? [];
    const moved = {
      ...here.scene,
      objects: here.scene.objects.map((o, i) =>
        i === 0
          ? {
              ...o,
              transform: {
                ...o.transform,
                position: [x + 50, y, z] as typeof o.transform.position,
              },
            }
          : o,
      ),
    };
    const sceneRef = await store.put(encodeJson(moved), "application/json");
    await systemRecordArtifacts(db, [sceneRef]);
    const owner = (await alice()).id as UserId;
    const specRef = { hash: pinned?.spec as ArtifactHash, mediaType: "application/json", bytes: 0 };
    const rev: PlaceRevision = {
      placeId: pinned?.placeId as PlaceId,
      parent: pinned?.revision as ArtifactHash,
      base: sceneRef,
      edits: [],
      scene: sceneRef,
      world: { spec: specRef, approved: false },
      authorId: owner,
      message: "moved",
      createdAt: new Date().toISOString(),
    };
    const hash = hashJson(rev) as ArtifactHash;
    expect(await systemCommitRevision(db, owner, hash, rev, moved)).toBe(true);
    await systemPinPlace(db, worldId, { key: here.place, placeId: rev.placeId, revision: hash });
    // Told it changed, the room doesn't wait for its next look round (every 10 seconds).
    const asked = Date.now();
    realm.placeChanged(worldId, here.place);
    const reloaded = await bob.next(
      "place",
      (m) => (m.scene as Scene).objects[0]?.transform.position[0] === x + 50,
    );
    expect(reloaded.place).toBe(here.place);
    expect(Date.now() - asked).toBeLessThan(5_000);
    bob.ws.close();
  });

  it("your own vehicle at home takes you places, free, and comes home with you", {
    timeout: 30_000,
  }, async () => {
    // The flat's generator becomes something people ride out on (a stand-in for a car).
    const pinned = await systemGetPinnedPlace(db, worldId, "your_flat");
    const withRide = {
      ...sampleSpec,
      kinds: sampleSpec.kinds.map((k) =>
        k.key === "generator"
          ? {
              ...k,
              travel: { speedKmh: 30 },
              actions: [
                ...k.actions,
                {
                  ...(k.actions[0] as (typeof k.actions)[number]),
                  key: "ride",
                  label: "Ride out",
                  requires: [],
                  sets: [],
                  leaves: { withThing: true },
                  pose: "sit" as const,
                },
              ],
            }
          : k,
      ),
    };
    const specRef = await store.put(encodeJson(withRide), "application/json");
    const sceneRef = await store.put(encodeJson(sampleFlat), "application/json");
    await systemRecordArtifacts(db, [specRef]);
    const owner = (await alice()).id as UserId;
    const rev: PlaceRevision = {
      placeId: pinned?.placeId as PlaceId,
      parent: pinned?.revision as ArtifactHash,
      base: sceneRef,
      edits: [],
      scene: sceneRef,
      world: { spec: specRef, approved: false },
      authorId: owner,
      message: "a ride",
      createdAt: new Date().toISOString(),
    };
    const hash = hashJson(rev) as ArtifactHash;
    expect(await systemCommitRevision(db, owner, hash, rev, sampleFlat)).toBe(true);
    await systemPinPlace(db, worldId, { key: "your_flat", placeId: rev.placeId, revision: hash });

    // Alice is out (at Mama's) with no vehicle: she can't drive.
    const ada = await play("alice");
    await ada.next("place");
    ada.send({ t: "go", place: "mama_s_spot", mode: "walk" });
    const away = await ada.next("place", (m) => m.place === "mama_s_spot");
    expect(away.ride).toBeNull();
    ada.send({ t: "drive", place: "your_flat" });
    expect(await ada.next("refused")).toMatchObject({ what: "drive", reason: "no_vehicle" });
    ada.ws.close();

    // Bob is home: the generator is his (his own home), so he can ride it out.
    const bob = await play("bob");
    const first = await bob.next("place");
    if (first.place !== "your_flat") bob.send({ t: "go", place: "your_flat", mode: "walk" });
    // A room still playing the old revision reloads to the new one live.
    const home = await bob.next("place", (m) => m.place === "your_flat" && m.ride !== null);
    expect(home.ride).toMatchObject({ speedKmh: 30 });
    bob.send({ t: "drive", place: "mama_s_spot" });
    expect(await bob.next("transit", (m) => m.to === "mama_s_spot")).toMatchObject({ fare: 0 });
    const there = await bob.next("place", (m) => m.place === "mama_s_spot");
    // It's out with him.
    expect(there.ride).toMatchObject({ speedKmh: 30 });
    const out = await getMyCharacter(
      db,
      { kind: "user", userId: (await idOf("bob")) as UserId },
      worldId,
    );
    expect(out?.vehicle?.speedKmh).toBe(30);
    // And home again with it.
    bob.got.length = 0;
    bob.send({ t: "drive", place: "your_flat" });
    await bob.next("transit", (m) => m.to === "your_flat");
    const back = await bob.next("place", (m) => m.place === "your_flat");
    expect(back.ride).toMatchObject({ speedKmh: 30 });
    const home2 = await getMyCharacter(
      db,
      { kind: "user", userId: (await idOf("bob")) as UserId },
      worldId,
    );
    expect(home2?.vehicle).toBeNull();
    bob.ws.close();
  });

  it("a second tab takes over cleanly: the character is there exactly once", {
    timeout: 20_000,
  }, async () => {
    const first = await play("bob");
    const second = await play("bob");
    const place = await second.next("place");
    const roster = await second.next("roster", (m) => m.roster.some((r) => r.key === place.you));
    expect(roster.roster.filter((r) => r.key === place.you)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 1_500));
    const later = second.got.filter((m) => m.t === "roster").at(-1) ?? roster;
    expect(later.roster.filter((r) => r.key === place.you)).toHaveLength(1);
    expect(second.got.some((m) => m.t === "refused")).toBe(false);
    first.ws.close();
    second.ws.close();
  });

  it("someone speaking while they're being answered is answered next, not ignored", {
    timeout: 25_000,
  }, async () => {
    const client = await play("alice");
    const place = await client.next("place");
    await client.next("roster", (m) => m.roster.some((r) => r.key === place.you));
    const before = replyRequests.length;
    client.send({ t: "say", text: "anyone home, first?" });
    await new Promise((r) => setTimeout(r, 1_200));
    client.send({ t: "say", text: "anyone home, second?" });
    const deadline = Date.now() + 15_000;
    while (
      !replyRequests.slice(before).some((r) => r.said.includes("second")) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(replyRequests.slice(before).some((r) => r.said.includes("second"))).toBe(true);
    client.ws.close();
  });

  it("a room that throws closes itself, and the server and its other rooms carry on", {
    timeout: 20_000,
  }, async () => {
    const client = await play("bob");
    await client.next("place");
    const closed = new Promise<number>((res) => client.ws.on("close", (code) => res(code)));
    const step = vi.spyOn(Sim.prototype, "step").mockImplementation(() => {
      // Every room still lingering from earlier tests goes too; this player's is what's watched.
      throw new Error("a broken world");
    });
    try {
      expect(await closed).toBe(1011);
    } finally {
      step.mockRestore();
    }
    // Back in: a fresh room, and nothing else disturbed.
    const again = await play("bob");
    await again.next("place");
    again.ws.close();
  });

  it("an older connection finishing its join late never knocks out the newer one", async () => {
    const actor = { kind: "user" as const, userId: (await idOf("bob")) as UserId };
    const world = await getWorld(db, actor, worldId);
    const character = await getMyCharacter(db, actor, worldId);
    const socket = () => {
      const s = {
        readyState: 1,
        bufferedAmount: 0,
        closedWith: null as number | null,
        send() {},
        close(code?: number) {
          s.closedWith = code ?? 1000;
          s.readyState = 3;
        },
      };
      return s;
    };
    const newer = socket();
    const older = socket();
    const args = { actor, handle: "bob", world: world!, city, character: character! };
    const session = await realm.join(newer, { ...args, seq: 1_000_001 });
    // The page's first connection (closed by the page, but the server only now gets to it).
    await realm.join(older, { ...args, seq: 1_000_000 });
    expect(older.closedWith).toBe(4000);
    expect(newer.closedWith).toBeNull();
    session.close();
  });

  it("a player who goes quiet has their character look after themselves, until they act", {
    timeout: 20_000,
  }, async () => {
    let clock = Date.now();
    const welcomes: string[] = [];
    const quiet = new Realm({
      db,
      content,
      now: () => clock,
      welcome: async (w, u, key) => void welcomes.push(`${w}:${u}:${key}`),
    });
    const actor = { kind: "user" as const, userId: (await idOf("bob")) as UserId };
    const world = await getWorld(db, actor, worldId);
    const character = await getMyCharacter(db, actor, worldId);
    const got: { t: string; on?: boolean }[] = [];
    const closedWith: number[] = [];
    const sock = {
      readyState: 1,
      bufferedAmount: 0,
      send: (d: string) => void got.push(JSON.parse(d)),
      close: (code?: number) => void closedWith.push(code ?? 0),
    };
    const session = await quiet.join(sock, {
      actor,
      handle: "bob",
      world: world!,
      city,
      character: character!,
    });
    const until = async (f: () => boolean) => {
      for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(f()).toBe(true);
    };
    await until(() => got.some((m) => m.t === "place"));
    expect(got.some((m) => m.t === "selfCare")).toBe(false);
    // With nothing open to do, joining asks the director for something (once a city day).
    await until(() => welcomes.length === 1);
    expect(welcomes[0]).toMatch(new RegExp(`^${worldId}:${actor.userId}:day\\d+$`));
    clock += SELF_CARE_AFTER_MS;
    await until(() => got.some((m) => m.t === "selfCare" && m.on === true));
    session.message(JSON.stringify({ t: "do", cmd: { type: "walk", x: 0, z: 0 } }));
    await until(() => got.some((m) => m.t === "selfCare" && m.on === false));
    // Signing out ends the connection there and then; someone else's sign-out doesn't.
    quiet.signedOut("usr_someone_else");
    expect(closedWith).toEqual([]);
    quiet.signedOut(actor.userId);
    expect(closedWith).toEqual([4001]);
    session.close();
    await quiet.stop();
  });

  it("a place closes and opens by its hours, and no client can say otherwise", {
    timeout: 60_000,
  }, async () => {
    let clock = Date.now();
    const hours = new Realm({ db, content, now: () => clock });
    const actor = { kind: "user" as const, userId: (await idOf("bob")) as UserId };
    const world = (await getWorld(db, actor, worldId))!;
    const character = (await getMyCharacter(db, actor, worldId))!;
    // A city day is 1440 real seconds at this test's clock; its hours start well ahead of now.
    const minute = cityMinuteNow(world.createdAt, world.settings, clock) % 1440;
    const from = (minute + 600) % 1440;
    const to = (minute + 900) % 1440;
    const placeKeys = new Set(placesOf(city).map((p) => p.key));
    const shutCity: CitySpec = {
      ...city,
      items: city.items.map((i) =>
        placeKeys.has(i.key)
          ? { ...i, traits: { ...i.traits, place: { ...i.traits.place, hours: { from, to } } } }
          : i,
      ),
    };
    const shutValues: number[] = [];
    const sock = {
      readyState: 1,
      bufferedAmount: 0,
      send: (d: string) => {
        const m = JSON.parse(d) as { t: string; shut?: number };
        if (m.t === "snap") shutValues.push(m.shut as number);
      },
      close() {},
    };
    const session = await hours.join(sock, {
      actor,
      handle: "bob",
      world,
      city: shutCity,
      character,
    });
    const until = async (shut: number) => {
      for (let i = 0; i < 400 && shutValues.at(-1) !== shut; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(shutValues.at(-1)).toBe(shut);
    };
    await until(1);
    // Not a command a client can send: it's dropped, and the place stays shut.
    session.message(JSON.stringify({ t: "do", cmd: { type: "shut", on: false } }));
    const seen = shutValues.length;
    for (let i = 0; i < 100 && shutValues.length < seen + 3; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(shutValues.slice(seen).every((v) => v === 1)).toBe(true);
    clock += 700_000;
    await until(0);
    session.close();
    await hours.stop();
  });

  it("finishing a thread pays its reward, and the director is asked for what's next", {
    timeout: 20_000,
  }, async () => {
    const welcomes: string[] = [];
    const realm2 = new Realm({
      db,
      content,
      welcome: async (_w, _u, key) => void welcomes.push(key),
    });
    const actor = { kind: "user" as const, userId: (await idOf("bob")) as UserId };
    const world = await getWorld(db, actor, worldId);
    const character = await getMyCharacter(db, actor, worldId);
    const home = city.starts.find((x) => x.key === character!.start)?.home as string;
    await systemAddThread(db, worldId, actor.userId, {
      id: "thr_goinghome01",
      title: "Go home",
      about: "",
      icon: "x",
      steps: [{ check: "be_at", place: home, text: "Be home" }],
      progress: 0,
      reward: 4_200,
      from: 0,
      due: 1_000_000,
      state: "open",
    });
    const got: { t: string; thread?: { state: string }; wallet?: number[] }[] = [];
    const sock = {
      readyState: 1,
      bufferedAmount: 0,
      send: (d: string) => void got.push(JSON.parse(d)),
      close() {},
    };
    const session = await realm2.join(sock, {
      actor,
      handle: "bob",
      world: world!,
      city,
      character: character!,
    });
    const until = async (f: () => boolean) => {
      for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(f()).toBe(true);
    };
    // They wake at home: the step holds, the thread is done, and it's paid.
    await until(() => got.some((m) => m.t === "thread" && m.thread?.state === "done"));
    const before = character!.person.money;
    await until(() =>
      got.some((m) => m.t === "snap" && (m.wallet ?? []).some((w) => w === before + 4_200)),
    );
    // With nothing left on, the director is asked for the next thing (once, for this thread).
    await until(() => welcomes.includes("after-thr_goinghome01"));
    session.close();
    await realm2.stop();
  });

  it("the city's bills are charged by the server; what can't be paid is owed", {
    timeout: 20_000,
  }, async () => {
    const actor = { kind: "user" as const, userId: (await idOf("bob")) as UserId };
    const world = await getWorld(db, actor, worldId);
    const run = async (amount: number) => {
      const character = await getMyCharacter(db, actor, worldId);
      const money = character!.person.money;
      // Days on from when they were last billed.
      const realm2 = new Realm({ db, content, now: () => Date.now() + 10 * 86_400_000 });
      const got: {
        t: string;
        owes?: number;
        paid?: number;
        names?: string[];
        wallet?: number[];
      }[] = [];
      const sock = {
        readyState: 1,
        bufferedAmount: 0,
        send: (d: string) => void got.push(JSON.parse(d)),
        close() {},
      };
      const session = await realm2.join(sock, {
        actor,
        handle: "bob",
        world: world!,
        city: {
          ...city,
          economy: {
            ...city.economy,
            bills: [{ name: "Rent", amount, everyDays: 1 }],
          },
        },
        character: { ...character!, billed: { day: 0, owes: 0 } },
      });
      const until = async (f: () => boolean) => {
        for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 50));
        expect(f()).toBe(true);
      };
      await until(() => got.some((m) => m.t === "bills" && (m.names ?? []).includes("Rent")));
      const bill = got.find((m) => m.t === "bills" && (m.names ?? []).includes("Rent"));
      const left = money - (bill?.paid ?? 0);
      await until(() => got.some((m) => m.t === "snap" && (m.wallet ?? []).includes(left)));
      session.close();
      // They leave on the next tick, and that's when they're saved, money and bills together.
      for (let i = 0; i < 100; i++) {
        const saved = await getMyCharacter(db, actor, worldId);
        if (saved?.person.money === left && saved.billed.day > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await realm2.stop();
      return bill;
    };
    const had = (await getMyCharacter(db, actor, worldId))!.person.money;
    expect(await run(700)).toMatchObject({ paid: 700, owes: 0 });
    const paid = await getMyCharacter(db, actor, worldId);
    expect(paid?.person.money).toBe(had - 700);
    // More than they have: all of it goes, and the rest is owed, saved with them.
    expect(await run(had)).toMatchObject({ paid: had - 700, owes: 700 });
    const short = await getMyCharacter(db, actor, worldId);
    expect(short?.person.money).toBe(0);
    expect(short?.billed.owes).toBe(700);
  });

  async function idOf(handle: string) {
    const [row] = await db.select().from(tables.users).where(eq(tables.users.handle, handle));
    return (row as { id: string }).id;
  }
});

describe("what counts as speech", () => {
  it("listens for words the model will take", () => {
    const long = "Brew Turkish coffee on the machine with two pots";
    expect(speechKeywords(["  Waakye ", long, "Waakye", "", "Abeg"])).toEqual(["Abeg", "Waakye"]);
    const many = Array.from({ length: 100 }, (_, i) => `word ${i}`);
    expect(speechKeywords(many)).toHaveLength(MAX_KEYWORDS);
  });

  it("finds the format wherever it is in the file", () => {
    const b = new Uint8Array(80);
    const v = new DataView(b.buffer);
    b.set(new TextEncoder().encode("RIFF"), 0);
    b.set(new TextEncoder().encode("WAVE"), 8);
    // Another chunk first, as some recorders write; odd-sized, so padded.
    b.set(new TextEncoder().encode("JUNK"), 12);
    v.setUint32(16, 7, true);
    b.set(new TextEncoder().encode("fmt "), 28);
    v.setUint32(32, 16, true);
    v.setUint16(36, 1, true);
    v.setUint16(38, 1, true);
    v.setUint32(40, 24_000, true);
    v.setUint16(50, 16, true);
    expect(isSpeechWav(b)).toBe(true);
    v.setUint16(38, 2, true);
    expect(isSpeechWav(b)).toBe(false);
  });
});
