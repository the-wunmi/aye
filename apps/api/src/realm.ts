/**
 * The realm: where shared worlds are actually played.
 *
 * Each place someone is in runs as a room: one authoritative Sim stepping in real time
 * (`ticksPerRealSecond`), on the city's shared clock. Players connect over a WebSocket, live as
 * their character, travel between places (paying fares the city sets, taking the time the
 * trip takes), take over people the world wrote, and talk. Private places (a home) run one
 * room per player.
 *
 * Trust: a connection is a signed-in player of the world, checked on
 * upgrade. Every message is size-capped, schema-checked and rate-limited; a player only ever
 * commands their own character or the one person they hold; the sim then decides what is
 * possible. Money and needs live in the sim while in a place and are saved from it when the
 * character leaves, never from anything the client says. Content is loaded only through
 * actor-scoped repositories.
 */
import { randomId } from "@aye/artifacts";
import {
  type Actor,
  type Db,
  getMyCharacter,
  getPinnedPlace,
  getWorld,
  listMyThreads,
  postChat,
  recentChat,
  saveCharacter,
  saveMyThread,
  type WorldDetail,
} from "@aye/db";
import {
  type ArtifactHash,
  advance,
  type Character,
  type ChatLine,
  type CitySpec,
  type ClientCommand,
  ClientMessage,
  carryAsked,
  cityMinuteNow,
  closenessKey,
  emptyCost,
  MAX_CLIENT_MESSAGE_BYTES,
  moverNow,
  moverServes,
  moversOf,
  NEED_FILL_PERMILLE,
  type ObjectId,
  type PersonDef,
  placeOpen,
  placesOf,
  type RosterEntry,
  type Scene,
  type ServerMessage,
  settleBills,
  THREAD_BOUNDS,
  type Thread,
  type ThreadFacts,
  threadStakes,
  trip,
  tripPacePermille,
  type WorldSettings,
  type WorldSpec,
} from "@aye/schema";
import { type Command, MAX_PEOPLE, Sim, type SimEvent, snapshot, TAKEN } from "@aye/sim";
import type { Content } from "./content.ts";

/** What the realm needs from a socket: `ws` in production, a fake in tests. */
export interface RealmSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const OPEN = 1;
const LOOP_MS = 100;
/** Snapshots go out every this many loops (5 Hz); clients interpolate between them. */
const SNAP_EVERY = 2;
/** Skip snapshots to a socket that has this much unsent: slow clients can't build up memory. */
const MAX_BUFFERED = 1_000_000;
/** An empty room keeps running this long, so a quick return finds things as they were. */
const ROOM_LINGER_MS = 120_000;
const MAX_ROOMS = 500;
const MAX_PENDING = 256;
/** How often an occupied room checks for a newer revision of its place (every 10 s). */
const RELOAD_CHECK_LOOPS = 100;

/** A reply from someone in a place (see `ConverseJob` in @aye/worker). */
export interface ReplyRequest {
  worldId: string;
  placeKey: string;
  instance: string;
  playerName: string;
  said: string;
  arrived: boolean;
  present: string[];
  closeness: Record<string, number>;
  recent: { from: string; text: string }[];
}

export interface RealmDeps {
  db: Db;
  content: Content;
  /** What a job of a player's proposes for their home, once it's ready. */
  homeProposal?: (job: string) => Promise<{
    place: string;
    price: number;
    scene: string;
    spec: string;
    base: string;
  } | null>;
  /** Ask a place's people to answer a player (a model, in the worker); absent: they don't. */
  replies?: (request: ReplyRequest) => Promise<{
    person: string;
    name: string;
    text: string;
    /** How this left them feeling about the player: -1, 0 or 1. */
    warmth?: number;
    /** Something to do here they offered (checked again against the place before it's shown). */
    offer?: { kind: string; action: string; label: string };
  } | null>;
  /**
   * A player with nothing to do: their world's director gives them something (at most once
   * per `key`: a city day, or the thread they just ended). Absent: they wait for its next turn.
   */
  welcome?: (worldId: string, userId: string, key: string) => Promise<void>;
  now?: () => number;
  /** Timers (tests drive time by hand). */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** Token bucket: `rate` per second, bursts of `burst`. */
class Bucket {
  readonly #rate: number;
  readonly #burst: number;
  #tokens: number;
  #at: number;
  constructor(rate: number, burst: number, now: number) {
    this.#rate = rate;
    this.#burst = burst;
    this.#tokens = burst;
    this.#at = now;
  }
  take(now: number): boolean {
    this.#tokens = Math.min(this.#burst, this.#tokens + ((now - this.#at) / 1000) * this.#rate);
    this.#at = now;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}

/** A player walking in is greeted at most this often per room (real ms). */
const GREET_AGAIN_MS = 3 * 3600 * 1000;

/** How often a player's threads are re-read from the store (the director adds new ones). */
const THREADS_REFRESH_MS = 30_000;

interface Room {
  id: string;
  worldId: string;
  placeKey: string;
  instance: string;
  scene: Scene;
  spec: WorldSpec;
  sim: Sim;
  players: Set<Player>;
  /** Person key → the player whose character it is. */
  characters: Map<string, Player>;
  /** Person key → the player holding them. */
  held: Map<string, Player>;
  pending: Command[];
  departures: Map<string, (e: Extract<SimEvent, { type: "departed" }>) => void>;
  loop: unknown;
  loops: number;
  carry: number;
  emptySince: number | null;
  /** The pinned revision this room plays; a newer pin (someone asked for something) reloads it. */
  revision: string;
  checking: boolean;
  /** The place changed while it was being checked: look again as soon as that's done. */
  recheck?: boolean;
  /** Their own copy of a home: it doesn't follow the place's pinned revisions. */
  personal: boolean;
  /** Whose home this is (their person key), for a private place. */
  keeper: string | null;
  /** The last few lines said here (for whoever answers), and whether someone is answering. */
  recent: { from: string; text: string }[];
  replying: boolean;
  /** Said while someone was answering: answered next. */
  nextReply: { player: Player; said: string } | null;
  /** When each player was last greeted on walking in (real ms), by user id. */
  greeted: Map<string, number>;
}

interface Player {
  socket: RealmSocket;
  actor: Actor & { kind: "user" };
  handle: string;
  world: WorldDetail;
  city: CitySpec;
  character: Character;
  room: Room | null;
  holding: string | null;
  transit: unknown;
  messages: Bucket;
  chat: Bucket;
  strikes: number;
  closed: boolean;
  /** The last ride offer sent (JSON), so it's only sent again when it changes. */
  rideSent: string;
  /** A purchase is under way: another waits until it's settled. */
  buying?: boolean;
  /** Setting off is under way: a second trip can't start while the first is being arranged. */
  setting?: boolean;
  /** Their open threads, re-read now and then (the director adds new ones). */
  threads: Thread[];
  threadsAt: number;
  /** A check is running: the next waits, so a step is never counted (or paid) twice. */
  threadsBusy: boolean;
  /** Actions finished since the last check (kept while a check runs, so none is missed). */
  finished: { kind: string; action: string }[];
  /** When this connection arrived (higher is newer). */
  seq: number;
  /** When they last told their character to do something (real ms). */
  actedAt: number;
  /**
   * Their character is looking after themselves: a player who stops playing (puts the phone
   * down, leaves the tab open) doesn't leave someone starving on the spot. Any command takes
   * them back.
   */
  selfCare: boolean;
}

/** Logged, never thrown: one failed save must not take every room in the process down with it. */
const failed = (what: string) => (err: unknown) => {
  console.error(`realm: ${what} failed:`, err instanceof Error ? err.message : "unknown error");
};

/**
 * How long a player's character waits for them before looking after themselves (real ms): long
 * enough that someone watching a job finish or reading a panel is never overruled; it's
 * for players who have walked away.
 */
export const SELF_CARE_AFTER_MS = 10 * 60_000;

/** Strip control and invisible formatting characters; collapse whitespace. */

export function cleanChat(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

export class Realm {
  readonly #deps: Required<
    Omit<RealmDeps, "db" | "content" | "replies" | "homeProposal" | "welcome">
  > &
    Pick<RealmDeps, "db" | "content" | "replies" | "homeProposal" | "welcome">;
  readonly #rooms = new Map<string, Room>();
  #joins = 0;
  readonly #players = new Map<string, Player>();

  constructor(deps: RealmDeps) {
    this.#deps = {
      now: () => Date.now(),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
      ...deps,
    };
  }

  get roomCount(): number {
    return this.#rooms.size;
  }

  /** Online players in a world. */
  online(worldId: string): number {
    let n = 0;
    for (const p of this.#players.values()) if (p.world.id === worldId) n++;
    return n;
  }

  /**
   * A signed-in player of `world` connects as `character`. The caller has already checked the
   * session, the origin and that they may play this world, and loaded these through
   * actor-scoped repositories.
   */
  async join(
    socket: RealmSocket,
    args: {
      actor: Actor & { kind: "user" };
      handle: string;
      world: WorldDetail;
      city: CitySpec;
      character: Character;
      /** When this connection arrived, relative to others (higher is newer). */
      seq?: number;
    },
  ): Promise<{ message(raw: string | Buffer): void; close(): void }> {
    const now = this.#deps.now();
    const seq = args.seq ?? ++this.#joins;
    // One connection per player per world: a new tab takes over from the old one. Newer by
    // when it arrived, not when it finished joining: a page that reconnects in a hurry (or a
    // tab reloading) must not be knocked out by its own older connection finishing late.
    const id = `${args.world.id}:${args.actor.userId}`;
    const previous = this.#players.get(id);
    if (previous && previous.seq > seq) {
      socket.close(4000, "opened elsewhere");
      return { message: () => undefined, close: () => undefined };
    }
    if (previous) {
      // Closed first, so anything it still has in flight (entering a place) stops short.
      previous.closed = true;
      if (previous.transit) this.#deps.clearTimeout(previous.transit);
      previous.socket.close(4000, "opened elsewhere");
      await this.#leave(previous);
      // Leaving saved what they had by then: this copy, read before, would undo all of it.
      const fresh = await getMyCharacter(this.#deps.db, args.actor, args.world.id);
      if (fresh) args = { ...args, character: fresh };
    }
    const player: Player = {
      socket,
      ...args,
      room: null,
      holding: null,
      transit: null,
      messages: new Bucket(15, 30, now),
      chat: new Bucket(1, 4, now),
      strikes: 0,
      closed: false,
      rideSent: "null",
      threads: [],
      actedAt: this.#deps.now(),
      seq,
      selfCare: false,
      threadsAt: 0,
      threadsBusy: false,
      finished: [],
    };
    this.#players.set(id, player);
    this.#send(player, {
      t: "welcome",
      handle: args.handle,
      character: args.character.id,
      world: args.world.id,
    });
    // On the way somewhere (a trip outlives a disconnect), back where they were, or home.
    const trip = args.character.transit;
    if (trip) {
      this.#travel(player, trip.to, Math.max(0, Date.parse(trip.arrivesAt) - now), null);
    } else {
      const start = args.city.starts.find((s) => s.key === args.character.start);
      // Where they last were may have been taken away since.
      const there = placesOf(args.city).some((p) => p.key === args.character.place);
      const at = (there ? args.character.place : null) ?? start?.home ?? null;
      if (at) await this.#enter(player, at);
    }
    this.#broadcastPresence(args.world.id);
    void this.#welcomeIfIdle(player);

    return {
      message: (raw) => void this.#onMessage(player, raw).catch(failed("message")),
      close: () => {
        if (player.closed && this.#players.get(id) !== player) return;
        player.closed = true;
        if (this.#players.get(id) === player) this.#players.delete(id);
        if (player.transit) this.#deps.clearTimeout(player.transit);
        void this.#leave(player)
          .then(() => this.#broadcastPresence(args.world.id))
          .catch(failed("leave"));
      },
    };
  }

  /** A place just changed and someone's waiting to see it: don't leave it to the next check. */
  placeChanged(worldId: string, placeKey: string): void {
    for (const room of this.#rooms.values()) {
      if (room.worldId !== worldId || room.placeKey !== placeKey) continue;
      const someone = room.players.values().next().value;
      if (!someone) continue;
      if (room.checking) room.recheck = true;
      else void this.#reloadIfChanged(room, someone.world);
    }
  }

  /** Someone signed out: their open connections end too (sessions are checked on opening). */
  signedOut(userId: string): void {
    for (const [id, player] of this.#players) {
      if (id.endsWith(`:${userId}`)) player.socket.close(4001, "signed out");
    }
  }

  /** Stop every room (shutdown), saving everyone who is in one. */
  async stop(): Promise<void> {
    await Promise.all([...this.#players.values()].map((p) => this.#leave(p)));
    for (const room of this.#rooms.values()) this.#deps.clearInterval(room.loop);
    this.#rooms.clear();
  }

  // ── Clock ────────────────────────────────────────────────────────────────────────

  /** The city's clock: minutes since day 1 00:00, shared by every room of a world. */
  #cityMinutes(world: WorldDetail): number {
    return cityMinuteNow(world.createdAt, world.settings, this.#deps.now());
  }

  #clock(world: WorldDetail) {
    const m = this.#cityMinutes(world);
    return { day: Math.floor(m / 1440) + 1, minuteOfDay: m % 1440 };
  }

  // ── Messages ─────────────────────────────────────────────────────────────────────

  async #onMessage(player: Player, raw: string | Buffer): Promise<void> {
    if (player.closed) return;
    const now = this.#deps.now();
    const size = typeof raw === "string" ? raw.length * 3 : raw.byteLength;
    if (size > MAX_CLIENT_MESSAGE_BYTES || !player.messages.take(now)) {
      return this.#strike(player, "message", "too_much");
    }
    let value: unknown;
    try {
      value = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      return this.#strike(player, "message", "invalid");
    }
    const parsed = ClientMessage.safeParse(value);
    if (!parsed.success) return this.#strike(player, "message", "invalid");
    const msg = parsed.data;
    switch (msg.t) {
      case "ping":
        return this.#send(player, { t: "pong", n: msg.n });
      case "do":
        return this.#do(player, msg.cmd, msg.as);
      case "hold":
        return this.#hold(player, msg.agent);
      case "release":
        return this.#release(player);
      case "buy_home":
        return this.#buyHome(player, msg.job);
      case "say":
        if (!player.chat.take(now)) return this.#refuse(player, "say", "slow_down");
        return this.#say(player, msg.text);
      case "go":
        return this.#go(player, msg.place, msg.mode);
      case "drive":
        return this.#drive(player, msg.place);
    }
  }

  #strike(player: Player, what: string, reason: string): void {
    this.#refuse(player, what, reason);
    if (++player.strikes > 50) {
      player.closed = true;
      player.socket.close(4008, "too many bad messages");
    }
  }

  #refuse(player: Player, what: string, reason: string): void {
    this.#send(player, { t: "refused", what, reason });
  }

  #send(player: Player, message: ServerMessage): void {
    if (player.socket.readyState !== OPEN) return;
    player.socket.send(JSON.stringify(message));
  }

  // ── Acting ───────────────────────────────────────────────────────────────────────

  #do(player: Player, cmd: ClientCommand, as: string | undefined) {
    const room = player.room;
    if (!room) return this.#refuse(player, "do", "not_in_a_place");
    const own = player.character.person.key;
    const agent = as ?? own;
    // Only your own character, or the one person you hold.
    if (agent !== own && agent !== player.holding) return this.#refuse(player, "do", "not_yours");
    if (room.pending.length >= MAX_PENDING) return this.#refuse(player, "do", "busy");
    // Playing as someone they hold is still being here: their own character stays put.
    player.actedAt = this.#deps.now();
    if (player.selfCare) {
      player.selfCare = false;
      room.pending.push({ type: "control", agent: own, on: true });
      this.#send(player, { t: "selfCare", on: false });
    }
    room.pending.push(
      cmd.type === "use"
        ? { type: "use", agent, object: cmd.object, action: cmd.action }
        : cmd.type === "walk"
          ? { type: "walk", agent, x: cmd.x, z: cmd.z }
          : { type: "cancel", agent },
    );
  }

  #hold(player: Player, agent: string) {
    const room = player.room;
    if (!room) return this.#refuse(player, "hold", "not_in_a_place");
    if (room.sim.slotOf(agent) < 0) return this.#refuse(player, "hold", "not_here");
    // Only people the world wrote. Asking who's a player in the room isn't enough: someone leaving
    // stops being listed a moment before they stop being here, and could be taken in that moment.
    if (!room.spec.people.some((p) => p.key === agent)) {
      return this.#refuse(player, "hold", "a_player");
    }
    const holder = room.held.get(agent);
    if (holder && holder !== player) return this.#refuse(player, "hold", "taken");
    if (player.holding && player.holding !== agent) this.#release(player);
    room.held.set(agent, player);
    player.holding = agent;
    room.pending.push({ type: "control", agent, on: true });
    this.#broadcastRoster(room);
  }

  #release(player: Player): void {
    const room = player.room;
    const agent = player.holding;
    player.holding = null;
    if (!room || !agent) return;
    if (room.held.get(agent) === player) {
      room.held.delete(agent);
      room.pending.push({ type: "control", agent, on: false });
      this.#broadcastRoster(room);
    }
  }

  async #say(player: Player, text: string): Promise<void> {
    const room = player.room;
    if (!room) return this.#refuse(player, "say", "not_in_a_place");
    const clean = cleanChat(text);
    if (!clean) return;
    // Playing someone else, it's them talking; the server knows who, not the client.
    const heldSlot = player.holding ? room.sim.slotOf(player.holding) : -1;
    const speaking = (heldSlot >= 0 ? room.sim.people[heldSlot] : null) ?? player.character.person;
    const row = await postChat(this.#deps.db, player.actor, {
      id: randomId("message"),
      worldId: room.worldId,
      placeKey: room.placeKey,
      instance: room.instance,
      speaker: speaking.name,
      text: clean,
    });
    if (!row) return this.#refuse(player, "say", "not_allowed");
    const line: ChatLine = {
      id: row.id,
      from: row.speaker,
      agent: speaking.key,
      text: row.text,
      at: row.at,
    };
    for (const p of room.players) this.#send(p, { t: "said", line });
    this.#heard(room, line.from, line.text);
    void this.#answer(player, room, clean, false).catch(failed("answer"));
  }

  #heard(room: Room, from: string, text: string): void {
    room.recent.push({ from, text });
    if (room.recent.length > 8) room.recent.shift();
  }

  /**
   * Let someone in the place answer a player who spoke (or greet one who walked in), as a
   * model writes it in the worker. One answer at a time per room; a walk-in is greeted at
   * most every few hours. The reply goes to the room's chat like anyone's words, posted on
   * the player's behalf (they prompted it) under the person's name.
   */
  async #answer(player: Player, room: Room, said: string, arrived: boolean): Promise<void> {
    const replies = this.#deps.replies;
    if (!replies || player.closed) return;
    if (room.replying) {
      // One answer at a time, but someone speaking again isn't ignored: the latest gets its turn.
      if (!arrived) room.nextReply = { player, said };
      return;
    }
    const now = this.#deps.now();
    const uid = player.actor.userId;
    if (arrived && now - (room.greeted.get(uid) ?? 0) < GREET_AGAIN_MS) return;
    const players = new Set([...room.characters.keys(), ...room.held.keys()]);
    const present = room.spec.people
      .map((p) => p.key)
      .filter((k) => {
        const i = room.sim.slotOf(k);
        return i >= 0 && room.sim.present[i] === 1 && !players.has(k);
      });
    // Walking into an empty place: no one to greet them. Speaking in one: the place may answer.
    if (present.length === 0 && arrived) return;
    if (arrived) room.greeted.set(uid, now);
    room.replying = true;
    try {
      const reply = await replies({
        worldId: room.worldId,
        placeKey: room.placeKey,
        instance: room.instance,
        playerName: player.character.person.name,
        said,
        arrived,
        present,
        closeness: Object.fromEntries(
          present.map((k) => [
            k,
            room.sim.mark(room.sim.slotOf(player.character.person.key), closenessKey(k)),
          ]),
        ),
        recent: room.recent.slice(-8),
      });
      if (!reply || player.closed || !room.players.has(player)) return;
      const row = await postChat(this.#deps.db, player.actor, {
        id: randomId("message"),
        worldId: room.worldId,
        placeKey: room.placeKey,
        instance: room.instance,
        speaker: reply.name,
        text: cleanChat(reply.text),
      });
      if (!row) return;
      const line: ChatLine = {
        id: row.id,
        from: row.speaker,
        agent: reply.person,
        text: row.text,
        at: row.at,
      };
      // How someone feels about you is theirs to change, a step at a time: the server moves it.
      const warmth = Math.max(-1, Math.min(1, Math.trunc(reply.warmth ?? 0)));
      if (warmth !== 0) {
        room.pending.push({
          type: "mark",
          agent: player.character.person.key,
          mark: closenessKey(reply.person),
          by: warmth,
        });
      }
      // An offer is the player's to take: theirs alone, and only if it's really on offer here.
      const o = reply.offer;
      const slot = room.sim.slotOf(player.character.person.key);
      const action =
        o && slot >= 0 && room.sim.canDoNow(slot, o.kind, o.action)
          ? room.spec.kinds.find((k) => k.key === o.kind)?.actions.find((a) => a.key === o.action)
          : undefined;
      const offer =
        o && action
          ? {
              kind: o.kind,
              action: o.action,
              label: cleanChat(action.label).slice(0, 80),
              cost: action.cost,
              income: action.income,
            }
          : null;
      for (const p of room.players) {
        this.#send(
          p,
          p === player
            ? {
                t: "said",
                line,
                ...(offer ? { offer } : {}),
                ...(warmth !== 0 ? { warmth } : {}),
              }
            : { t: "said", line },
        );
      }
      this.#heard(room, line.from, line.text);
    } finally {
      room.replying = false;
      const next = room.nextReply;
      room.nextReply = null;
      if (next && room.players.has(next.player)) {
        void this.#answer(next.player, room, next.said, false).catch(failed("answer"));
      }
    }
  }

  // ── Travel ───────────────────────────────────────────────────────────────────────

  /**
   * The city as it is now: its director may have changed it (an event, a headline) since this
   * player joined. Read through their own access, like everything else they see.
   */
  async #fresh(player: Player): Promise<void> {
    const world = await getWorld(this.#deps.db, player.actor, player.world.id);
    if (!world?.city || world.city === player.world.city) return;
    player.city = await this.#deps.content.city(world.city);
    player.world = world;
  }

  async #go(player: Player, placeKey: string, modeKey: string): Promise<void> {
    if (player.transit || player.setting) return this.#refuse(player, "go", "already_travelling");
    player.setting = true;
    try {
      await this.#goNow(player, placeKey, modeKey);
    } finally {
      player.setting = false;
    }
  }

  /** Someone else's home doesn't exist for you: the map hides it, and this is what enforces it. */
  #mayGo(player: Player, dest: { key: string; private?: boolean }): boolean {
    if (!dest.private) return true;
    return player.city.starts.find((s) => s.key === player.character.start)?.home === dest.key;
  }

  async #goNow(player: Player, placeKey: string, modeKey: string): Promise<void> {
    await this.#fresh(player);
    const { city, world } = player;
    const dest = placesOf(city).find((p) => p.key === placeKey);
    const mode = moversOf(city).find((m) => m.key === modeKey);
    if (!dest || !mode || !this.#mayGo(player, dest)) return this.#refuse(player, "go", "unknown");
    if (player.room?.placeKey === placeKey) return this.#refuse(player, "go", "already_here");
    // Its hours and whatever the city is going through (a closure, a strike, a fuel queue).
    const minute = this.#cityMinutes(world);
    if (!placeOpen(dest, city.events, minute)) return this.#refuse(player, "go", "closed");
    const now = moverNow(mode, city.events, minute);
    if (!now.running) return this.#refuse(player, "go", "not_running");
    // Some doors open to those who've earned it: the server's check, from what it holds.
    const here = player.room;
    const heldNow = here ? here.sim.slotOf(player.character.person.key) : -1;
    const owned = (mark: string) =>
      here && heldNow >= 0 && here.sim.markKeys.includes(mark)
        ? here.sim.mark(heldNow, mark)
        : (player.character.person.marks?.find((m) => m.mark === mark)?.value ?? 0);
    if (dest.asks?.some((x) => owned(x.mark) < x.atLeast)) {
      return this.#refuse(player, "go", "lacks_mark");
    }
    const pinned = await getPinnedPlace(this.#deps.db, player.actor, world.id, placeKey);
    if (!pinned?.spec) return this.#refuse(player, "go", "not_built");
    const from = placesOf(city).find(
      (p) => p.key === (player.room?.placeKey ?? player.character.place),
    );
    if (!moverServes(mode, from?.key ?? null, placeKey)) {
      return this.#refuse(player, "go", "not_running");
    }
    const leg = trip(now, from ?? dest, dest, tripPacePermille(city, world.settings));
    const slot = player.room ? player.room.sim.slotOf(player.character.person.key) : -1;
    const wallet = slot >= 0 ? (player.room?.sim.wallet[slot] ?? 0) : player.character.person.money;
    if (wallet < leg.fare) return this.#refuse(player, "go", "cannot_afford");

    await this.#leave(player);
    // On the way: the fare is paid and needs wear down for the trip, as the city says. The trip
    // is saved, so disconnecting can't skip the journey.
    const decay = new Map(city.needs.map((n) => [n.key, n.decayPerHour]));
    // On foot, tiredness and hunger slow you down as they do in a place.
    const carried = new Map(player.character.person.needs.map((n) => [n.need, n.start]));
    const pace =
      mode.holds === 0 ? emptyCost(city.needs, (n) => carried.get(n.key) ?? 1).walkPermille : 1000;
    const tripMinutes = Math.ceil((leg.minutes * 1000) / pace);
    const etaMs = Math.round((tripMinutes * 60 * 1000) / world.settings.ticksPerRealSecond);
    player.character = {
      ...player.character,
      transit: { to: placeKey, arrivesAt: new Date(this.#deps.now() + etaMs).toISOString() },
      person: {
        ...player.character.person,
        money: player.character.person.money - leg.fare,
        needs: player.character.person.needs.map((n) => ({
          need: n.need,
          start: Math.max(
            0,
            n.start -
              Math.floor(
                (((decay.get(n.need) ?? 0) +
                  (mode.tires.find((t) => t.need === n.need)?.perHour ?? 0)) *
                  tripMinutes) /
                  60,
              ),
          ),
        })),
      },
    };
    await saveCharacter(this.#deps.db, player.actor, player.character);
    this.#travel(player, placeKey, etaMs, {
      from: from?.key ?? null,
      mode: mode.key,
      minutes: tripMinutes,
      fare: leg.fare,
    });
  }

  /**
   * Travel in your own vehicle: the one out with you, or one of yours where you are (it
   * leaves with you). No fare; time at the speed the world gave it. It goes back when you're
   * home again.
   */
  async #drive(player: Player, placeKey: string): Promise<void> {
    if (player.transit || player.setting) {
      return this.#refuse(player, "drive", "already_travelling");
    }
    player.setting = true;
    try {
      await this.#driveNow(player, placeKey);
    } finally {
      player.setting = false;
    }
  }

  async #driveNow(player: Player, placeKey: string): Promise<void> {
    await this.#fresh(player);
    const { city, world } = player;
    const dest = placesOf(city).find((p) => p.key === placeKey);
    if (!dest || !this.#mayGo(player, dest)) return this.#refuse(player, "drive", "unknown");
    if (player.room?.placeKey === placeKey) return this.#refuse(player, "drive", "already_here");
    if (!placeOpen(dest, city.events, this.#cityMinutes(world))) {
      return this.#refuse(player, "drive", "closed");
    }
    const ride = this.#ride(player, player.room);
    if (!ride) return this.#refuse(player, "drive", "no_vehicle");
    const pinned = await getPinnedPlace(this.#deps.db, player.actor, world.id, placeKey);
    if (!pinned?.spec) return this.#refuse(player, "drive", "not_built");
    const from = placesOf(city).find(
      (p) => p.key === (player.room?.placeKey ?? player.character.place),
    );
    const leg = trip(
      { speedKmh: ride.speedKmh, fare: { base: 0, perKm: 0 } },
      from ?? dest,
      dest,
      tripPacePermille(city, world.settings),
    );
    await this.#leave(player, ride.object ?? undefined);
    const decay = new Map(city.needs.map((n) => [n.key, n.decayPerHour]));
    const etaMs = Math.round((leg.minutes * 60 * 1000) / world.settings.ticksPerRealSecond);
    player.character = {
      ...player.character,
      transit: { to: placeKey, arrivesAt: new Date(this.#deps.now() + etaMs).toISOString() },
      // Out with them now (it was already, or it left home with them).
      vehicle: player.character.vehicle ?? {
        object: ride.object ?? "",
        label: ride.label,
        speedKmh: ride.speedKmh,
      },
      person: {
        ...player.character.person,
        needs: player.character.person.needs.map((n) => ({
          need: n.need,
          start: Math.max(0, n.start - Math.floor(((decay.get(n.need) ?? 0) * leg.minutes) / 60)),
        })),
      },
    };
    await saveCharacter(this.#deps.db, player.actor, player.character);
    this.#travel(player, placeKey, etaMs, {
      from: from?.key ?? null,
      mode: "",
      minutes: leg.minutes,
      fare: 0,
    });
  }

  /** Be on the way to `placeKey` for `etaMs`, then arrive. */
  #travel(
    player: Player,
    placeKey: string,
    etaMs: number,
    leg: { from: string | null; mode: string; minutes: number; fare: number } | null,
  ): void {
    this.#send(player, {
      t: "transit",
      from: leg?.from ?? null,
      to: placeKey,
      mode: leg?.mode ?? "",
      minutes: leg?.minutes ?? 0,
      fare: leg?.fare ?? 0,
      etaMs,
    });
    player.transit = this.#deps.setTimeout(() => {
      player.transit = null;
      if (!player.closed) void this.#enter(player, placeKey).catch(failed("enter"));
    }, etaMs);
  }

  // ── Rooms ────────────────────────────────────────────────────────────────────────

  async #room(player: Player, placeKey: string): Promise<Room | null> {
    const place = placesOf(player.city).find((p) => p.key === placeKey);
    if (!place) return null;
    const instance = place.private ? player.actor.userId : "";
    const id = `${player.world.id}:${placeKey}:${instance}`;
    const existing = this.#rooms.get(id);
    if (existing) return existing;
    if (this.#rooms.size >= MAX_ROOMS) return null;
    const pinned = await getPinnedPlace(this.#deps.db, player.actor, player.world.id, placeKey);
    if (!pinned?.spec) return null;
    // Your own home as you've made it, once you have.
    const own =
      place.private && player.character.home?.place === placeKey ? player.character.home : null;
    const [scene, ownSpec, placeSpec] = await Promise.all([
      this.#deps.content.scene(own?.scene ?? pinned.scene),
      this.#deps.content.spec(own?.spec ?? pinned.spec),
      this.#deps.content.spec(pinned.spec),
    ]);
    // What people have asked this place for reaches your copy of it too.
    const spec = own ? carryAsked(ownSpec, placeSpec) : ownSpec;
    // Another join may have made it while this one was loading.
    const raced = this.#rooms.get(id);
    if (raced) return raced;
    const settings: WorldSettings = {
      ...player.world.settings,
      startMinuteOfDay: this.#cityMinutes(player.world) % 1440,
      needFillPermille: NEED_FILL_PERMILLE,
    };
    const room: Room = {
      id,
      worldId: player.world.id,
      placeKey,
      instance,
      scene,
      spec,
      // In someone's own home, what nobody else owns is theirs (their car, their bed).
      sim: new Sim({
        scene,
        spec,
        settings,
        ...(place.private ? { keeper: player.character.person.key } : {}),
      }),
      keeper: place.private ? player.character.person.key : null,
      personal: own !== null,
      players: new Set(),
      characters: new Map(),
      held: new Map(),
      pending: [],
      departures: new Map(),
      loop: null,
      loops: 0,
      carry: 0,
      emptySince: null,
      revision: pinned.revision,
      checking: false,
      recent: [],
      replying: false,
      nextReply: null,
      greeted: new Map(),
    };
    room.loop = this.#deps.setInterval(() => this.#tick(room, player.world), LOOP_MS);
    this.#rooms.set(id, room);
    return room;
  }

  /** A room that throws takes itself down and sends its players back in, and nobody else. */
  #tick(room: Room, world: WorldDetail): void {
    try {
      this.#tickNow(room, world);
    } catch (err) {
      console.error(
        `room ${room.id} failed:`,
        err instanceof Error ? err.message : "unknown error",
      );
      this.#deps.clearInterval(room.loop);
      this.#rooms.delete(room.id);
      for (const p of room.players) p.socket.close(1011, "this place had a problem");
    }
  }

  #tickNow(room: Room, world: WorldDetail): void {
    room.carry += (world.settings.ticksPerRealSecond * LOOP_MS) / 1000;
    const ticks = Math.floor(room.carry);
    room.carry -= ticks;
    const events: SimEvent[] = [];
    let rosterChanged = false;
    for (let t = 0; t < ticks; t++) {
      const batch = t === 0 ? room.pending.splice(0) : [];
      for (const e of room.sim.step(batch)) {
        if (e.type === "departed") {
          room.departures.get(e.agent)?.(e);
          room.departures.delete(e.agent);
          rosterChanged = true;
        } else if (e.type === "arrived") {
          rosterChanged = true;
        }
        events.push(e);
      }
    }
    if (rosterChanged) this.#broadcastRoster(room);
    const now = this.#deps.now();
    for (const p of room.players) {
      if (!p.selfCare && now - p.actedAt >= SELF_CARE_AFTER_MS) {
        p.selfCare = true;
        room.pending.push({ type: "control", agent: p.character.person.key, on: false });
        this.#send(p, { t: "selfCare", on: true });
      }
    }
    if (room.players.size > 0) {
      const finished = events.filter(
        (e): e is Extract<SimEvent, { type: "action_finished" }> => e.type === "action_finished",
      );
      const kindOf =
        finished.length > 0
          ? new Map(room.spec.things.map((t) => [t.object as string, t.kind]))
          : null;
      for (const p of room.players) {
        for (const e of finished) {
          if (e.agent !== p.character.person.key && e.agent !== p.holding) continue;
          if (p.finished.length < 32) {
            p.finished.push({ kind: kindOf?.get(e.object) ?? "", action: e.action });
          }
        }
        this.#checkBills(p, room);
        void this.#checkThreads(p, room).catch(failed("threads"));
      }
    }
    if (room.loops % RELOAD_CHECK_LOOPS === 0) this.#keepHours(room, world);
    if (room.loops % RELOAD_CHECK_LOOPS === 0 && room.players.size > 0 && !room.checking) {
      void this.#reloadIfChanged(room, world);
    }
    if (events.length > 0) {
      const visible = events.filter((e) => e.type !== "departed");
      for (const p of room.players) {
        // Rejections are only news to the player whose command it was.
        const mine = visible.filter(
          (e) =>
            e.type !== "command_rejected" ||
            e.agent === p.character.person.key ||
            e.agent === p.holding,
        );
        if (mine.length > 0) this.#send(p, { t: "events", events: mine });
      }
    }
    if (++room.loops % SNAP_EVERY === 0 && room.players.size > 0) {
      const snap = { t: "snap" as const, ...snapshot(room.sim), clock: this.#clock(world) };
      const data = JSON.stringify(snap);
      for (const p of room.players) {
        if (p.socket.readyState === OPEN && p.socket.bufferedAmount < MAX_BUFFERED) {
          p.socket.send(data);
        }
        // Their own vehicle becoming ready (uncovered) or not: tell them when it changes.
        const r = this.#ride(p, room);
        const ride = r ? { label: r.label, speedKmh: r.speedKmh } : null;
        const json = JSON.stringify(ride);
        if (json !== p.rideSent) {
          p.rideSent = json;
          this.#send(p, { t: "ride", ride });
        }
      }
    }
    if (room.players.size === 0) {
      room.emptySince ??= this.#deps.now();
      if (this.#deps.now() - room.emptySince > ROOM_LINGER_MS && room.departures.size === 0) {
        this.#deps.clearInterval(room.loop);
        this.#rooms.delete(room.id);
      }
    } else {
      room.emptySince = null;
    }
  }

  /**
   * Buy what a job of theirs proposed for their own home. Everything comes from the server: the
   * job has to be theirs, they have to be home, and it has to still be a change from what's
   * there now. The price is taken from the sim; the room becomes the new home, live.
   */
  async #buyHome(player: Player, job: string): Promise<void> {
    if (player.buying) return this.#refuse(player, "do", "not_now");
    player.buying = true;
    try {
      await this.#buyHomeNow(player, job);
    } finally {
      player.buying = false;
    }
  }

  async #buyHomeNow(player: Player, job: string): Promise<void> {
    const me = player.actor.userId;
    const room = player.room;
    if (!/^home-usr_[0-9a-z]{3,40}-[0-9a-z]{6,32}$/.test(job) || !job.startsWith(`home-${me}-`)) {
      return this.#refuse(player, "do", "not_yours");
    }
    const key = player.character.person.key;
    const proposal = await this.#deps.homeProposal?.(job);
    if (!proposal || !room || room.keeper !== key || room.placeKey !== proposal.place) {
      return this.#refuse(player, "do", "not_now");
    }
    const here = player.character.home?.place === room.placeKey ? player.character.home : null;
    const pinned = here
      ? null
      : await getPinnedPlace(this.#deps.db, player.actor, player.world.id, room.placeKey);
    if ((here?.scene ?? pinned?.scene) !== proposal.base) {
      return this.#refuse(player, "do", "not_now");
    }
    const [scene, spec] = await Promise.all([
      this.#deps.content.scene(proposal.scene as ArtifactHash),
      this.#deps.content.spec(proposal.spec as ArtifactHash),
    ]);
    // Everything's loaded: from here to the charge nothing waits, so what's checked still holds.
    if (player.closed || player.room !== room) return this.#refuse(player, "do", "not_now");
    const slot = room.sim.slotOf(key);
    const wallet = slot >= 0 ? (room.sim.wallet[slot] ?? 0) : 0;
    if (slot < 0 || wallet < proposal.price) return this.#refuse(player, "do", "cannot_afford");
    // What this room has picked up since stays: the proposal was made from your saved copy.
    const upToDate = carryAsked(spec, room.spec);
    room.sim = Sim.rebuild(room.sim, {
      scene,
      spec: upToDate,
      settings: room.sim.settings,
      keeper: key,
    });
    room.scene = scene;
    room.spec = upToDate;
    room.personal = true;
    room.pending.push({ type: "charge", agent: key, amount: proposal.price });
    player.character = {
      ...player.character,
      home: {
        place: room.placeKey,
        scene: proposal.scene as ArtifactHash,
        spec: proposal.spec as ArtifactHash,
      },
      person: { ...player.character.person, money: wallet - proposal.price },
    };
    await saveCharacter(this.#deps.db, player.actor, player.character);
    this.#sendPlace(player, room, []);
    this.#broadcastRoster(room);
  }

  /** The sim can't see the clock or the city: tell it when this place closes and opens. */
  #keepHours(room: Room, world: WorldDetail): void {
    const someone = room.players.values().next().value;
    const place = someone && placesOf(someone.city).find((p) => p.key === room.placeKey);
    if (!someone || !place) return;
    const shut = !placeOpen(place, someone.city.events, this.#cityMinutes(world));
    if (shut !== (room.sim.shut === 1)) room.pending.push({ type: "shut", on: shut });
  }

  /** The place was taken away: everyone in it goes home, and says why. */
  async #placeGone(room: Room): Promise<void> {
    for (const player of [...room.players]) {
      await this.#fresh(player);
      const home = player.city.starts.find((s) => s.key === player.character.start)?.home;
      await this.#leave(player);
      this.#refuse(player, "place", "place_removed");
      if (home && home !== room.placeKey) await this.#enter(player, home);
    }
  }

  /** If the place has a newer pinned revision, carry the room over to it, live. */
  async #reloadIfChanged(room: Room, world: WorldDetail): Promise<void> {
    const someone = room.players.values().next().value;
    if (!someone) return;
    room.checking = true;
    try {
      // The director changes the city while people are in it: closures have to reach this room.
      const latest = await getWorld(this.#deps.db, someone.actor, room.worldId);
      if (latest?.city && latest.city !== someone.world.city) {
        const city = await this.#deps.content.city(latest.city);
        for (const p of room.players) {
          p.city = city;
          p.world = { ...p.world, city: latest.city };
        }
        this.#keepHours(room, world);
      }
      const pinned = await getPinnedPlace(this.#deps.db, someone.actor, world.id, room.placeKey);
      if (!pinned) {
        await this.#placeGone(room);
        return;
      }
      if (!pinned.spec || pinned.revision === room.revision) return;
      const [pinnedScene, pinnedSpec] = await Promise.all([
        this.#deps.content.scene(pinned.scene),
        this.#deps.content.spec(pinned.spec),
      ]);
      // Someone's own copy keeps its own layout, and takes what's been added to the place.
      const scene = room.personal ? room.scene : pinnedScene;
      const spec = room.personal ? carryAsked(room.spec, pinnedSpec) : pinnedSpec;
      room.revision = pinned.revision;
      // Either can change alone: a thing moved leaves what everything does exactly as it was.
      if (spec === room.spec && scene === room.scene) return;
      room.sim = Sim.rebuild(room.sim, {
        scene,
        spec,
        settings: room.sim.settings,
        ...(room.keeper ? { keeper: room.keeper } : {}),
      });
      room.scene = scene;
      room.spec = spec;
      for (const p of room.players) this.#sendPlace(p, room, []);
      this.#broadcastRoster(room);
    } catch {
      // Try again next time.
    } finally {
      room.checking = false;
      if (room.recheck) {
        room.recheck = false;
        void this.#reloadIfChanged(room, world);
      }
    }
  }

  #sendPlace(player: Player, room: Room, chat: ChatLine[]): void {
    this.#send(player, { t: "bills", owes: player.character.billed.owes, paid: 0, names: [] });
    this.#send(player, {
      t: "place",
      place: room.placeKey,
      scene: room.scene,
      spec: room.spec,
      you: player.character.person.key,
      things: room.sim.things.map((t) => ({ id: t.id, kind: t.kind.key, base: t.base })),
      ticksPerRealSecond: player.world.settings.ticksPerRealSecond,
      chat,
      ride: ((r) => {
        const ride = r ? { label: r.label, speedKmh: r.speedKmh } : null;
        player.rideSent = JSON.stringify(ride);
        return ride;
      })(this.#ride(player, room)),
    });
  }

  /**
   * The vehicle someone could travel in from here: the one already out with them, else one
   * of theirs here that's in (by the world's ownership, or their own home's), not in use.
   */
  #ride(
    player: Player,
    room: Room | null,
  ): { label: string; speedKmh: number; object: string | null } | null {
    const out = player.character.vehicle;
    if (out) return { label: out.label, speedKmh: out.speedKmh, object: null };
    if (!room) return null;
    const me = player.character.person.key;
    const kinds = new Map(room.spec.kinds.map((k) => [k.key, k]));
    for (const [t, thing] of room.sim.things.entries()) {
      const kind = kinds.get(thing.kind.key);
      if (!kind?.travel || thing.owner !== me) continue;
      // Out with them (they're arriving with it, and the sim brings it back) counts as here;
      // otherwise it must be ready to go out as the world says (uncovered, fuelled...).
      const returning = (room.sim.thingAway[t] as number) === TAKEN;
      if (!returning && !room.sim.readyToGoOut(t)) continue;
      const label = room.scene.objects.find((o) => o.id === thing.id)?.label ?? kind.label;
      return { label: label.slice(0, 80), speedKmh: kind.travel.speedKmh, object: thing.id };
    }
    return null;
  }

  async #enter(player: Player, placeKey: string): Promise<void> {
    const room = await this.#room(player, placeKey);
    if (!room) return this.#refuse(player, "enter", "unavailable");
    if (player.closed) return;
    const used = room.sim.present.reduce((a, b) => a + b, 0);
    if (used >= MAX_PEOPLE) return this.#refuse(player, "enter", "full");
    const person: PersonDef = player.character.person;
    room.players.add(player);
    room.characters.set(person.key, player);
    player.room = room;
    room.pending.push({ type: "arrive", person, controlled: true });
    player.actedAt = this.#deps.now();
    player.selfCare = false;
    this.#broadcastPresence(player.world.id);
    // Home again: what they took out is back where it lives (the sim returns it on arrival).
    const home = room.keeper === person.key && player.character.vehicle !== null;
    if (player.character.place !== placeKey || player.character.transit || home) {
      player.character = {
        ...player.character,
        place: placeKey,
        transit: null,
        ...(home ? { vehicle: null } : {}),
      };
      await saveCharacter(this.#deps.db, player.actor, player.character);
    }
    const chat = await recentChat(this.#deps.db, player.actor, {
      worldId: room.worldId,
      placeKey,
      instance: room.instance,
    });
    this.#sendPlace(
      player,
      room,
      chat.map((m) => ({ id: m.id, from: m.speaker, agent: null, text: m.text, at: m.at })),
    );
    // Someone here may notice them walk in.
    void this.#answer(player, room, "", true).catch(failed("answer"));
  }

  /** Leave the current place: their state comes back from the sim and is saved. */
  async #leave(player: Player, taking?: string): Promise<void> {
    const room = player.room;
    if (!room) return;
    this.#release(player);
    const key = player.character.person.key;
    // Not in yet (their arrival is still queued): withdraw it rather than queue a departure,
    // which the sim would apply first (departures sort before arrivals) and so miss.
    const queued = room.pending.findIndex((c) => c.type === "arrive" && c.person.key === key);
    if (queued >= 0 || room.sim.slotOf(key) < 0) {
      if (queued >= 0) room.pending.splice(queued, 1);
      room.players.delete(player);
      room.characters.delete(key);
      player.room = null;
      return;
    }
    const departed = new Promise<Extract<SimEvent, { type: "departed" }> | null>((resolve) => {
      room.departures.set(key, resolve);
      // If the room never steps again (stopping), don't wait forever.
      this.#deps.setTimeout(() => resolve(null), 5_000);
    });
    room.pending.push(
      taking
        ? { type: "depart", agent: key, taking: taking as ObjectId }
        : { type: "depart", agent: key },
    );
    room.players.delete(player);
    room.characters.delete(key);
    player.room = null;
    const e = await departed;
    if (!e) return;
    const kept = new Map(e.marks.map((m) => [m.mark, m.value]));
    const marks = [
      ...e.marks,
      ...(player.character.person.marks ?? []).filter((m) => !kept.has(m.mark)),
    ].slice(0, 64);
    const levels = new Map(e.needs.map((n) => [n.need, n.level]));
    const needs = [
      ...e.needs.map((n) => ({ need: n.need, start: Math.max(0, Math.min(1000, n.level)) })),
      ...player.character.person.needs.filter((n) => !levels.has(n.need)),
    ].slice(0, 12);
    player.character = {
      ...player.character,
      person: {
        ...player.character.person,
        money: Math.max(0, Math.round(e.wallet)),
        needs,
        marks,
      },
    };
    await saveCharacter(this.#deps.db, player.actor, player.character);
  }

  /**
   * Settle a player's bills once a city day falls, and take what they owe as they earn it. The
   * server's alone, from the city's spec and the sim's wallet: a client can't touch any of it.
   */
  #checkBills(player: Player, room: Room): void {
    const bills = player.city?.economy.bills ?? [];
    if (bills.length === 0) return;
    const me = player.character.person.key;
    const slot = room.sim.slotOf(me);
    if (slot < 0) return;
    const today = Math.floor(this.#cityMinutes(player.world) / 1440);
    const wallet = room.sim.wallet[slot] ?? 0;
    const was = player.character.billed;
    if (today === was.day && (was.owes === 0 || wallet === 0)) return;
    const settled = settleBills(bills, was, today, wallet, (mark) => room.sim.mark(slot, mark));
    player.character = { ...player.character, billed: settled.billed };
    if (settled.earned > 0) room.pending.push({ type: "grant", agent: me, amount: settled.earned });
    if (settled.paid > 0) room.pending.push({ type: "charge", agent: me, amount: settled.paid });
    if (settled.paid > 0 || settled.fell.length > 0 || settled.billed.owes !== was.owes) {
      this.#send(player, {
        t: "bills",
        owes: settled.billed.owes,
        paid: settled.paid,
        names: settled.fell.map((b) => b.name),
      });
    }
    // Saved with their money, from the sim, like everything else about them: saving here would
    // write the wallet as it was before this charge.
  }

  /**
   * Move a player's threads on by what just happened in their room: where they are, what they
   * finished, their money, who's here. Every check is the server's, from the sim; a finished
   * thread pays its reward into their wallet (a server-only grant).
   */
  async #checkThreads(player: Player, room: Room): Promise<void> {
    if (player.threadsBusy) return;
    player.threadsBusy = true;
    try {
      await this.#checkThreadsNow(player, room);
    } finally {
      player.threadsBusy = false;
    }
  }

  /** Nothing open that can still be done: ask the director for something (once a city day). */
  async #welcomeIfIdle(player: Player): Promise<void> {
    if (!this.#deps.welcome) return;
    const minute = this.#cityMinutes(player.world);
    const mine = await listMyThreads(this.#deps.db, player.actor, player.world.id).catch(() => []);
    player.threads = mine.filter(
      (t) => t.state === "open" && t.due + THREAD_BOUNDS.graceMinutes > minute,
    );
    player.threadsAt = this.#deps.now();
    if (player.threads.some((t) => !t.aim) || player.closed) return;
    await this.#deps
      .welcome(player.world.id, player.actor.userId, `day${Math.floor(minute / 1440)}`)
      .catch(() => undefined);
  }

  async #checkThreadsNow(player: Player, room: Room): Promise<void> {
    // What was finished counts once, for the threads open now (not for one given later).
    const finished = player.finished.splice(0);
    const now = this.#deps.now();
    if (now - player.threadsAt > THREADS_REFRESH_MS) {
      player.threadsAt = now;
      player.threads = (await listMyThreads(this.#deps.db, player.actor, player.world.id)).filter(
        (t) => t.state === "open",
      );
    }
    if (player.threads.length === 0 || player.closed) return;
    const me = player.character.person.key;
    const slot = room.sim.slotOf(me);
    if (slot < 0) return;
    const facts: ThreadFacts = {
      place: room.placeKey,
      wallet: room.sim.wallet[slot] ?? 0,
      marks: new Map(room.sim.markKeys.map((key) => [key, room.sim.mark(slot, key)])),
      finished,
      present: new Set(
        room.spec.people
          .map((p) => p.key)
          .filter((k) => {
            const i = room.sim.slotOf(k);
            return i >= 0 && room.sim.present[i] === 1;
          }),
      ),
    };
    const minute = this.#cityMinutes(player.world);
    const ended: string[] = [];
    for (const [i, thread] of player.threads.entries()) {
      const moved = advance(thread, facts, minute);
      if (!moved) continue;
      facts.finished = moved.finished;
      player.threads[i] = moved.thread;
      if (moved.reward > 0) room.pending.push({ type: "grant", agent: me, amount: moved.reward });
      // What rides on it: the server moves it, from the thread as the director wrote it.
      for (const s of threadStakes(moved.thread)) {
        room.pending.push({ type: "mark", agent: me, mark: s.mark, by: s.by });
      }
      await saveMyThread(this.#deps.db, player.actor, player.world.id, moved.thread);
      this.#send(player, { t: "thread", thread: moved.thread });
      if (moved.thread.state !== "open") ended.push(moved.thread.id);
    }
    player.threads = player.threads.filter((t) => t.state === "open");
    // Finished (or missed) the last thing they had on: the director gives them what's next.
    if (ended.length > 0 && !player.threads.some((t) => !t.aim) && this.#deps.welcome) {
      void this.#deps
        .welcome(player.world.id, player.actor.userId, `after-${ended[ended.length - 1]}`)
        .catch(() => undefined);
    }
  }

  #broadcastRoster(room: Room): void {
    const roster: RosterEntry[] = [];
    for (let i = 0; i < MAX_PEOPLE; i++) {
      const person = room.sim.people[i];
      if (!room.sim.present[i] || !person) continue;
      roster.push({
        slot: i,
        key: person.key,
        person,
        player: room.characters.get(person.key)?.handle ?? null,
        heldBy: room.held.get(person.key)?.handle ?? null,
      });
    }
    for (const p of room.players) this.#send(p, { t: "roster", roster });
  }

  #broadcastPresence(worldId: string): void {
    const online = this.online(worldId);
    // Public places only: who is in someone's home is nobody else's business.
    const places: Record<string, number> = {};
    for (const p of this.#players.values()) {
      if (p.world.id !== worldId || !p.room || p.room.instance !== "") continue;
      places[p.room.placeKey] = (places[p.room.placeKey] ?? 0) + 1;
    }
    for (const p of this.#players.values()) {
      if (p.world.id === worldId) this.#send(p, { t: "presence", online, places });
    }
  }
}
