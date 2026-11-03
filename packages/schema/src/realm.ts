/**
 * The realm protocol: what game clients and the realm server say to each other over a
 * WebSocket while people play a shared world.
 *
 * Clients send intents only: go somewhere, walk, use a thing, take over a
 * person, say something. Every message is validated with the strict schema below, sized
 * before parsing, and rate-limited; the server decides what each player may do (only their
 * own character, or someone they hold) and the sim decides what is possible. Nothing a client
 * sends can set needs, money, positions or time.
 *
 * The server streams snapshots of the place the player is in; the client interpolates
 * between them. Text from other players is display-only (React text nodes).
 */
import { z } from "zod";
import { ObjectId } from "./ids.ts";
import type { Thread } from "./threads.ts";
import { type PersonDef, SpecKey } from "./world-spec.ts";

/** Largest client message accepted, in bytes. */
export const MAX_CLIENT_MESSAGE_BYTES = 2_048;
export const CHAT_MAX_CHARS = 280;

const Mm = z.int().min(-1_000_000_000).max(1_000_000_000);

/** What a player may ask the person they act as (their character, or someone they hold) to do. */
export const ClientCommand = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("use"), object: ObjectId, action: SpecKey }),
  z.strictObject({ type: z.literal("walk"), x: Mm, z: Mm }),
  z.strictObject({ type: z.literal("cancel") }),
]);
export type ClientCommand = z.infer<typeof ClientCommand>;

export const ClientMessage = z.discriminatedUnion("t", [
  /** Travel to a place by a mode (fare and time from the city spec), or walk in if nearby. */
  z.strictObject({ t: z.literal("go"), place: SpecKey, mode: SpecKey }),
  /** Travel to a place in your own vehicle: the one out with you, or yours here. */
  z.strictObject({ t: z.literal("drive"), place: SpecKey }),
  /** Act as `as`: your own character (omit) or a person you hold. */
  z.strictObject({ t: z.literal("do"), cmd: ClientCommand, as: SpecKey.optional() }),
  /** Take over a person here nobody else holds, or let go. */
  z.strictObject({ t: z.literal("hold"), agent: SpecKey }),
  z.strictObject({ t: z.literal("release") }),
  z.strictObject({ t: z.literal("say"), text: z.string().min(1).max(CHAT_MAX_CHARS) }),
  /** Buy the change to your home that a job of yours proposed: the server knows what and how much. */
  z.strictObject({ t: z.literal("buy_home"), job: z.string().max(120) }),
  z.strictObject({ t: z.literal("ping"), n: z.int().min(0).max(1e9) }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Who is in a slot, for the client: their look, and who plays or holds them. */
export interface RosterEntry {
  slot: number;
  key: string;
  person: PersonDef;
  /** Handle of the player whose character this is, or null for a person the world wrote. */
  player: string | null;
  /** Handle of the player holding this person, if any. */
  heldBy: string | null;
}

export interface Snapshot {
  tick: number;
  clock: { day: number; minuteOfDay: number };
  /** x, z per slot, in millimetres. */
  positions: number[];
  modes: number[];
  poses: number[];
  /** Need levels out of 1000, slots × needs, in the spec's need order. */
  needs: number[];
  /** Marks, slots × marks, in the spec's mark order. */
  marks: number[];
  wallet: number[];
  thingVars: number[];
  thingAway: number[];
  resourcesOn: number[];
  /** 1 while the place is closed. */
  shut: number;
  /** What each slot is doing, as an action label, or "". */
  doing: string[];
  /** The thing each slot is sitting or lying at or on (its object id), or "". */
  using: string[];
  /** Per slot, for `using`: 1 on the thing itself, 0 beside it, 2 the world doesn't say. */
  on: number[];
}

export interface ChatLine {
  id: string;
  from: string;
  /** The speaker's person key here, so the client can float the words above them. */
  agent: string | null;
  text: string;
  at: string;
}

export type ServerMessage =
  | { t: "welcome"; handle: string; character: string; world: string }
  /** Entering a place: everything needed to draw and follow it. */
  | {
      t: "place";
      place: string;
      scene: unknown;
      spec: unknown;
      /** Your character's person key here. */
      you: string;
      things: { id: string; kind: string; base: number }[];
      ticksPerRealSecond: number;
      chat: ChatLine[];
      /** Your own vehicle you could travel in from here (out with you, or yours here). */
      ride: { label: string; speedKmh: number } | null;
    }
  | { t: "roster"; roster: RosterEntry[] }
  /** Your own vehicle you could travel in from here changed (ready, gone, back). */
  | { t: "ride"; ride: { label: string; speedKmh: number } | null }
  /** Where you stand with the city's bills; `paid` is what just went, if anything did. */
  | { t: "bills"; owes: number; paid: number; names: string[] }
  /** One of your threads moved on (a step done, finished and paid, or missed). */
  | { t: "thread"; thread: Thread }
  /** Your character is looking after themselves (you went quiet), or you took back over. */
  | { t: "selfCare"; on: boolean }
  | ({ t: "snap" } & Snapshot)
  | { t: "events"; events: unknown[] }
  | {
      t: "transit";
      from: string | null;
      to: string;
      mode: string;
      minutes: number;
      fare: number;
      /** Real milliseconds until arrival. */
      etaMs: number;
    }
  /** A line said here; `offer`: something to do here the speaker offered you (a button). */
  | {
      t: "said";
      line: ChatLine;
      /** What it costs and pays (minor units) is the place's, never the speaker's word. */
      offer?: { kind: string; action: string; label: string; cost: number; income: number };
      /** How that left them feeling about you: warmer 1, cooler -1. */
      warmth?: number;
    }
  /** Players online in the world, and how many are at each public place. */
  | { t: "presence"; online: number; places: Record<string, number> }
  | { t: "pong"; n: number }
  | { t: "refused"; what: string; reason: string };
