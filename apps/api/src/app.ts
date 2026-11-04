/**
 * HTTP API. Thin: validates input, resolves the actor, calls actor-scoped repositories.
 * No handler loads user data except through @aye/db repositories, which enforce access.
 *
 * Security posture:
 * - Strict headers (secureHeaders), explicit CORS origins, body size limits, rate limiting
 *   (tighter on sign-up and log-in).
 * - Sessions are HttpOnly, SameSite=Lax cookies (Secure in production) holding a random token
 *   whose hash is the only thing stored. State-changing requests must be JSON and, when a
 *   browser says where they come from, come from our own origin: no cross-site forgery.
 * - Input is Zod-validated and unknown fields are rejected; log-in alone checks by hand, and
 *   any bad attempt gets the same 401.
 * - Not-found and not-allowed are both 404, so ids reveal nothing.
 * - Errors never leak internals; stack traces stay in server logs.
 * - Artifacts are served only after canReadArtifact, with a sandboxing CSP and nosniff,
 *   because generated content is untrusted.
 */
import type { ArtifactStore } from "@aye/artifacts";
import { randomId } from "@aye/artifacts";
import {
  type Actor,
  addMyThread,
  approveWorld,
  canReadArtifact,
  checkLogin,
  claimGuest,
  createCapture,
  createCharacter,
  createGuest,
  createPlace,
  createSession,
  createWorld,
  type Db,
  deleteWorld,
  getCapture,
  getMyCharacter,
  getPinnedPlace,
  getPlace,
  getPlaceWorld,
  getWorld,
  Handle,
  isGuest,
  joinWorld,
  listMyThreads,
  listOpenCities,
  listOwnedPlaceKeys,
  listOwnPlaces,
  listPinnedSpecs,
  listPublicPlacesNear,
  listRemovablePlaceKeys,
  listWorlds,
  Password,
  registerUser,
  resolveSession,
  revokeSession,
  SESSION_DAYS,
  setWorldVisibility,
  tables,
  typicalBuildMinutes,
  updatePlace,
} from "@aye/db";
import {
  ACTION_MAX_REAL_SEC,
  AIM_NEVER_DUE,
  ArtifactHash,
  type Character,
  type CharacterId,
  type CitySpec,
  GeoAnchor,
  NewCharacter,
  ObjectId,
  ownersOnly,
  type PersonDef,
  placesOf,
  SpecKey,
  type Thread,
  TRIP_MAX_REAL_SEC,
  UserId,
  Visibility,
  type WorldId,
  WorldSpec,
  WorldVisibility,
} from "@aye/schema";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { type Content, OutdatedContent } from "./content.ts";
import type { Env } from "./env.ts";
import { rateLimit } from "./rate-limit.ts";
import { cleanChat } from "./realm.ts";
import { UPLOAD_ID, UPLOAD_PIECE_BYTES, type VideoUploads } from "./uploads.ts";
import { isSpeechWav, MAX_VOICE_BYTES, type Transcribe } from "./voice.ts";

export interface AppDeps {
  env: Env;
  db: Db;
  /** Someone signed out: end their live connections, which were only checked on opening. */
  onSignOut?: (userId: string) => void;
  /** How many people are in a city right now. */
  onlineIn?: (worldId: string) => number;
  /** Videos arriving in pieces. */
  uploads?: VideoUploads;
  /** A place just changed: rooms playing it should take it now. */
  onPlaceChanged?: (worldId: string, placeKey: string) => void;
  store: ArtifactStore;
  content: Content;
  /** Queue the durable job that writes and builds a city (the worker runs it). */
  enqueueCity: (worldId: WorldId) => Promise<void>;
  /** Questions about a place, tested and answered by an agent (the worker runs it). */
  questions: {
    enqueue(
      userId: string,
      job: { worldId: string; placeKey: string; question: string; nonce: string },
    ): Promise<string>;
    status(
      id: string,
    ): Promise<
      | { status: "working" }
      | { status: "done"; result: { ok: true; answer: unknown } | { ok: false } }
      | null
    >;
  };
  /** Speech to text for talking to people; absent: the voice route answers `no_voice`. */
  transcribe?: Transcribe;
  /** Queue the durable job that turns a filmed place into part of a city. */
  enqueueCapture: (job: {
    worldId: string;
    captureId: string;
    note: string;
    at: [number, number];
  }) => Promise<void>;
  /** Someone changing their own home: queue it, and see what it would take. */
  homes?: {
    enqueue(
      userId: string,
      job: {
        worldId: string;
        userId: string;
        place: string;
        request?: string;
        moves?: { object: string; xMm: number; zMm: number; yawDeg: number }[];
        nonce: string;
      },
    ): Promise<string>;
    status(id: string): Promise<
      | { status: "working" }
      | {
          status: "done";
          result:
            | {
                ok: true;
                say: string;
                price: number;
                added: string[];
                moved: string[];
                removed: string[];
              }
            | { ok: false; reason: string };
        }
      | null
    >;
  };
  /** Taking away a filmed place: queue it, and see how it went. */
  removals?: {
    enqueue(
      userId: string,
      job: { worldId: string; place: string; userId: string; nonce: string },
    ): Promise<string>;
    status(id: string): Promise<
      | { status: "working" }
      | {
          status: "done";
          result: { ok: true; worldId: string; place: string } | { ok: false; reason: string };
        }
      | null
    >;
  };
  /** Moving a thing in a place of yours: queue it, and see how it went. */
  moves?: {
    enqueue(userId: string, job: MoveRequest): Promise<string>;
    status(id: string): Promise<
      | { status: "working" }
      | {
          status: "done";
          result: { ok: true; worldId: string; place: string } | { ok: false; reason: string };
        }
      | null
    >;
  };
  /** Asking a thing for something new: queue it, and see how it went. */
  asks: {
    enqueue(userId: string, job: AskRequest): Promise<string>;
    status(id: string): Promise<
      | { status: "working" }
      | {
          status: "done";
          result: { ok: true; thing: string; added: string[] } | { ok: false; reason: string };
        }
      | null
    >;
  };
}

/** What the worker's move job takes. */
export interface MoveRequest {
  worldId: string;
  place: string;
  moves: { object: string; xMm: number; zMm: number; yawDeg: number }[];
  userId: string;
  nonce: string;
}

/** What the worker's ask job takes. */
export interface AskRequest {
  worldId: WorldId;
  place: string;
  object: string;
  request: string;
  nonce: string;
}

const AskBody = z.strictObject({
  object: z.string().regex(/^obj_[0-9a-z]{3,40}$/),
  request: z.string().trim().min(2).max(300),
});

type Vars = { Variables: { actor: Actor; handle: string | null; requestId: string } };

export const SESSION_COOKIE = "aye_session";

const notFound = () => new HTTPException(404, { message: "not found" });
const signInRequired = () => new HTTPException(401, { message: "sign in required" });

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 10)
      .map((i) => ({ path: i.path.join("."), message: i.message }));
    throw new HTTPException(400, {
      res: Response.json({ error: "invalid_request", issues }, { status: 400 }),
    });
  }
  return result.data;
}

const IdParam = z
  .string()
  .max(64)
  .regex(/^[a-z]{3}_[0-9a-z]{3,40}$/);

const MoveBody = z.strictObject({
  moves: z
    .array(
      z.strictObject({
        object: ObjectId,
        xMm: z.int().min(-10_000_000).max(10_000_000),
        zMm: z.int().min(-10_000_000).max(10_000_000),
        yawDeg: z.int().min(0).max(359),
      }),
    )
    .min(1)
    .max(64),
});

const HomeBody = z.strictObject({
  place: SpecKey,
  request: z.string().trim().min(2).max(300),
});

const Credentials = z.strictObject({ handle: Handle, password: Password });

/** What a video may be: the formats phones record. */
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const VIDEO_UPLOAD_PATH = /^\/worlds\/[^/]+\/captures(\/pieces)?$/;
const VIDEO_PIECE_PATH = /^\/worlds\/[^/]+\/captures\/pieces$/;

/** The one kind of request whose body isn't JSON: a video to the route that takes them. */
const isVideoUpload = (c: Context) =>
  c.req.method === "POST" &&
  VIDEO_UPLOAD_PATH.test(c.req.path) &&
  VIDEO_TYPES.has(c.req.header("content-type")?.split(";")[0]?.trim() ?? "");

const VOICE_PATH = /^\/worlds\/[^/]+\/voice$/;

/** The other kind: someone's voice, to the route that listens. */
const isVoice = (c: Context) =>
  c.req.method === "POST" &&
  VOICE_PATH.test(c.req.path) &&
  c.req.header("content-type")?.split(";")[0]?.trim() === "audio/wav";

const VoiceQuery = z.strictObject({ place: SpecKey.optional() });

const QuestionBody = z.strictObject({ question: z.string().trim().min(3).max(500) });

/** How a video is described: it's the body, so the rest travels in the query string. */
const CaptureQuery = z.strictObject({
  note: z.string().trim().max(300).default(""),
  x: z.coerce.number().finite().optional(),
  z: z.coerce.number().finite().optional(),
  durationMs: z.coerce.number().int().min(0).max(3_600_000).default(0),
  /** The pieces already sent for this, if it came that way. */
  upload: z.string().regex(UPLOAD_ID).optional(),
});

const PieceQuery = z.strictObject({
  upload: z.string().regex(UPLOAD_ID),
  index: z.coerce.number().int().min(0).max(1_000),
});

/** How far (metres) a filmed place stands from the edge of anything already there. */
const FILMED_PLACE_CLEAR_M = 30;

/**
 * Where a filmed place stands on the map: where the player put it, or a short way from where
 * they are now; either way kept on the map, and clear of what's already there unless no spot
 * within the search is.
 */
function whereItGoes(
  city: CitySpec,
  character: Character,
  x: number | undefined,
  z: number | undefined,
): [number, number] {
  const [maxX, maxZ] = city.real?.extentM ?? [4_000, 4_000];
  const onMap = (px: number, pz: number): [number, number] => [
    Math.round(Math.max(0, Math.min(maxX, px))),
    Math.round(Math.max(0, Math.min(maxZ, pz))),
  ];
  const places = placesOf(city);
  const home = city.starts.find((c) => c.key === character.start)?.home;
  const near = places.find((p) => p.key === (character.place ?? home));
  const [nx, nz] =
    x !== undefined && z !== undefined ? onMap(x, z) : (near?.at ?? [maxX / 2, maxZ / 2]);
  const isClear = (spot: readonly [number, number]) =>
    places.every(
      (p) =>
        Math.hypot(p.at[0] - spot[0], p.at[1] - spot[1]) >
        Math.max(p.sizeM[0], p.sizeM[1]) + FILMED_PLACE_CLEAR_M,
    );
  // Where they tapped, if that's free.
  if (x !== undefined && z !== undefined && isClear([nx, nz])) return [nx, nz];
  // The nearest open ground: widening circles around them until nothing else stands there.
  const start = Math.random() * 2 * Math.PI;
  for (let radius = 60; radius <= 900; radius += 60) {
    for (let step = 0; step < 8; step++) {
      const angle = start + (step * Math.PI) / 4;
      const spot = onMap(nx + radius * Math.cos(angle), nz + radius * Math.sin(angle));
      if (isClear(spot)) return spot;
    }
  }
  return onMap(nx + 60 * Math.cos(start), nz + 60 * Math.sin(start));
}

const NewPlaceBody = z.strictObject({
  name: z.string().trim().min(1).max(120),
  visibility: Visibility.default("private"),
  geo: GeoAnchor.nullable().default(null),
});

const PatchPlaceBody = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    visibility: Visibility.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "nothing to update");

const NearQuery = z.strictObject({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().int().min(1).max(50_000).default(2_000),
});

/** The head the owner reviewed and the spec they saw, so a stale review approves nothing. */
const ApproveWorldBody = z.strictObject({ head: ArtifactHash, spec: ArtifactHash });

const NewWorldBody = z.strictObject({
  description: z.string().trim().min(10).max(2_000),
  visibility: WorldVisibility.default("private"),
});

/** A person's body. Physics, so code: every character walks like an adult on foot. */
const DEFAULT_BODY: PersonDef["body"] = {
  widthMm: 450,
  stepMm: 200,
  stairs: true,
  slopePermille: 150,
  speedMmPerS: 1300,
  seated: false,
};

/** A player's person key in places: derived from the character id, never chosen. */
export const personKeyOf = (id: string) => `pc_${id.slice(4, 32)}`;

/** What someone is working towards, as the city wrote it for how they started. */
function aimOf(city: CitySpec, character: Character): Thread | null {
  const aim = city.starts.find((s) => s.key === character.start)?.aim;
  if (!aim) return null;
  return {
    id: `thr_aim${character.id.replace(/[^a-z0-9]/g, "").slice(0, 32)}`,
    title: aim.title,
    about: aim.about,
    icon: aim.icon,
    steps: aim.steps.map((st) =>
      "mark" in st
        ? { check: "mark" as const, mark: st.mark, atLeast: st.atLeast, text: st.text }
        : { check: "have_money" as const, atLeast: st.money, text: st.text },
    ),
    progress: 0,
    reward: aim.reward,
    from: 0,
    due: AIM_NEVER_DUE,
    state: "open",
    aim: true,
  };
}

/** What the city says a character looks like and starts with, from the player's picks. */
export function characterFor(
  city: CitySpec,
  worldId: WorldId,
  id: CharacterId,
  pick: NewCharacter,
): Omit<Character, "ownerId" | "updatedAt"> | null {
  const start = city.starts.find((s) => s.key === pick.start);
  const skin = city.looks.skin[pick.skin];
  const top = city.looks.outfit[pick.top];
  const bottom = city.looks.outfit[pick.bottom];
  const hair = city.looks.hair[pick.hair] ?? city.looks.hair[0];
  const look = city.characters[pick.look];
  const outfit = city.outfits[pick.outfit] ?? city.outfits[0];
  if (!start || !skin || !top || !bottom || (city.characters.length > 0 && !look)) return null;
  return {
    id,
    worldId,
    vehicle: null,
    billed: { day: -1, owes: 0 },
    home: null,
    start: start.key,
    place: null,
    transit: null,
    person: {
      key: personKeyOf(id),
      name: pick.name,
      about: start.label,
      colours: {
        skin,
        top,
        bottom,
        ...(hair ? { hair } : {}),
        accent: city.looks.outfit[(pick.top + 2) % city.looks.outfit.length] ?? top,
      },
      ...(look ? { look } : {}),
      ...(outfit ? { outfit } : {}),
      body: DEFAULT_BODY,
      money: start.money,
      needs: city.needs.map((n) => ({ need: n.key, start: 800 })),
    },
  };
}

/**
 * Who's asking, for rate limits. A forwarded-for header is anyone's to write, so it counts only
 * behind a proxy we've said is ours; otherwise it's the socket's own address.
 */
const clientIp = (c: Context) =>
  (process.env["TRUST_PROXY"] === "1"
    ? c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    : undefined) ??
  (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket
    ?.remoteAddress ??
  "local";

export function createApp({
  env,
  db,
  onSignOut,
  onPlaceChanged,
  onlineIn,
  uploads,
  store,
  content,
  enqueueCity,
  enqueueCapture,
  asks,
  moves,
  removals,
  homes,
  questions,
  transcribe,
}: AppDeps) {
  const app = new Hono<Vars>();
  const secure = env.NODE_ENV === "production";

  app.use(requestId());
  app.use(
    secureHeaders({
      // One strict policy for every response. `sandbox` matters for artifacts: even if a
      // browser renders a generated file directly, nothing in it can run or load.
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], sandbox: [] },
      crossOriginResourcePolicy: "same-site",
      referrerPolicy: "no-referrer",
    }),
  );
  app.use(
    cors({
      origin: env.WEB_ORIGIN,
      allowMethods: ["GET", "POST", "PATCH", "DELETE"],
      credentials: true,
      maxAge: 600,
    }),
  );
  // Everything is small, except a video being uploaded to the one route that takes them.
  const tooLarge = (c: Context) => c.json({ error: "payload_too_large" }, 413);
  const smallBody = bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge });
  const videoBody = bodyLimit({ maxSize: MAX_VIDEO_BYTES, onError: tooLarge });
  const pieceBody = bodyLimit({ maxSize: UPLOAD_PIECE_BYTES + 1024, onError: tooLarge });
  const voiceBody = bodyLimit({ maxSize: MAX_VOICE_BYTES, onError: tooLarge });
  app.use((c, next) =>
    isVideoUpload(c)
      ? VIDEO_PIECE_PATH.test(c.req.path)
        ? pieceBody(c, next)
        : videoBody(c, next)
      : isVoice(c)
        ? voiceBody(c, next)
        : smallBody(c, next),
  );

  // Cross-site request forgery: anything that changes state must be JSON (which a form on
  // another site can't send) and, when the browser names its origin, from our own. A video or
  // a voice can't be JSON; their types can't be sent by a form either, and a cross-site script
  // sending one is stopped by the preflight CORS refuses, so their routes take those instead.
  app.use(async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.method !== "OPTIONS") {
      const origin = c.req.header("origin");
      if (origin && !env.WEB_ORIGIN.includes(origin)) {
        return c.json({ error: "forbidden_origin" }, 403);
      }
      const type = c.req.header("content-type")?.split(";")[0]?.trim();
      if (type !== "application/json" && !isVideoUpload(c) && !isVoice(c)) {
        return c.json({ error: "json_required" }, 415);
      }
    }
    await next();
  });

  // Actor resolution: the session cookie; in development, optionally a test header.
  app.use(async (c, next) => {
    let { actor, handle } = await resolveSession(db, getCookie(c, SESSION_COOKIE));
    const devUser = c.req.header("x-aye-dev-user");
    if (actor.kind === "anonymous" && env.AYE_DEV_AUTH === "1" && !secure && devUser) {
      const id = UserId.safeParse(devUser);
      if (id.success) actor = { kind: "user", userId: id.data };
    }
    c.set("actor", actor);
    c.set("handle", handle);
    await next();
  });

  app.use(
    rateLimit({
      windowMs: 60_000,
      max: 300,
      key: (c) => {
        const actor = c.get("actor");
        return actor.kind === "user" ? `u:${actor.userId}` : `ip:${clientIp(c)}`;
      },
    }),
  );

  const user = (c: Context<Vars>) => {
    const actor = c.get("actor");
    if (actor.kind !== "user") throw signInRequired();
    return actor;
  };
  const json = async (c: Context) => c.req.json().catch(() => null);

  app.get("/health", (c) => c.json({ ok: true }));

  // ── Accounts ──────────────────────────────────────────────────────────────────────

  const authLimit = rateLimit({ windowMs: 60_000, max: 10, key: (c) => `auth:${clientIp(c)}` });
  const startSession = async (c: Context<Vars>, userId: UserId) => {
    const token = await createSession(db, userId);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_DAYS * 86_400,
    });
  };

  app.post("/auth/register", authLimit, async (c) => {
    const body = parse(Credentials, await json(c));
    const result = await registerUser(db, {
      id: randomId("user") as UserId,
      handle: body.handle,
      password: body.password,
    });
    if (!result.ok) return c.json({ error: "handle_taken" }, 409);
    await startSession(c, result.userId);
    return c.json({ handle: body.handle }, 201);
  });

  const guestLimit = rateLimit({
    windowMs: 3_600_000,
    max: 20,
    key: (c) => `guest:${clientIp(c)}`,
  });
  app.post("/auth/guest", guestLimit, async (c) => {
    // Where it's not allowed, there's no such thing.
    if (env.ALLOW_ANONYMOUS !== "1") throw notFound();
    const id = randomId("user") as UserId;
    const { handle } = await createGuest(db, id);
    await startSession(c, id);
    return c.json({ handle, guest: true }, 201);
  });

  const claimLimit = rateLimit({
    windowMs: 60_000,
    max: 10,
    key: (c) => `claim:${(c.get("actor") as { userId?: string }).userId ?? clientIp(c)}`,
  });
  app.post("/auth/claim", claimLimit, async (c) => {
    const actor = user(c);
    const body = parse(Credentials, await json(c));
    const result = await claimGuest(db, actor.userId, body);
    if (result === "taken") return c.json({ error: "handle_taken" }, 409);
    if (result === "not_a_guest") throw notFound();
    return c.json({ handle: body.handle });
  });

  /** What spends model credit takes an account, so nobody can run it up with endless guests. */
  const accountOnly = async (c: Context<Vars>, next: () => Promise<void>) => {
    const actor = c.get("actor");
    if (actor.kind === "user" && (await isGuest(db, actor.userId))) {
      return c.json({ error: "account_needed" }, 403);
    }
    await next();
    return undefined;
  };

  app.post("/auth/login", authLimit, async (c) => {
    const body = await json(c);
    const ok = await checkLogin(db, {
      handle: typeof body?.handle === "string" ? body.handle : "",
      password: typeof body?.password === "string" ? body.password : "",
    });
    if (!ok) return c.json({ error: "wrong_handle_or_password" }, 401);
    await startSession(c, ok.userId);
    return c.json({ handle: ok.handle });
  });

  app.post("/auth/logout", async (c) => {
    const actor = c.get("actor");
    await revokeSession(db, getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    if (actor.kind === "user") onSignOut?.(actor.userId);
    return c.json({ ok: true });
  });

  app.get("/me", async (c) => {
    const actor = c.get("actor");
    if (actor.kind !== "user") throw signInRequired();
    return c.json({ handle: c.get("handle"), guest: await isGuest(db, actor.userId) });
  });

  // ── Worlds (cities) ───────────────────────────────────────────────────────────────

  app.get("/worlds", async (c) => {
    const [found, typical] = await Promise.all([
      listWorlds(db, c.get("actor")),
      typicalBuildMinutes(db),
    ]);
    return c.json({
      worlds: found.map((w) => ({ ...w, online: onlineIn?.(w.id) ?? 0 })),
      typicalBuild: typical,
    });
  });

  /** What's open to walk into, for someone who hasn't signed up yet. */
  app.get("/open-cities", async (c) => {
    const open = await listOpenCities(db);
    return c.json({
      cities: open.map((w) => ({ ...w, online: onlineIn?.(w.id) ?? 0 })),
      guests: env.ALLOW_ANONYMOUS === "1",
    });
  });

  const createLimit = rateLimit({
    windowMs: 3_600_000,
    max: 5,
    key: (c) => `world:${(c.get("actor") as Actor & { userId?: string }).userId ?? clientIp(c)}`,
  });
  app.post("/worlds", createLimit, accountOnly, async (c) => {
    const actor = user(c);
    const body = parse(NewWorldBody, await json(c));
    const id = randomId("world") as WorldId;
    const world = await createWorld(db, actor, {
      id,
      name: "A new city",
      description: body.description,
      currency: "USD",
      visibility: body.visibility,
      settings: {
        seed: Number.parseInt(id.slice(4, 11), 36) % 2 ** 31,
        gridCellMm: 100,
        startMinuteOfDay: 7 * 60,
        ticksPerRealSecond: 30,
        tripMaxRealSec: TRIP_MAX_REAL_SEC,
        actionMaxRealSec: ACTION_MAX_REAL_SEC,
      },
    });
    await enqueueCity(id);
    return c.json({ world }, 201);
  });

  app.get("/worlds/:id", async (c) => {
    const id = parse(IdParam, c.req.param("id"));
    const world = await getWorld(db, c.get("actor"), id);
    if (!world) throw notFound();
    return c.json({ world });
  });

  /** Delete a world you own, and everything in it. Anyone else: not found. */
  app.delete("/worlds/:id", async (c) => {
    const actor = user(c);
    const id = parse(IdParam, c.req.param("id"));
    if (!(await deleteWorld(db, actor, id))) throw notFound();
    return c.json({ ok: true });
  });

  app.post("/worlds/:id/join", async (c) => {
    const id = parse(IdParam, c.req.param("id"));
    const role = await joinWorld(db, user(c), id);
    if (!role) throw notFound();
    return c.json({ role });
  });

  app.post("/worlds/:id/visibility", async (c) => {
    const id = parse(IdParam, c.req.param("id"));
    const body = parse(z.strictObject({ visibility: WorldVisibility }), await json(c));
    if (!(await setWorldVisibility(db, user(c), id, body.visibility))) throw notFound();
    return c.json({ visibility: body.visibility });
  });

  /** Your threads in a world: what you're in the middle of (yours only). */
  app.get("/worlds/:id/threads", async (c) => {
    const id = parse(IdParam, c.req.param("id"));
    return c.json({ threads: await listMyThreads(db, user(c), id) });
  });

  /** How much a model wrote for a city, as bare counts: for anyone who can see it exists. */
  app.get("/worlds/:id/making", async (c) => {
    const actor = user(c);
    const id = parse(IdParam, c.req.param("id"));
    const world = await getWorld(db, actor, id);
    if (!world?.city) throw notFound();
    const city = await content.city(world.city);
    let actions = 0;
    for (const spec of await listPinnedSpecs(db, actor, id)) {
      actions += catalogOf(await content.spec(spec)).actions.length;
    }
    return c.json({
      places: placesOf(city).length,
      actions,
      needs: city.needs.length,
      marks: city.marks.length,
      starts: city.starts.length,
      apps: city.ui.apps.length,
    });
  });

  /**
   * The city spec, plus what each built place offers (its actions, from its world spec), for
   * apps that list where to work, eat or spend. Members only.
   */
  app.get("/worlds/:id/city", async (c) => {
    const actor = user(c);
    const id = parse(IdParam, c.req.param("id"));
    const world = await getWorld(db, actor, id);
    if (!world?.city || !world.role) throw notFound();
    const city = await content.city(world.city);
    const catalog: Record<string, CatalogPlace> = {};
    for (const p of world.places) {
      const pinned = await getPinnedPlace(db, actor, id, p.key);
      if (!pinned?.spec) continue;
      catalog[p.key] = catalogOf(await content.spec(pinned.spec));
    }
    return c.json({
      city,
      catalog,
      createdAt: world.createdAt,
      settings: world.settings,
      yours: await listOwnedPlaceKeys(db, actor, id),
      removable: await listRemovablePlaceKeys(db, actor, id),
    });
  });

  app.get("/worlds/:id/character", async (c) => {
    const id = parse(IdParam, c.req.param("id"));
    const character = await getMyCharacter(db, user(c), id);
    return c.json({ character });
  });

  app.post("/worlds/:id/character", async (c) => {
    const actor = user(c);
    const id = parse(IdParam, c.req.param("id")) as WorldId;
    const pick = parse(NewCharacter, await json(c));
    const world = await getWorld(db, actor, id);
    if (!world?.city || !world.role) throw notFound();
    const city = await content.city(world.city);
    const draft = characterFor(city, id, randomId("character") as CharacterId, pick);
    if (!draft) return c.json({ error: "invalid_choice" }, 400);
    // Nobody starts a life with nowhere to wake up: the screen only offers homes that are built.
    const home = city.starts.find((s) => s.key === pick.start)?.home;
    const built = home ? await getPinnedPlace(db, actor, id, home) : null;
    if (!built?.spec) return c.json({ error: "home_not_ready" }, 409);
    const character = await createCharacter(db, actor, draft);
    if (!character) return c.json({ error: "cannot_create_character" }, 409);
    const aim = aimOf(city, character);
    if (aim) await addMyThread(db, actor, id, aim);
    return c.json({ character }, 201);
  });

  /**
   * Ask a thing for something it can't do yet. Anyone who can play may ask, a few times an
   * hour; the worker decides what's possible, and the place changes for everyone in it.
   */
  const askLimit = rateLimit({
    windowMs: 3_600_000,
    max: 8,
    key: (c) => `ask:${(c.get("actor") as { userId?: string }).userId ?? clientIp(c)}`,
  });
  app.post("/worlds/:id/places/:key/ask", askLimit, accountOnly, async (c) => {
    const actor = user(c);
    const id = parse(IdParam, c.req.param("id")) as WorldId;
    const key = parse(SpecKey, c.req.param("key"));
    const body = parse(AskBody, await json(c));
    const pinned = await getPinnedPlace(db, actor, id, key);
    if (!pinned?.spec) throw notFound();
    // Changing a place for everyone takes someone living in this city, not just an account.
    if (!(await getMyCharacter(db, actor, id))) throw notFound();
    const job = await asks.enqueue(actor.userId, {
      worldId: id,
      place: key,
      object: body.object,
      request: body.request,
      nonce: randomId("run").slice(4, 24),
    });
    return c.json({ job }, 202);
  });

  // ── Moving a thing, by hand ─────────────────────────────────────────────────────────

  const moveLimit = rateLimit({
    windowMs: 10 * 60_000,
    max: 120,
    key: (c) => `move:${(c.get("actor") as { userId?: string }).userId ?? clientIp(c)}`,
  });
  app.post("/worlds/:id/places/:key/move", moveLimit, async (c) => {
    const actor = user(c);
    const id = parse(IdParam, c.req.param("id")) as WorldId;
    const key = parse(SpecKey, c.req.param("key"));
    const { moves: asked } = parse(MoveBody, await json(c));
    const nonce = randomId("run").slice(4, 24);
    const world = await getWorld(db, actor, id);
    const character = world && (await getMyCharacter(db, actor, id));
    if (!world?.city || !character) throw notFound();
    // Your own home is your own copy of it.
    const city = await content.city(world.city);
    if (city.starts.find((s) => s.key === character.start)?.home === key) {
      if (!homes) throw notFound();
      const job = await homes.enqueue(actor.userId, {
        worldId: id,
        userId: actor.userId,
        place: key,
        moves: asked,
        nonce,
      });
      return c.json({ job, home: true }, 202);
    }
    // Any other place only if it's yours; to anyone else, there's nothing to move here.
    if (!moves || !(await listOwnedPlaceKeys(db, actor, id)).includes(key)) throw notFound();
    const job = await moves.enqueue(actor.userId, {
      worldId: id,
      place: key,
      moves: asked,
      userId: actor.userId,
      nonce,
    });
    return c.json({ job, home: false }, 202);
  });

  app.get("/moves/:job", async (c) => {
    const actor = user(c);
    const job = c.req.param("job");
    if (
      !/^move-usr_[0-9a-z]{3,40}-[0-9a-z]{6,32}$/.test(job) ||
      !job.startsWith(`move-${actor.userId}-`) ||
      !moves
    ) {
      throw notFound();
    }
    const status = await moves.status(job);
    if (!status) throw notFound();
    if (status.status === "done" && status.result.ok) {
      onPlaceChanged?.(status.result.worldId, status.result.place);
      return c.json({ status: "done", result: { ok: true } });
    }
    return c.json(status);
  });

  // ── Taking a filmed place away ──────────────────────────────────────────────────────

  const removeLimit = rateLimit({
    windowMs: 10 * 60_000,
    max: 20,
    key: (c) => `remove:${(c.get("actor") as { userId?: string }).userId ?? clientIp(c)}`,
  });
  app.delete("/worlds/:id/places/:key", removeLimit, async (c) => {
    const actor = user(c);
    const id = parse(IdParam, c.req.param("id")) as WorldId;
    const key = parse(SpecKey, c.req.param("key"));
    // What you filmed, or anything filmed in a city you own; to anyone else, there's nothing here.
    if (!removals || !(await listRemovablePlaceKeys(db, actor, id)).includes(key)) {
      throw notFound();
    }
    const job = await removals.enqueue(actor.userId, {
      worldId: id,
      place: key,
      userId: actor.userId,
      nonce: randomId("run").slice(4, 24),
    });
    return c.json({ job }, 202);
  });

  app.get("/removals/:job", async (c) => {
    const actor = user(c);
    const job = c.req.param("job");
    if (
      !/^remove-usr_[0-9a-z]{3,40}-[0-9a-z]{6,32}$/.test(job) ||
      !job.startsWith(`remove-${actor.userId}-`) ||
      !removals
    ) {
      throw notFound();
    }
    const status = await removals.status(job);
    if (!status) throw notFound();
    if (status.status === "done" && status.result.ok) {
      onPlaceChanged?.(status.result.worldId, status.result.place);
      return c.json({ status: "done", result: { ok: true } });
    }
    return c.json(status);
  });

  // ── Making your own home yours ──────────────────────────────────────────────────────

  const homeLimit = rateLimit({
    windowMs: 10 * 60_000,
    max: 12,
    key: (c) => `home:${(c.get("actor") as { userId?: string }).userId ?? clientIp(c)}`,
  });
  app.post("/worlds/:id/home", homeLimit, accountOnly, async (c) => {
    const actor = user(c);
    const id = parse(IdParam, c.req.param("id")) as WorldId;
    const { place, request } = parse(HomeBody, await json(c));
    const world = await getWorld(db, actor, id);
    const character = world && (await getMyCharacter(db, actor, id));
    if (!world?.city || !character || !homes) throw notFound();
    // Your own home, and nobody else's: to anyone else, there's nothing here to change.
    const city = await content.city(world.city);
    if (city.starts.find((s) => s.key === character.start)?.home !== place) throw notFound();
    const job = await homes.enqueue(actor.userId, {
      worldId: id,
      userId: actor.userId,
      place,
      request,
      nonce: randomId("run").slice(4, 24),
    });
    return c.json({ job }, 202);
  });

  app.get("/homes/:job", async (c) => {
    const actor = user(c);
    const job = c.req.param("job");
    if (
      !/^home-usr_[0-9a-z]{3,40}-[0-9a-z]{6,32}$/.test(job) ||
      !job.startsWith(`home-${actor.userId}-`) ||
      !homes
    ) {
      throw notFound();
    }
    const status = await homes.status(job);
    if (!status) throw notFound();
    // What it'd become is the server's business: the player sees what changes and the price.
    if (status.status === "done" && status.result.ok) {
      const { say, price, added, moved, removed } = status.result;
      return c.json({ status: "done", result: { ok: true, say, price, added, moved, removed } });
    }
    return c.json(status);
  });

  // ── Questions about a place ─────────────────────────────────────────────────────────

  const questionLimit = rateLimit({
    windowMs: 10 * 60_000,
    max: 12,
    key: (c) => `question:${(c.get("actor") as { userId?: string }).userId ?? clientIp(c)}`,
  });
  app.post("/worlds/:id/places/:key/questions", questionLimit, accountOnly, async (c) => {
    const actor = user(c);
    const id = parse(IdParam, c.req.param("id")) as WorldId;
    const key = parse(SpecKey, c.req.param("key"));
    const { question } = parse(QuestionBody, await json(c));
    // Anyone who plays in this world may ask about it; to anyone else it isn't there.
    const pinned = await getPinnedPlace(db, actor, id, key);
    if (!pinned?.spec) throw notFound();
    const job = await questions.enqueue(actor.userId, {
      worldId: id,
      placeKey: key,
      question,
      nonce: randomId("run").slice(4, 24),
    });
    return c.json({ job }, 202);
  });

  app.get("/questions/:job", async (c) => {
    const actor = user(c);
    const job = c.req.param("job");
    // Only the asker can see their answer (the id names them).
    if (
      !/^question-usr_[0-9a-z]{3,40}-[0-9a-z]{6,32}$/.test(job) ||
      !job.startsWith(`question-${actor.userId}-`)
    ) {
      throw notFound();
    }
    const status = await questions.status(job);
    if (!status) throw notFound();
    return c.json(status);
  });

  // ── Filming a real place into a city ────────────────────────────────────────────────

  const captureLimit = rateLimit({
    windowMs: 60 * 60_000,
    max: 12,
    key: (c) => `capture:${(c.get("actor") as { userId?: string }).userId ?? clientIp(c)}`,
  });
  const pieceLimit = rateLimit({
    windowMs: 60 * 60_000,
    max: 600,
    key: (c) => `piece:${(c.get("actor") as { userId?: string }).userId ?? clientIp(c)}`,
  });
  app.post("/worlds/:id/captures/pieces", pieceLimit, accountOnly, async (c) => {
    const actor = user(c);
    const id = parse(IdParam, c.req.param("id")) as WorldId;
    const { upload, index } = parse(PieceQuery, c.req.query());
    // Before reading a byte of it: only someone who plays here can send anything.
    const world = await getWorld(db, actor, id);
    const character = world && (await getMyCharacter(db, actor, id));
    if (!world?.city || world.status !== "ready" || !character || !uploads) throw notFound();
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength === 0) return c.json({ error: "empty_video" }, 400);
    const mediaType = c.req.header("content-type")?.split(";")[0]?.trim() ?? "";
    // JSON gets past the body check on every route, so being a video is checked here.
    if (!VIDEO_TYPES.has(mediaType)) return c.json({ error: "not_video" }, 415);
    const result = await uploads.piece(actor.userId, upload, index, bytes, mediaType);
    if (result === "too_large") return c.json({ error: "too_large" }, 413);
    if (result === "too_many") return c.json({ error: "too_many" }, 429);
    if (result === "out_of_order") return c.json({ error: "out_of_order" }, 409);
    return c.json({ ok: true });
  });

  app.post("/worlds/:id/captures", captureLimit, accountOnly, async (c) => {
    const actor = user(c);
    const id = parse(IdParam, c.req.param("id")) as WorldId;
    const query = parse(CaptureQuery, c.req.query());
    // Only someone who plays here can add to it; to anyone else it doesn't exist.
    const world = await getWorld(db, actor, id);
    const character = world && (await getMyCharacter(db, actor, id));
    if (!world?.city || world.status !== "ready" || !character) throw notFound();
    const city = await content.city(world.city);
    const whole = query.upload ? await uploads?.take(actor.userId, query.upload) : null;
    if (query.upload && !whole) return c.json({ error: "no_upload" }, 400);
    const sentAs = c.req.header("content-type")?.split(";")[0]?.trim() ?? "";
    if (!whole && !VIDEO_TYPES.has(sentAs)) return c.json({ error: "not_video" }, 415);
    const bytes = whole?.bytes ?? new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength === 0) return c.json({ error: "empty_video" }, 400);
    const mediaType =
      whole?.mediaType ?? (c.req.header("content-type")?.split(";")[0]?.trim() as string);
    const video = await store.put(bytes, mediaType);
    const place = await createPlace(db, actor, {
      id: randomId("place") as never,
      name: query.note || "A filmed place",
      visibility: "private",
      geo: null,
    });
    const capture = await createCapture(db, actor, {
      id: randomId("capture"),
      placeId: place.id,
      video,
      durationMs: query.durationMs,
      worldId: id,
    });
    if (!capture) throw notFound();
    await enqueueCapture({
      worldId: id,
      captureId: capture.id,
      note: query.note,
      at: whereItGoes(city, character, query.x, query.z),
    });
    return c.json({ capture: { id: capture.id } }, 202);
  });

  const voiceLimit = rateLimit({
    windowMs: 60_000,
    max: 30,
    key: (c) => `voice:${(c.get("actor") as { userId?: string }).userId ?? clientIp(c)}`,
  });
  app.post("/worlds/:id/voice", voiceLimit, accountOnly, async (c) => {
    const actor = user(c);
    const id = parse(IdParam, c.req.param("id")) as WorldId;
    const query = parse(VoiceQuery, c.req.query());
    // Only someone who plays here; to anyone else it doesn't exist.
    const world = await getWorld(db, actor, id);
    const character = world && (await getMyCharacter(db, actor, id));
    if (!world?.city || !character) throw notFound();
    if (!transcribe) return c.json({ error: "no_voice" }, 503);
    const wav = new Uint8Array(await c.req.arrayBuffer());
    if (!isSpeechWav(wav)) return c.json({ error: "bad_audio" }, 400);
    // What's likely to be said here, in the place's and the city's own words.
    const city = await content.city(world.city);
    const pinned = query.place ? await getPinnedPlace(db, actor, id, query.place) : null;
    const spec = pinned?.spec ? await content.spec(pinned.spec).catch(() => null) : null;
    const keywords = [
      ...(spec?.people.map((p) => p.name) ?? []),
      ...(spec?.kinds.flatMap((k) => [k.label, ...k.actions.map((a) => a.label)]) ?? []),
      ...placesOf(city).map((p) => p.name),
      city.name,
    ];
    const text = await transcribe(wav, [...new Set(keywords)], randomId("run")).catch(() => null);
    // Failing to hear is a shrug, not an error page; no detail either way.
    if (text === null) return c.json({ error: "not_heard" }, 502);
    return c.json({ text: cleanChat(text) });
  });

  app.get("/worlds/:id/captures/:capture", async (c) => {
    const capture = await getCapture(db, user(c), c.req.param("capture"));
    if (!capture || capture.worldId !== c.req.param("id")) throw notFound();
    return c.json({
      status: capture.status,
      phase: capture.phase,
      placeKey: capture.placeKey,
    });
  });

  app.get("/asks/:job", async (c) => {
    const actor = user(c);
    const job = c.req.param("job");
    // Only the asker can see their ask (the id names them).
    if (
      !/^ask-usr_[0-9a-z]{3,40}-[0-9a-z]{6,32}$/.test(job) ||
      !job.startsWith(`ask-${actor.userId}-`)
    ) {
      throw notFound();
    }
    const status = await asks.status(job);
    if (!status) throw notFound();
    return c.json(status);
  });

  // ── Places ────────────────────────────────────────────────────────────────────────

  app.get("/places", async (c) => c.json({ places: await listOwnPlaces(db, c.get("actor")) }));

  app.get("/places/near", async (c) => {
    const q = parse(NearQuery, c.req.query());
    return c.json({ places: await listPublicPlacesNear(db, c.get("actor"), q, q.radius) });
  });

  app.post("/places", async (c) => {
    const actor = user(c);
    const body = parse(NewPlaceBody, await json(c));
    const place = await createPlace(db, actor, { id: randomId("place") as never, ...body });
    return c.json({ place }, 201);
  });

  app.get("/places/:id", async (c) => {
    const id = parse(IdParam, c.req.param("id"));
    const place = await getPlace(db, c.get("actor"), id);
    if (!place) throw notFound();
    return c.json({ place });
  });

  app.patch("/places/:id", async (c) => {
    const id = parse(IdParam, c.req.param("id"));
    const patch = parse(PatchPlaceBody, await json(c));
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const place = await updatePlace(db, c.get("actor"), id, clean);
    if (!place) throw notFound();
    return c.json({ place });
  });

  /** The world at the place's head: its spec (written by a model) and whether it's approved. */
  app.get("/places/:id/world", async (c) => {
    const id = parse(IdParam, c.req.param("id"));
    const world = await getPlaceWorld(db, c.get("actor"), id);
    if (!world) throw notFound();
    if (world.spec === null) return c.json({ head: world.head, world: null });
    const bytes = await store.get(world.spec);
    if (!bytes) throw notFound();
    const spec = WorldSpec.parse(JSON.parse(new TextDecoder().decode(bytes)));
    return c.json({ head: world.head, world: { approved: world.approved, spec } });
  });

  /** The owner approves the world written for the place; commits a new revision. */
  app.post("/places/:id/world/approve", async (c) => {
    const actor = user(c);
    const id = parse(IdParam, c.req.param("id"));
    const body = parse(ApproveWorldBody, await json(c));
    const revision = await approveWorld(db, actor, id, body.head, body.spec);
    if (!revision) throw notFound();
    return c.json({ revision }, 201);
  });

  app.get("/artifacts/:hash", async (c) => {
    const hash = parse(ArtifactHash, c.req.param("hash"));
    if (!(await canReadArtifact(db, c.get("actor"), hash))) throw notFound();
    const [meta] = await db
      .select()
      .from(tables.artifacts)
      .where(eq(tables.artifacts.hash, hash))
      .limit(1);
    const bytes = await store.get(hash);
    if (!meta || !bytes) throw notFound();
    return new Response(bytes, {
      headers: {
        "content-type": meta.mediaType,
        "content-length": String(bytes.byteLength),
        // Content is immutable; "private" because access is per-user.
        "cache-control": "private, max-age=31536000, immutable",
        etag: `"${hash}"`,
        "x-content-type-options": "nosniff",
        "content-disposition": meta.mediaType.startsWith("image/") ? "inline" : "attachment",
      },
    });
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      if (err.res) return err.res;
      return c.json({ error: err.status === 404 ? "not_found" : err.message }, err.status);
    }
    if (err instanceof OutdatedContent) return c.json({ error: "outdated" }, 410);
    console.error({ requestId: c.get("requestId"), err });
    return c.json({ error: "internal_error", requestId: c.get("requestId") }, 500);
  });

  return app;
}

/** What a built place offers, for apps: every action, where it is, what it costs or pays. */
export interface CatalogPlace {
  name: string;
  actions: {
    kind: string;
    action: string;
    label: string;
    thing: string;
    cost: number;
    income: number;
    durationMin: number;
    needs: { need: string; perHour: number }[];
    asks: { mark: string; op: "gte" | "lte"; value: number }[];
    /** What doing it builds, by key. */
    marks: string[];
  }[];
}

export function catalogOf(spec: WorldSpec): CatalogPlace {
  return {
    name: spec.name,
    actions: spec.kinds.flatMap((k) =>
      k.actions
        .filter((a) => !ownersOnly(spec, k.key, a))
        .map((a) => ({
          kind: k.key,
          action: a.key,
          label: a.label,
          thing: k.label,
          cost: a.cost,
          income: a.income,
          durationMin: a.durationMin,
          needs: a.needs.filter((n) => n.perHour > 0),
          asks: a.asks ?? [],
          marks: (a.marks ?? []).filter((m) => m.by > 0).map((m) => m.mark),
        })),
    ),
  };
}
