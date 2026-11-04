/**
 * The life simulation: a generic interpreter for a place's world spec.
 *
 * Nothing here knows what a bed, a generator or a car is. The spec (written by a model) says
 * what needs people have, what resources exist, what kinds of things there are, what state
 * they hold, and what actions read and change it. This class runs that, on top of physics it
 * does own: space, bodies, walking, reachability.
 *
 * People choose what to do by score: each available action is scored by how much it would
 * help their most urgent needs, discounted by distance. Actions that only change state (take
 * the cover off, open the door, start the generator) are worth what they unlock, found by
 * looking ahead a couple of steps, so someone who wants to drive will uncover the car first.
 *
 * Determinism contract: one tick is one simulated second; all state is integers
 * in typed arrays; one seeded RNG per subsystem; iteration in stable index order. Same scene +
 * spec + settings + command log ⇒ same `hash()` everywhere.
 *
 * Security contract: the only way in is `step(commands)`. Commands are intents
 * ("do this action on this thing", "walk there"), validated against the same rules people
 * follow. People can arrive and leave (players travelling between places) and be taken over by
 * a player, but only through commands, so all of it is in the log and the hash. Who may send
 * which command is the host's business (the realm server); the sim checks what is possible.
 *
 * People live in a fixed number of slots, so arrays never reallocate and indices stay stable
 * for renderers while people come and go.
 */
import type {
  ActionDef,
  Condition,
  ObjectId,
  PersonDef,
  Scene,
  WorldSettings,
  WorldSpec,
} from "@aye/schema";
import { heldActionTicks } from "@aye/schema";
import { buildNavGrid, cellCentre, type Mover, type NavGrid } from "./navgrid.ts";
import { labelRegions, PathFinder } from "./path.ts";
import { entryCells, objectUseCells } from "./reach.ts";
import { Rng } from "./rng.ts";

export const TICKS_PER_MINUTE = 60;
export const TICKS_PER_HOUR = 3600;
/** Internal need units per point. One tick of a "per hour" rate adds exactly that rate. */
export const NEED_SCALE = TICKS_PER_HOUR;
const NEED_MAX = 1000 * NEED_SCALE;
/** How far from a thing a person can use it: arm's length plus a step. Physics, not rules. */
export const USE_REACH_MM = 700;
/** How many state changes ahead people plan (uncover → open → drive is two). */
const LOOKAHEAD = 2;
/**
 * What an hour of ordinary pay (`WorldSpec.hourPay`) is worth to someone choosing what to
 * do, in the need points one action can deliver (a meal when starving is ~500): enough that
 * people work, not so much that they starve for it.
 */
const HOUR_PAY_POINTS = 50;
/** Most people in one place at once. Slots are preallocated. */
export const MAX_PEOPLE = 32;
/** Search budget for a walk-to-a-point command, so spam can't become a denial of service. */
const WALK_SEARCH_NODES = 50_000;

export const Mode = { Idle: 0, Walking: 1, Acting: 2, Away: 3 } as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

export const POSES = ["stand", "sit", "lie", "inside"] as const;

export type Command =
  | { type: "use"; agent: string; object: ObjectId; action: string }
  | { type: "cancel"; agent: string }
  /** Walk to a point on the floor, in millimetres. */
  | { type: "walk"; agent: string; x: number; z: number }
  /** A player takes over (or lets go of) a person: no choosing for themselves while held. */
  | { type: "control"; agent: string; on: boolean }
  /** Someone comes in by the entrance (a player's character arriving). */
  | { type: "arrive"; person: PersonDef; controlled: boolean }
  /**
   * Someone leaves the place, whatever they were doing; `departed` reports their state.
   * `taking`: a thing of theirs goes with them (their car); it's out until they're back.
   */
  | { type: "depart"; agent: string; taking?: ObjectId }
  /**
   * Money paid to someone by the city itself (a thread's reward). Server-only: no client
   * message becomes one (the realm's `ClientCommand` has no such type).
   */
  | { type: "grant"; agent: string; amount: number }
  /** Server only: moves one of someone's marks (a conversation that went well). */
  | { type: "mark"; agent: string; mark: string; by: number }
  /** Server only: takes what someone owes, never more than they have. */
  | { type: "charge"; agent: string; amount: number }
  /**
   * Server only: the place has closed or opened. Its hours are the city's, which the sim can't
   * see.
   */
  | { type: "shut"; on: boolean };

/** How far someone arriving stands from anyone already there: a body's width. */
const ARRIVAL_CLEAR_MM = 600;

/** The most one grant pays (minor units): a bound, whatever the server asks. */
const MAX_GRANT = 1_000_000_000;

/** A thing out with its owner (away until they come back), distinct from timed outings. */
export const TAKEN = 2_147_483_647;

/** How often someone left to themselves looks up from what they're doing, in ticks. */
const WAKE_CHECK_TICKS = 300;

/** Someone choosing for themselves only pays to top up a need that's under this. */
const WORTH_PAYING_BELOW_PERMILLE = 600;

/** Below this, someone choosing for themselves won't spend any more of a need. */
const TOO_LOW_TO_SPEND_PERMILLE = 200;
/** Someone left to themselves keeps at least two thirds of their money through a dear buy. */
const LEAVES_MOST_OF_WALLET = 3;

export type RejectReason =
  | "not_yours"
  | "lacks_mark"
  | "unknown_agent"
  | "unknown_object"
  | "not_offered"
  | "full"
  | "cannot_afford"
  | "closed"
  | "not_now"
  | "unreachable"
  | "already_here";

export type SimEvent =
  | {
      type: "action_started";
      tick: number;
      agent: string;
      object: ObjectId;
      action: string;
      paid: number;
    }
  | {
      type: "action_finished";
      tick: number;
      agent: string;
      object: ObjectId;
      action: string;
      earned: number;
      /** What running on empty took off the pay, so nobody wonders where it went. */
      docked?: number;
      /** How it turned out, if it could turn out more than one way. */
      say?: string;
      /** They practised and nothing came of it this time: worth telling them, or it looks off. */
      practiceMissed?: boolean;
    }
  | {
      type: "action_interrupted";
      tick: number;
      agent: string;
      object: ObjectId;
      action: string;
      reason: "cancelled" | "conditions";
    }
  | { type: "left"; tick: number; agent: string; object: ObjectId | null; minutes: number }
  | { type: "returned"; tick: number; agent: string; object: ObjectId | null }
  | { type: "resource_changed"; tick: number; resource: string; on: boolean }
  | { type: "arrived"; tick: number; agent: string; slot: number }
  | {
      type: "departed";
      tick: number;
      agent: string;
      slot: number;
      /** What they leave with: money (minor units) and need levels out of 1000. */
      wallet: number;
      needs: { need: string; level: number }[];
      marks: { mark: string; value: number }[];
    }
  | { type: "command_rejected"; tick: number; agent: string | null; reason: RejectReason };

/** A condition compiled to integers: on a thing var (by index) or on a resource. */
interface Test {
  resource: number;
  /** Index of the var within its kind, or -1 for a resource test. */
  var: number;
  op: 0 | 1 | 2 | 3;
  value: number;
}

interface CompiledAction {
  def: ActionDef;
  /** Global action index. */
  index: number;
  requires: Test[];
  needs: { need: number; perHour: number }[];
  sets: { var: number; value: number; forTicks: number }[];
}

interface CompiledKind {
  key: string;
  initial: number[];
  actions: CompiledAction[];
  supplies: { resource: number; when: Test[] }[];
}

interface SimThing {
  id: ObjectId;
  kind: CompiledKind;
  /** Whose it is (a person key), or null: only its owner may take it away. */
  owner: string | null;
  /** Offset of this thing's vars in `thingVars`. */
  base: number;
  useCells: Set<number>;
  aim: number;
}

export interface SimInit {
  scene: Scene;
  spec: WorldSpec;
  settings: WorldSettings;
  /** Who is here; defaults to the spec's people. Seated in key order. */
  people?: readonly PersonDef[];
  /** Exact seating instead (used when rebuilding, so slots never move). */
  slots?: readonly ({ person: PersonDef; controlled: boolean } | null)[];
  /** Someone's own home: things nobody in particular owns are theirs (a person key). */
  keeper?: string;
}

interface Body {
  regions: Int32Array;
  usableFrom: Set<number>[];
  size: Map<number, number>;
}

const byKey = (a: PersonDef, b: PersonDef) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

const OPS = { eq: 0, ne: 1, gte: 2, lte: 3 } as const;

export function moverOf(person: PersonDef): Mover {
  return {
    clearWidthMm: person.body.widthMm,
    maxStepRiseMm: person.body.stepMm,
    maxSlopePermille: person.body.slopePermille,
    canUseStairs: person.body.stairs,
  };
}

/** Whether a scene object is solid under a spec: things the spec doesn't mention are. */
export function solidity(spec: WorldSpec): (obj: Scene["objects"][number]) => boolean {
  const kinds = new Map(spec.kinds.map((k) => [k.key, k.solid]));
  const solidOf = new Map(spec.things.map((t) => [t.object as string, kinds.get(t.kind) ?? true]));
  return (obj) => solidOf.get(obj.id) ?? true;
}

export class Sim {
  tick = 0;
  readonly spec: WorldSpec;
  readonly settings: WorldSettings;
  readonly grid: NavGrid;
  readonly needKeys: string[];
  readonly resourceKeys: string[];
  readonly kinds: CompiledKind[];
  readonly actions: CompiledAction[];
  readonly things: SimThing[];
  /** Per slot: the person's key, or "" for an empty slot. */
  readonly agentIds: string[];
  readonly people: (PersonDef | null)[];

  // People, struct-of-arrays, one entry per slot.
  readonly present: Uint8Array;
  /** 1 while a player holds this person: they don't choose for themselves. */
  readonly controlled: Uint8Array;
  readonly needs: Int32Array;
  /** What stays with each person from place to place: slots × marks. */
  readonly marks: Int32Array;
  readonly markKeys: readonly string[];
  readonly #markMax: readonly number[];
  readonly wallet: Float64Array;
  readonly cell: Int32Array;
  readonly mode: Uint8Array;
  readonly targetThing: Int32Array;
  readonly targetAction: Int32Array;
  readonly actionEnd: Int32Array;
  /** How much faster than life the current action's effects run, permille (`heldActionTicks`). */
  readonly actionPace: Int32Array;
  readonly nextThink: Int32Array;
  readonly stepProgress: Int32Array;
  readonly speed: Int32Array;
  readonly paths: (number[] | null)[];
  readonly pathPos: Int32Array;
  readonly movers: Mover[];
  readonly #regions: Int32Array[];
  readonly #usableFrom: Set<number>[][];
  /** 1 while the place is closed: paid work and buying wait until it opens. */
  shut = 0;
  readonly #bodies = new Map<string, Body>();
  /** Cells under any thing's footprint: nobody arrives there. */
  readonly #underThings: number[];
  readonly #entries: number[];

  // Things and the place.
  readonly thingVars: Int32Array;
  /** Tick at which a timed var reverts to its initial value, or 0. */
  readonly revertAt: Int32Array;
  /** Tick until which a thing is away (taken out by someone), or 0. */
  readonly thingAway: Int32Array;
  readonly users: Uint8Array;
  readonly supplyOn: Uint8Array;
  readonly nextToggle: Int32Array;

  readonly #finder: PathFinder;
  readonly #decay: Int32Array;
  /** The needs that cost something when they run out, by index, with what they cost. */
  readonly #emptyCosts: readonly { need: number; pay: number; walk: number }[];
  #rngThink: Rng;
  #rngSupply: Rng;
  #rngOutcome: Rng;
  readonly #agentIndex: Map<string, number>;
  readonly #thingIndex: Map<string, number>;

  constructor({ scene, spec, settings, people, slots, keeper }: SimInit) {
    this.spec = spec;
    this.settings = settings;
    const entryPortal = scene.portals.find((p) => p.id === scene.entry) ?? scene.portals[0];
    const levelId = entryPortal?.levelId ?? (scene.levels[0] as Scene["levels"][number]).id;
    this.grid = buildNavGrid(scene, levelId, {
      cellMm: settings.gridCellMm,
      isSolid: solidity(spec),
    });
    this.#finder = new PathFinder(this.grid);

    this.needKeys = spec.needs.map((n) => n.key);
    this.resourceKeys = spec.resources.map((r) => r.key);
    const needIndex = new Map(this.needKeys.map((k, i) => [k, i]));
    const resourceIndex = new Map(this.resourceKeys.map((k, i) => [k, i]));

    this.actions = [];
    this.kinds = spec.kinds.map((k) => {
      const varIndex = new Map(k.vars.map((v, i) => [v.key, i]));
      const test = (c: Condition): Test =>
        "resource" in c
          ? { resource: resourceIndex.get(c.resource) ?? -1, var: -1, op: 0, value: 0 }
          : { resource: -1, var: varIndex.get(c.var) ?? -1, op: OPS[c.op], value: c.value };
      const actions = k.actions.map((a) => {
        const compiled: CompiledAction = {
          def: a,
          index: this.actions.length,
          requires: a.requires.map(test),
          needs: a.needs.flatMap((n) => {
            const need = needIndex.get(n.need);
            return need === undefined ? [] : [{ need, perHour: n.perHour }];
          }),
          sets: a.sets.flatMap((s) => {
            const v = varIndex.get(s.var);
            return v === undefined
              ? []
              : [{ var: v, value: s.value, forTicks: s.forMin * TICKS_PER_MINUTE }];
          }),
        };
        this.actions.push(compiled);
        return compiled;
      });
      return {
        key: k.key,
        initial: k.vars.map((v) => Math.min(v.initial, v.max)),
        actions,
        supplies: k.supplies.flatMap((s) => {
          const resource = resourceIndex.get(s.resource);
          return resource === undefined ? [] : [{ resource, when: s.when.map(test) }];
        }),
      };
    });
    const kindByKey = new Map(this.kinds.map((k) => [k.key, k]));
    const specKinds = new Map(spec.kinds.map((k) => [k.key, k]));

    // Things: scene objects on this level that the spec gives a kind.
    const defs = new Map(spec.things.map((t) => [t.object as string, t]));
    this.things = [];
    this.#thingIndex = new Map();
    let base = 0;
    const initialVars: number[] = [];
    for (const obj of scene.objects) {
      if (obj.levelId !== levelId) continue;
      const def = defs.get(obj.id);
      const kind = def ? kindByKey.get(def.kind) : undefined;
      if (!def || !kind) continue;
      const varDefs = specKinds.get(kind.key)?.vars ?? [];
      const vars = [...kind.initial];
      for (const s of def.state) {
        const v = varDefs.findIndex((x) => x.key === s.var);
        if (v >= 0) vars[v] = Math.min(s.value, (varDefs[v] as { max: number }).max);
      }
      initialVars.push(...vars);
      const useCells = objectUseCells(this.grid, obj, USE_REACH_MM);
      this.#thingIndex.set(obj.id, this.things.length);
      this.things.push({
        id: obj.id,
        kind,
        owner: def.owner ?? keeper ?? null,
        base,
        useCells: new Set(useCells),
        aim: useCells[0] ?? 0,
      });
      base += vars.length;
    }
    this.thingVars = Int32Array.from(initialVars);
    this.revertAt = new Int32Array(this.thingVars.length);
    this.thingAway = new Int32Array(this.things.length);
    this.users = new Uint8Array(this.things.length);

    // People, seated in key order so input order never matters.
    const seating =
      slots ??
      [...(people ?? spec.people)]
        .sort(byKey)
        .slice(0, MAX_PEOPLE)
        .map((person) => ({ person, controlled: false }));
    const n = MAX_PEOPLE;
    this.agentIds = new Array<string>(n).fill("");
    this.people = new Array<PersonDef | null>(n).fill(null);
    this.#agentIndex = new Map();
    this.present = new Uint8Array(n);
    this.controlled = new Uint8Array(n);
    this.needs = new Int32Array(n * this.needKeys.length);
    this.markKeys = (spec.marks ?? []).map((m) => m.key);
    this.#markMax = (spec.marks ?? []).map((m) => m.max);
    this.marks = new Int32Array(n * this.markKeys.length);
    this.wallet = new Float64Array(n);
    this.cell = new Int32Array(n);
    this.mode = new Uint8Array(n);
    this.targetThing = new Int32Array(n).fill(-1);
    this.targetAction = new Int32Array(n).fill(-1);
    this.actionEnd = new Int32Array(n);
    this.actionPace = new Int32Array(n).fill(1000);
    this.nextThink = new Int32Array(n);
    this.stepProgress = new Int32Array(n);
    this.speed = new Int32Array(n);
    this.paths = new Array(n).fill(null);
    this.pathPos = new Int32Array(n);
    this.movers = new Array(n);
    this.#regions = new Array(n);
    this.#usableFrom = new Array(n);
    this.#entries = entryCells(scene, this.grid);
    this.#underThings = [];
    for (const o of scene.objects) {
      if (o.levelId !== levelId) continue;
      const g = this.grid;
      const half = Math.max(o.size.w, o.size.d) / 2;
      const [ox, , oz] = o.transform.position;
      const x0 = Math.max(0, Math.floor((ox - half - g.originX) / g.cellMm));
      const x1 = Math.min(g.width - 1, Math.floor((ox + half - g.originX) / g.cellMm));
      const z0 = Math.max(0, Math.floor((oz - half - g.originZ) / g.cellMm));
      const z1 = Math.min(g.height - 1, Math.floor((oz + half - g.originZ) / g.cellMm));
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) this.#underThings.push(z * g.width + x);
      }
    }
    seating.slice(0, n).forEach((seat, i) => {
      // Stagger first decisions.
      if (seat) this.#seat(i, seat.person, seat.controlled, i);
    });

    this.#decay = Int32Array.from(spec.needs, (need) => need.decayPerHour);
    this.#emptyCosts = spec.needs.flatMap((need, j) =>
      need.whenEmpty
        ? [{ need: j, pay: need.whenEmpty.payPermille, walk: need.whenEmpty.walkPermille }]
        : [],
    );
    this.#rngThink = Rng.seeded(settings.seed, 1);
    this.#rngSupply = Rng.seeded(settings.seed, 2);
    this.#rngOutcome = Rng.seeded(settings.seed, 3);
    this.supplyOn = new Uint8Array(this.resourceKeys.length);
    this.nextToggle = new Int32Array(this.resourceKeys.length).fill(-1);
    spec.resources.forEach((r, i) => {
      if (!r.supply) return;
      const { uptimePermille, meanOutageMin } = r.supply;
      this.supplyOn[i] = uptimePermille > 0 ? 1 : 0;
      if (uptimePermille > 0 && uptimePermille < 1000 && meanOutageMin > 0) {
        this.nextToggle[i] = this.#drawDuration(uptimePermille, meanOutageMin, true);
      }
    });
  }

  /**
   * The same world after the place or its spec changed (a thing moved, an ability added):
   * time, randomness, supply, every thing's state and every person's needs, money and position
   * carried across. Deterministic, so changes can live in a command log.
   */
  static rebuild(prev: Sim, init: SimInit): Sim {
    const N = prev.needKeys.length;
    const fromSpec = new Map((init.people ?? init.spec.people).map((p) => [p.key, p]));
    const slots: ({ person: PersonDef; controlled: boolean } | null)[] = prev.people.map((p, i) => {
      if (!p || !prev.present[i]) return null;
      const def = fromSpec.get(p.key) ?? p;
      fromSpec.delete(p.key);
      return {
        person: {
          ...def,
          money: prev.wallet[i] as number,
          needs: prev.needKeys.map((need, j) => ({
            need,
            start: Math.floor((prev.needs[i * N + j] as number) / NEED_SCALE),
          })),
          marks: prev.markKeys.map((mark, j) => ({
            mark,
            value: prev.marks[i * prev.markKeys.length + j] as number,
          })),
        },
        controlled: prev.controlled[i] === 1,
      };
    });
    // People the new world adds take free slots, in key order.
    for (const person of [...fromSpec.values()].sort(byKey)) {
      const free = slots.indexOf(null);
      if (free < 0) break;
      slots[free] = { person, controlled: false };
    }
    const next = new Sim({ ...init, slots });
    next.tick = prev.tick;
    next.#rngThink = Rng.restore(prev.#rngThink.state());
    next.#rngSupply = Rng.restore(prev.#rngSupply.state());
    next.#rngOutcome = Rng.restore(prev.#rngOutcome.state());
    next.resourceKeys.forEach((k, i) => {
      const j = prev.resourceKeys.indexOf(k);
      if (j >= 0) {
        next.supplyOn[i] = prev.supplyOn[j] as number;
        next.nextToggle[i] = prev.nextToggle[j] as number;
      }
    });
    next.things.forEach((t, ti) => {
      const pi = prev.#thingIndex.get(t.id);
      if (pi === undefined) return;
      const pt = prev.things[pi] as SimThing;
      if (pt.kind.key !== t.kind.key) return;
      const count = Math.min(pt.kind.initial.length, t.kind.initial.length);
      for (let v = 0; v < count; v++) {
        next.thingVars[t.base + v] = prev.thingVars[pt.base + v] as number;
        next.revertAt[t.base + v] = prev.revertAt[pt.base + v] as number;
      }
      next.thingAway[ti] = prev.thingAway[pi] as number;
    });
    for (let i = 0; i < MAX_PEOPLE; i++) {
      if (!next.present[i] || prev.agentIds[i] !== next.agentIds[i] || !prev.present[i]) continue;
      const [x, z] = prev.position(i);
      next.cell[i] = next.#nearestUsableCell(i, x, z);
      next.nextThink[i] = next.tick + 1;
      next.#carryOnFrom(prev, i);
    }
    next.shut = prev.shut;
    return next;
  }

  /**
   * What someone was in the middle of carries on through a change to the place, if the thing and
   * the action are still there: buying a chair doesn't lose you the shift you're on.
   */
  #carryOnFrom(prev: Sim, i: number): void {
    const mode = prev.mode[i] as number;
    if (mode !== Mode.Acting && mode !== Mode.Away) return;
    const was = prev.things[prev.targetThing[i] as number];
    const doing = prev.actions[prev.targetAction[i] as number];
    if (!was || !doing) return;
    const t = this.#thingIndex.get(was.id);
    if (t === undefined) return;
    const thing = this.things[t] as SimThing;
    const action = thing.kind.actions.find((a) => a.def.key === doing.def.key);
    if (thing.kind.key !== was.kind.key || !action) return;
    this.mode[i] = mode;
    this.targetThing[i] = t;
    this.targetAction[i] = action.index;
    this.actionEnd[i] = prev.actionEnd[i] as number;
    this.actionPace[i] = prev.actionPace[i] as number;
    this.users[t] = (this.users[t] as number) + 1;
  }

  /** Where a body can go, labelled once per distinct body and shared. */
  #body(mover: Mover): Body {
    const key = `${mover.clearWidthMm}/${mover.maxStepRiseMm}/${mover.maxSlopePermille}/${mover.canUseStairs}`;
    let body = this.#bodies.get(key);
    if (!body) {
      const regions = labelRegions(this.grid, mover);
      const usableFrom = this.things.map(
        (t) => new Set([...t.useCells].map((c) => regions[c] as number).filter((r) => r >= 0)),
      );
      const size = new Map<number, number>();
      for (const r of regions) if (r >= 0) size.set(r, (size.get(r) ?? 0) + 1);
      body = { regions, usableFrom, size };
      this.#bodies.set(key, body);
    }
    return body;
  }

  /** Seat a person in slot `i`, arriving at the entrance opening onto most of their ground. */
  #seat(i: number, p: PersonDef, controlled: boolean, thinkIn: number): void {
    const N = this.needKeys.length;
    const mover = moverOf(p);
    const body = this.#body(mover);
    this.agentIds[i] = p.key;
    this.people[i] = p;
    this.#agentIndex.set(p.key, i);
    this.present[i] = 1;
    this.controlled[i] = controlled ? 1 : 0;
    this.movers[i] = mover;
    this.#regions[i] = body.regions;
    this.#usableFrom[i] = body.usableFrom;
    let spawn = this.#entries[0] ?? 0;
    let best = -1;
    for (const c of this.#entries) {
      const s = body.size.get(body.regions[c] as number) ?? 0;
      if (s > best) {
        best = s;
        spawn = c;
      }
    }
    const start = new Map(p.needs.map((x) => [x.need, x.start]));
    this.needKeys.forEach((k, j) => {
      this.needs[i * N + j] = Math.min(1000, Math.max(0, start.get(k) ?? 700)) * NEED_SCALE;
    });
    const carried = new Map((p.marks ?? []).map((x) => [x.mark, x.value]));
    this.markKeys.forEach((k, j) => {
      this.marks[i * this.markKeys.length + j] = Math.max(
        0,
        Math.min(this.#markMax[j] as number, carried.get(k) ?? 0),
      );
    });
    this.wallet[i] = p.money;
    this.cell[i] = this.#freeCellNear(spawn, body.regions, i);
    this.speed[i] = p.body.speedMmPerS;
    this.mode[i] = Mode.Idle;
    this.targetThing[i] = -1;
    this.targetAction[i] = -1;
    this.actionEnd[i] = 0;
    this.actionPace[i] = 1000;
    this.stepProgress[i] = 0;
    this.paths[i] = null;
    this.pathPos[i] = 0;
    this.nextThink[i] = this.tick + thinkIn;
  }

  /** Empty slot `i`, ending whatever they were doing (a car they took comes back with them). */
  #unseat(i: number, events: SimEvent[]): void {
    const N = this.needKeys.length;
    const t = this.targetThing[i] as number;
    if (this.mode[i] === Mode.Away && t >= 0) {
      const a = this.actions[this.targetAction[i] as number] as CompiledAction;
      if (a.def.leaves?.withThing) this.thingAway[t] = 0;
      this.users[t] = (this.users[t] as number) - 1;
      this.#idle(i);
    } else {
      this.#stop(i, events, "cancelled");
    }
    const key = this.agentIds[i] as string;
    events.push({
      type: "departed",
      tick: this.tick,
      agent: key,
      slot: i,
      wallet: this.wallet[i] as number,
      needs: this.needKeys.map((need, j) => ({
        need,
        level: Math.floor((this.needs[i * N + j] as number) / NEED_SCALE),
      })),
      marks: this.markKeys.map((mark, j) => ({
        mark,
        value: this.marks[i * this.markKeys.length + j] as number,
      })),
    });
    this.marks.fill(0, i * this.markKeys.length, (i + 1) * this.markKeys.length);
    this.#agentIndex.delete(key);
    this.agentIds[i] = "";
    this.people[i] = null;
    this.present[i] = 0;
    this.controlled[i] = 0;
    this.needs.fill(0, i * N, i * N + N);
    this.wallet[i] = 0;
    this.cell[i] = 0;
    this.mode[i] = Mode.Idle;
    this.targetThing[i] = -1;
    this.targetAction[i] = -1;
    this.actionEnd[i] = 0;
    this.actionPace[i] = 1000;
    this.nextThink[i] = 0;
    this.stepProgress[i] = 0;
    this.speed[i] = 0;
    this.pathPos[i] = 0;
  }

  /**
   * The nearest cell to `start` in the same region that nobody else stands on, so people
   * arriving together don't stack up. Breadth-first in a fixed neighbour order: deterministic.
   */
  #freeCellNear(start: number, regions: Int32Array, self: number): number {
    const region = regions[start] as number;
    const g = this.grid;
    // Not under a thing (a stall's awning, a table), and a body's width from anyone there.
    const under = new Set(this.#underThings);
    const reach = Math.ceil(ARRIVAL_CLEAR_MM / g.cellMm);
    const others: number[] = [];
    for (let j = 0; j < MAX_PEOPLE; j++) {
      if (j !== self && this.present[j]) others.push(this.cell[j] as number);
    }
    const free = (c: number) => {
      if (under.has(c)) return false;
      const x = c % g.width;
      const z = Math.floor(c / g.width);
      for (const o of others) {
        const dx = (o % g.width) - x;
        const dz = Math.floor(o / g.width) - z;
        if (dx * dx + dz * dz < reach * reach) return false;
      }
      return true;
    };
    if (region < 0 || free(start)) return start;
    const seen = new Set([start]);
    const queue = [start];
    for (let k = 0; k < queue.length && k < 8_000; k++) {
      const c = queue[k] as number;
      if (regions[c] === region && free(c)) return c;
      const x = c % g.width;
      for (const nb of [c - g.width, c + 1, c + g.width, c - 1]) {
        if (nb < 0 || nb >= g.width * g.height || seen.has(nb)) continue;
        if ((nb === c - 1 && x === 0) || (nb === c + 1 && x === g.width - 1)) continue;
        if (regions[nb] !== region) continue;
        seen.add(nb);
        queue.push(nb);
      }
    }
    return start;
  }

  /** Slot of a person by key, or -1. */
  slotOf(agent: string): number {
    return this.#agentIndex.get(agent) ?? -1;
  }

  #nearestUsableCell(i: number, x: number, z: number): number {
    const g = this.grid;
    const regions = this.#regions[i] as Int32Array;
    const cx = Math.min(g.width - 1, Math.max(0, Math.floor((x - g.originX) / g.cellMm)));
    const cz = Math.min(g.height - 1, Math.max(0, Math.floor((z - g.originZ) / g.cellMm)));
    const start = cz * g.width + cx;
    const seen = new Uint8Array(g.width * g.height);
    const queue = [start];
    seen[start] = 1;
    for (let k = 0; k < queue.length; k++) {
      const c = queue[k] as number;
      if ((regions[c] as number) >= 0) return c;
      const px = c % g.width;
      for (const nb of [c - 1, c + 1, c - g.width, c + g.width]) {
        if (nb < 0 || nb >= seen.length || seen[nb]) continue;
        if ((nb === c - 1 && px === 0) || (nb === c + 1 && px === g.width - 1)) continue;
        seen[nb] = 1;
        queue.push(nb);
      }
    }
    return this.cell[i] as number;
  }

  clock(): { day: number; minuteOfDay: number } {
    const minutes = this.settings.startMinuteOfDay + Math.floor(this.tick / TICKS_PER_MINUTE);
    return { day: Math.floor(minutes / 1440) + 1, minuteOfDay: minutes % 1440 };
  }

  need(agent: number, need: string): number {
    const k = this.needKeys.indexOf(need);
    if (k < 0) return 0;
    return Math.floor((this.needs[agent * this.needKeys.length + k] as number) / NEED_SCALE);
  }

  /** Resources being worked out right now; empty between calls, so never part of the state. */
  readonly #resolving = new Set<number>();

  /** Could person `i` do this now, on any of these things here? Walking there aside. */
  canDoNow(i: number, kind: string, action: string): boolean {
    for (let t = 0; t < this.things.length; t++) {
      const thing = this.things[t] as SimThing;
      if (thing.kind.key !== kind) continue;
      const a = thing.kind.actions.find((x) => x.def.key === action);
      if (a && !this.#cannotUse(i, t, a) && this.#canReach(i, t)) return true;
    }
    return false;
  }

  /** Is resource `r` available here now: public supply, or a thing supplying it? */
  resourceOn(r: number): boolean {
    if (this.supplyOn[r]) return true;
    // A supply that needs what it supplies (directly, or round a loop of things) can't start
    // itself. Specs are model-written, so that has to mean "off", never an endless loop.
    if (this.#resolving.has(r)) return false;
    this.#resolving.add(r);
    let on = false;
    for (let t = 0; t < this.things.length && !on; t++) {
      if ((this.thingAway[t] as number) > this.tick) continue;
      for (const s of (this.things[t] as SimThing).kind.supplies) {
        if (s.resource === r && this.#holds(t, s.when, null)) {
          on = true;
          break;
        }
      }
    }
    this.#resolving.delete(r);
    return on;
  }

  /** A thing's state by object id and var key, for renderers and tests. */
  thingVar(object: string, key: string): number | null {
    const t = this.#thingIndex.get(object);
    if (t === undefined) return null;
    const thing = this.things[t] as SimThing;
    const v =
      this.spec.kinds.find((k) => k.key === thing.kind.key)?.vars.findIndex((x) => x.key === key) ??
      -1;
    return v < 0 ? null : (this.thingVars[thing.base + v] as number);
  }

  step(commands: readonly Command[] = []): SimEvent[] {
    this.tick++;
    const events: SimEvent[] = [];
    this.#updateSupply(events);
    this.#revertTimed();
    this.#applyCommands(commands, events);
    for (let i = 0; i < MAX_PEOPLE; i++) {
      if (!this.present[i]) continue;
      this.#decayNeeds(i);
      switch (this.mode[i]) {
        case Mode.Idle:
          if (!this.controlled[i] && this.tick >= (this.nextThink[i] as number)) this.#think(i);
          break;
        case Mode.Walking:
          this.#walk(i, events);
          break;
        case Mode.Acting:
        case Mode.Away:
          this.#act(i, events);
          break;
      }
    }
    return events;
  }

  /**
   * FNV-1a over the mutable state, bar `paths` and `speed`. Equal hashes ⇒ same simulation. Only
   * tests compare them; the realm server is the one copy that runs.
   */
  hash(): string {
    let h = 0x811c9dc5;
    const mix = (v: number) => {
      const lo = (v % 2 ** 32) | 0;
      const hi = Math.floor(v / 2 ** 32) | 0;
      h = Math.imul(h ^ lo, 0x01000193);
      h = Math.imul(h ^ hi, 0x01000193);
    };
    mix(this.tick);
    mix(this.shut);
    for (const key of this.agentIds) {
      mix(key.length);
      for (let c = 0; c < key.length; c++) mix(key.charCodeAt(c));
    }
    for (const arr of [
      this.present,
      this.controlled,
      this.needs,
      this.marks,
      this.wallet,
      this.cell,
      this.mode,
      this.targetThing,
      this.targetAction,
      this.actionEnd,
      this.actionPace,
      this.nextThink,
      this.stepProgress,
      this.pathPos,
      this.thingVars,
      this.revertAt,
      this.thingAway,
      this.users,
      this.supplyOn,
      this.nextToggle,
    ]) {
      for (const v of arr) mix(v);
    }
    for (const v of this.#rngThink.state()) mix(v);
    for (const v of this.#rngSupply.state()) mix(v);
    for (const v of this.#rngOutcome.state()) mix(v);
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  /** World-space position of a person (cell centre, mm). Renderers interpolate between ticks. */
  position(agent: number): [x: number, z: number] {
    return cellCentre(this.grid, this.cell[agent] as number);
  }

  /** The thing person `agent` is using or heading to, and the action, or nulls. */
  activity(agent: number): { thing: ObjectId | null; action: ActionDef | null } {
    const t = this.targetThing[agent] as number;
    const a = this.targetAction[agent] as number;
    return {
      thing: t >= 0 ? (this.things[t] as SimThing).id : null,
      action: a >= 0 ? (this.actions[a] as CompiledAction).def : null,
    };
  }

  // ── Supply and timed state ────────────────────────────────────────────────────────

  #drawDuration(uptimePermille: number, meanOutageMin: number, on: boolean): number {
    const meanMin = on
      ? Math.max(
          1,
          Math.floor((meanOutageMin * uptimePermille) / Math.max(1, 1000 - uptimePermille)),
        )
      : meanOutageMin;
    const minutes = Math.floor(meanMin / 2) + this.#rngSupply.int(meanMin + 1);
    return this.tick + Math.max(1, minutes) * TICKS_PER_MINUTE;
  }

  #updateSupply(events: SimEvent[]): void {
    this.spec.resources.forEach((r, i) => {
      if (!r.supply || this.nextToggle[i] !== this.tick) return;
      const on = this.supplyOn[i] === 0;
      this.supplyOn[i] = on ? 1 : 0;
      this.nextToggle[i] = this.#drawDuration(r.supply.uptimePermille, r.supply.meanOutageMin, on);
      events.push({ type: "resource_changed", tick: this.tick, resource: r.key, on });
    });
  }

  #revertTimed(): void {
    for (const thing of this.things) {
      for (let v = 0; v < thing.kind.initial.length; v++) {
        const at = this.revertAt[thing.base + v] as number;
        if (at !== 0 && at <= this.tick) {
          this.thingVars[thing.base + v] = thing.kind.initial[v] as number;
          this.revertAt[thing.base + v] = 0;
        }
      }
    }
  }

  // ── Conditions ────────────────────────────────────────────────────────────────────

  /** Do all tests hold for thing `t`, against its vars or hypothetical ones? */
  #holds(t: number, tests: readonly Test[], vars: Int32Array | null): boolean {
    const thing = this.things[t] as SimThing;
    for (const c of tests) {
      if (c.var < 0) {
        if (c.resource < 0 || !this.resourceOn(c.resource)) return false;
        continue;
      }
      const v = vars ? (vars[c.var] as number) : (this.thingVars[thing.base + c.var] as number);
      const ok =
        c.op === 0
          ? v === c.value
          : c.op === 1
            ? v !== c.value
            : c.op === 2
              ? v >= c.value
              : v <= c.value;
      if (!ok) return false;
    }
    return true;
  }

  /** Players (other than `i`) walking to use thing `t`. */
  #playersHeadingTo(t: number, i: number): number {
    let n = 0;
    for (let j = 0; j < MAX_PEOPLE; j++) {
      if (j !== i && this.present[j] && this.controlled[j] && this.targetThing[j] === t) {
        if (this.mode[j] === Mode.Walking) n++;
      }
    }
    return n;
  }

  /** Stop one person the world wrote (not a player) who is using thing `t`, for `i`. */
  #makeRoom(i: number, t: number, events: SimEvent[]): void {
    for (let j = 0; j < MAX_PEOPLE; j++) {
      if (j === i || !this.present[j] || this.controlled[j]) continue;
      if (this.targetThing[j] !== t) continue;
      if (this.mode[j] === Mode.Acting) {
        this.#stop(j, events, "cancelled");
      } else if (this.mode[j] === Mode.Away) {
        // Out with it, or out on it: they're back, so it's here for the player.
        const out = this.actions[this.targetAction[j] as number] as CompiledAction;
        if (out.def.leaves?.withThing) this.thingAway[t] = 0;
        this.users[t] = (this.users[t] as number) - 1;
        this.#idle(j);
      } else continue;
      // Not straight back to it: they find something else to do.
      this.nextThink[j] = this.tick + TICKS_PER_MINUTE;
      return;
    }
  }

  #cannotUse(i: number, t: number, a: CompiledAction): RejectReason | null {
    if ((this.thingAway[t] as number) > this.tick) return "not_now";
    if ((this.users[t] as number) >= a.def.capacity) return "full";
    // For the world's people, a player on their way to it already has it.
    if (
      !this.controlled[i] &&
      (this.users[t] as number) + this.#playersHeadingTo(t, i) >= a.def.capacity
    ) {
      return "full";
    }
    // Nobody's there to pay you or take your money, but you can always sit, or get yourself out.
    if (this.shut && !a.def.leaves && (a.def.cost > 0 || a.def.income > 0)) return "closed";
    if ((this.wallet[i] as number) < a.def.cost) return "cannot_afford";
    if (!this.#holds(t, a.requires, null)) return "not_now";
    if (this.controlled[i] && !this.#hasMarks(i, a.def)) return "lacks_mark";
    // Only its owner takes a thing away for free (drives off in the car); anyone may use it
    // here, and a fare is what anyone pays to ride in what isn't theirs.
    const owner = (this.things[t] as SimThing).owner;
    if (
      a.def.leaves?.withThing &&
      a.def.cost === 0 &&
      owner !== null &&
      owner !== this.agentIds[i]
    ) {
      return "not_yours";
    }
    return null;
  }

  /**
   * Read-only: could someone go out with thing `t` right now, as far as the thing goes (its
   * state and supplies allow one of its go-out actions, and it isn't away or in use)?
   */
  readyToGoOut(t: number): boolean {
    const thing = this.things[t];
    if (!thing || (this.thingAway[t] as number) > this.tick || (this.users[t] as number) > 0) {
      return false;
    }
    return thing.kind.actions.some(
      (a) => a.def.leaves?.withThing === true && this.#holds(t, a.requires, null),
    );
  }

  /** Read-only: can the person in slot `i` reach somewhere they could use thing `t` from? */
  canReach(i: number, t: number): boolean {
    return this.present[i] === 1 && this.#canReach(i, t);
  }

  /** O(1): is there any path from the person to a cell where the thing can be used? */
  #canReach(i: number, t: number): boolean {
    const region = (this.#regions[i] as Int32Array)[this.cell[i] as number] as number;
    return region >= 0 && ((this.#usableFrom[i] as Set<number>[])[t] as Set<number>).has(region);
  }

  // ── Commands (player intents) ─────────────────────────────────────────────────────

  #applyCommands(commands: readonly Command[], events: SimEvent[]): void {
    const reject = (agent: string | null, reason: RejectReason) =>
      events.push({ type: "command_rejected", tick: this.tick, agent, reason });
    // What the server owes or is owed settles while they're still here, then leaving, then arrivals
    // in key order, then everything else in slot order. Commands that tie (two for one person) keep
    // the order they came in, which is the command log's.
    const rank = (c: Command) =>
      c.type === "shut" || c.type === "charge" || c.type === "grant" || c.type === "mark"
        ? 0
        : c.type === "depart"
          ? 1
          : c.type === "arrive"
            ? 2
            : 3;
    const keyOf = (c: Command) =>
      c.type === "arrive"
        ? c.person.key
        : c.type === "shut"
          ? -1
          : (this.#agentIndex.get(c.agent) ?? -1);
    const ordered = [...commands].sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      const ka = keyOf(a);
      const kb = keyOf(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    for (const cmd of ordered) {
      if (cmd.type === "shut") {
        this.shut = cmd.on ? 1 : 0;
        continue;
      }
      if (cmd.type === "arrive") {
        if (this.#agentIndex.has(cmd.person.key)) {
          reject(cmd.person.key, "already_here");
          continue;
        }
        const free = this.present.indexOf(0);
        if (free < 0) {
          reject(cmd.person.key, "full");
          continue;
        }
        this.#seat(free, cmd.person, cmd.controlled, 1);
        // What they took with them comes back with them.
        this.things.forEach((thing, t) => {
          if (thing.owner === cmd.person.key && this.thingAway[t] === TAKEN) this.thingAway[t] = 0;
        });
        events.push({ type: "arrived", tick: this.tick, agent: cmd.person.key, slot: free });
        continue;
      }
      const i = this.#agentIndex.get(cmd.agent);
      if (i === undefined) {
        reject(null, "unknown_agent");
        continue;
      }
      if (cmd.type === "depart") {
        if (cmd.taking !== undefined) {
          const t = this.#thingIndex.get(cmd.taking);
          const thing = t === undefined ? undefined : this.things[t];
          if (t === undefined || !thing) reject(cmd.agent, "unknown_object");
          else if (thing.owner !== cmd.agent) reject(cmd.agent, "not_yours");
          else if ((this.thingAway[t] as number) > this.tick || (this.users[t] as number) > 0) {
            reject(cmd.agent, "not_now");
          } else this.thingAway[t] = TAKEN;
        }
        this.#unseat(i, events);
        continue;
      }
      if (cmd.type === "grant") {
        const amount = Math.max(0, Math.min(MAX_GRANT, Math.floor(cmd.amount)));
        this.wallet[i] = (this.wallet[i] as number) + amount;
        continue;
      }
      if (cmd.type === "mark") {
        this.#moveMark(i, cmd.mark, Math.floor(cmd.by));
        continue;
      }
      if (cmd.type === "charge") {
        const amount = Math.max(0, Math.min(this.wallet[i] as number, Math.floor(cmd.amount)));
        this.wallet[i] = (this.wallet[i] as number) - amount;
        continue;
      }
      if (cmd.type === "control") {
        this.controlled[i] = cmd.on ? 1 : 0;
        if (!cmd.on) this.nextThink[i] = this.tick + 1;
        continue;
      }
      if (cmd.type === "cancel") {
        if (this.mode[i] !== Mode.Away) this.#stop(i, events, "cancelled");
        continue;
      }
      if (this.mode[i] === Mode.Away) {
        reject(cmd.agent, "not_now");
        continue;
      }
      if (cmd.type === "walk") {
        this.#walkTo(i, cmd.x, cmd.z, events, reject);
        continue;
      }
      const t = this.#thingIndex.get(cmd.object);
      if (t === undefined) {
        reject(cmd.agent, "unknown_object");
        continue;
      }
      const thing = this.things[t] as SimThing;
      const a = thing.kind.actions.find((x) => x.def.key === cmd.action);
      if (!a) {
        reject(cmd.agent, "not_offered");
        continue;
      }
      // Cheap O(1) reachability first, so spamming impossible intents never costs a search.
      const reachable = this.#canReach(i, t);
      // The world's people make room for players: someone the world wrote steps away from a
      // thing a player wants (the stall is theirs to run when no player is around).
      if (reachable && this.controlled[i]) {
        const first = this.#cannotUse(i, t, a);
        if (
          first === "full" ||
          (first === "not_now" && (this.thingAway[t] as number) > this.tick)
        ) {
          this.#makeRoom(i, t, events);
        }
      }
      const why = reachable ? this.#cannotUse(i, t, a) : "unreachable";
      if (why) {
        reject(cmd.agent, why);
        continue;
      }
      const path = this.#finder.find(
        this.cell[i] as number,
        this.#freeUseCells(i, t),
        thing.aim,
        this.movers[i] as Mover,
      );
      if (!path) {
        reject(cmd.agent, "unreachable");
        continue;
      }
      this.#stop(i, events, "cancelled");
      this.#beginWalk(i, t, a.index, path);
    }
  }

  #walkTo(
    i: number,
    x: number,
    z: number,
    events: SimEvent[],
    reject: (agent: string | null, reason: RejectReason) => void,
  ): void {
    const g = this.grid;
    const agent = this.agentIds[i] as string;
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      reject(agent, "unreachable");
      return;
    }
    const regions = this.#regions[i] as Int32Array;
    const from = this.cell[i] as number;
    const home = regions[from] as number;
    const fromX = from % g.width;
    const fromZ = (from - fromX) / g.width;
    // Off the map counts as a long way in that direction: pushing against the edge is still a
    // direction to walk in.
    const cx = Math.max(0, Math.min(g.width - 1, Math.floor((x - g.originX) / g.cellMm)));
    const cz = Math.max(0, Math.min(g.height - 1, Math.floor((z - g.originZ) / g.cellMm)));
    // Someone heading for a wall walks up to it. O(cells on the line), bounded by the grid: back
    // along the straight line until there's somewhere this body can stand, connected to here.
    const steps = Math.max(Math.abs(cx - fromX), Math.abs(cz - fromZ));
    let goal = -1;
    for (let k = steps; k > 0; k--) {
      const c =
        (fromZ + Math.round(((cz - fromZ) * k) / steps)) * g.width +
        fromX +
        Math.round(((cx - fromX) * k) / steps);
      if (regions[c] === home && home >= 0) {
        goal = c;
        break;
      }
    }
    // Nowhere further that way, or asked to stay put: they stay (and stop, if they were walking).
    if (goal < 0) goal = from;
    const path = this.#finder.find(
      this.cell[i] as number,
      new Set([goal]),
      goal,
      this.movers[i] as Mover,
      WALK_SEARCH_NODES,
    );
    if (!path) {
      reject(agent, "unreachable");
      return;
    }
    // Steering is a stream of these: losing the step under way each time would make a held key
    // walk slower and stutter than one long walk.
    const stride = this.mode[i] === Mode.Walking ? (this.stepProgress[i] as number) : 0;
    this.#stop(i, events, "cancelled");
    this.#beginWalk(i, -1, -1, path);
    this.stepProgress[i] = stride;
  }

  // ── Choosing what to do ───────────────────────────────────────────────────────────

  #decayNeeds(i: number): void {
    const N = this.needKeys.length;
    for (let k = 0; k < N; k++) {
      const v = (this.needs[i * N + k] as number) - (this.#decay[k] as number);
      this.needs[i * N + k] = Math.max(0, v);
    }
  }

  /** Nobody left to themselves takes on what eats further into a need that's nearly gone. */
  #wouldDrain(i: number, a: CompiledAction): boolean {
    const N = this.needKeys.length;
    for (const e of a.needs) {
      if (e.perHour >= 0) continue;
      const level = Math.floor((this.needs[i * N + e.need] as number) / NEED_SCALE);
      if (level < TOO_LOW_TO_SPEND_PERMILLE) return true;
    }
    return false;
  }

  /**
   * Someone left to themselves doesn't sleep through starving: a need has run out, what they're
   * doing does nothing for it, they could see to it here, and what they're doing can wait.
   */
  #somethingMoreUrgent(i: number, doing: CompiledAction): boolean {
    const N = this.needKeys.length;
    for (const e of doing.needs) {
      if (e.perHour <= 0) continue;
      const level = Math.floor((this.needs[i * N + e.need] as number) / NEED_SCALE);
      if (level < TOO_LOW_TO_SPEND_PERMILLE) return false;
    }
    for (let k = 0; k < N; k++) {
      if ((this.needs[i * N + k] as number) > 0) continue;
      if (doing.needs.some((e) => e.need === k && e.perHour > 0)) continue;
      for (let t = 0; t < this.things.length; t++) {
        if (!this.#canReach(i, t)) continue;
        for (const b of (this.things[t] as SimThing).kind.actions) {
          if (b.needs.some((e) => e.need === k && e.perHour > 0) && !this.#cannotUse(i, t, b)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Nobody left to themselves pays for what they don't really need yet, or spends a lot of what
   * they have: past an hour's pay, only for a need that's nearly gone, and only if it leaves
   * them most of their money. It's someone's wallet, and they may be away from the keyboard.
   */
  #wouldWaste(i: number, a: CompiledAction): boolean {
    // What sets them back at what they've worked for is their own decision to make.
    if ((a.def.marks ?? []).some((m) => m.by < 0)) return true;
    if (a.def.cost <= 0) return false;
    const N = this.needKeys.length;
    let lowest = NEED_MAX;
    for (const e of a.needs) {
      if (e.perHour <= 0) continue;
      lowest = Math.min(lowest, Math.floor((this.needs[i * N + e.need] as number) / NEED_SCALE));
    }
    if (lowest >= WORTH_PAYING_BELOW_PERMILLE) return true;
    if (a.def.cost <= this.spec.hourPay) return false;
    return !(
      lowest < TOO_LOW_TO_SPEND_PERMILLE &&
      a.def.cost * LEAVES_MOST_OF_WALLET <= (this.wallet[i] as number)
    );
  }

  /** With a need nearly gone, only what sees to the lowest of them that can be seen to here. */
  #firstThingsFirst<C extends { a: number }>(i: number, candidates: C[]): C[] {
    const N = this.needKeys.length;
    let need = -1;
    let lowest = TOO_LOW_TO_SPEND_PERMILLE;
    for (const c of candidates) {
      for (const e of (this.actions[c.a] as CompiledAction).needs) {
        if (e.perHour <= 0) continue;
        const level = Math.floor((this.needs[i * N + e.need] as number) / NEED_SCALE);
        if (level < lowest) {
          lowest = level;
          need = e.need;
        }
      }
    }
    if (need < 0) return candidates;
    return candidates.filter((c) =>
      (this.actions[c.a] as CompiledAction).needs.some((e) => e.need === need && e.perHour > 0),
    );
  }

  /** What an action's direct effects are worth to person `i` now. */
  #directValue(i: number, a: CompiledAction): number {
    const N = this.needKeys.length;
    let gain = 0;
    for (const e of a.needs) {
      if (e.perHour <= 0) continue;
      const level = Math.floor((this.needs[i * N + e.need] as number) / NEED_SCALE);
      const urgency = Math.floor(((1000 - level) * (1000 - level)) / 1000);
      const delivered = Math.min(Math.floor((e.perHour * a.def.durationMin) / 60), 1000 - level);
      gain += Math.floor((urgency * delivered) / 1000);
    }
    // Pay is worth what it buys here: an hour's ordinary pay counts as HOUR_PAY_POINTS.
    if (a.def.income > 0) {
      gain += Math.floor((a.def.income * HOUR_PAY_POINTS) / this.spec.hourPay);
    }
    return gain;
  }

  /**
   * What an action is worth including what it unlocks: changing a thing's state can make other
   * actions possible, on the same thing (open the door, then drive) or elsewhere (start the
   * generator, then watch TV). Looks a few state changes ahead; each step is worth half.
   */
  #value(i: number, t: number, a: CompiledAction, depth: number): number {
    let best = this.#directValue(i, a);
    if (depth === 0 || a.sets.length === 0) return best;
    const thing = this.things[t] as SimThing;
    const vars = this.thingVars.slice(thing.base, thing.base + thing.kind.initial.length);
    for (const s of a.sets) vars[s.var] = s.value;
    for (const b of thing.kind.actions) {
      if (b === a || this.#holds(t, b.requires, null) || !this.#holds(t, b.requires, vars)) {
        continue;
      }
      best = Math.max(best, Math.floor(this.#valueAfter(i, t, b, vars, depth - 1) / 2));
    }
    for (const s of thing.kind.supplies) {
      if (this.resourceOn(s.resource) || !this.#holds(t, s.when, vars)) continue;
      for (let u = 0; u < this.things.length; u++) {
        if (u === t || !this.#canReach(i, u)) continue;
        for (const b of (this.things[u] as SimThing).kind.actions) {
          if (!b.requires.some((c) => c.var < 0 && c.resource === s.resource)) continue;
          best = Math.max(best, Math.floor(this.#directValue(i, b) / 2));
        }
      }
    }
    return best;
  }

  /** Value of `b` on thing `t` given hypothetical vars: one more planning step. */
  #valueAfter(i: number, t: number, b: CompiledAction, vars: Int32Array, depth: number): number {
    let best = this.#directValue(i, b);
    if (depth === 0 || b.sets.length === 0) return best;
    const thing = this.things[t] as SimThing;
    const next = vars.slice();
    for (const s of b.sets) next[s.var] = s.value;
    for (const c of thing.kind.actions) {
      if (c === b || this.#holds(t, c.requires, vars) || !this.#holds(t, c.requires, next)) {
        continue;
      }
      best = Math.max(best, Math.floor(this.#valueAfter(i, t, c, next, depth - 1) / 2));
    }
    return best;
  }

  #think(i: number): void {
    const found: { t: number; a: number; score: number }[] = [];
    const here = this.cell[i] as number;
    const w = this.grid.width;
    for (let t = 0; t < this.things.length; t++) {
      if (!this.#canReach(i, t)) continue;
      const thing = this.things[t] as SimThing;
      const dx = Math.abs((here % w) - (thing.aim % w));
      const dz = Math.abs(Math.floor(here / w) - Math.floor(thing.aim / w));
      const dist = (dx + dz) * this.grid.cellMm;
      for (const a of thing.kind.actions) {
        if (this.#cannotUse(i, t, a) || this.#wouldDrain(i, a) || this.#wouldWaste(i, a)) continue;
        const gain = this.#value(i, t, a, LOOKAHEAD);
        if (gain <= 0) continue;
        // Of two things that would do, the one that costs less, as anyone would.
        const near = Math.floor((gain * 10_000) / (10_000 + Math.floor(dist / 10)));
        const pay = this.spec.hourPay;
        found.push({
          t,
          a: a.index,
          score: a.def.cost > 0 ? Math.floor((near * pay) / (pay + a.def.cost)) : near,
        });
      }
    }
    const candidates = this.#firstThingsFirst(i, found);
    candidates.sort((p, q) => q.score - p.score || p.t - q.t || p.a - q.a);
    // Weighted pick among the top few keeps behaviour varied but reproducible.
    const top = candidates.slice(0, 3);
    const total = top.reduce((s, c) => s + c.score, 0);
    if (total > 0) {
      let roll = this.#rngThink.int(Math.min(total, 2 ** 21));
      let pick = 0;
      for (; pick < top.length - 1; pick++) {
        roll -= (top[pick] as (typeof top)[number]).score;
        if (roll < 0) break;
      }
      if (pick > 0) top.unshift(...top.splice(pick, 1));
    }
    for (const c of [...top, ...candidates.slice(3, 6)]) {
      const thing = this.things[c.t] as SimThing;
      const path = this.#finder.find(
        here,
        this.#freeUseCells(i, c.t),
        thing.aim,
        this.movers[i] as Mover,
        50_000,
      );
      if (path) {
        this.#beginWalk(i, c.t, c.a, path);
        return;
      }
    }
    this.nextThink[i] = this.tick + TICKS_PER_MINUTE;
  }

  // ── Doing it ──────────────────────────────────────────────────────────────────────

  /**
   * Where `i` may stand to use thing `t`: its use cells, less those within a body's width of
   * anyone else here, standing, busy or on their way somewhere (two people at one table sit
   * side by side, not in each other; nobody walks up to stand inside a player). If that leaves
   * nowhere, all of them: sharing beats not using it at all.
   */
  #freeUseCells(i: number, t: number): ReadonlySet<number> {
    const thing = this.things[t] as SimThing;
    const g = this.grid;
    const others: number[] = [];
    for (let j = 0; j < MAX_PEOPLE; j++) {
      if (j === i || !this.present[j]) continue;
      const m = this.mode[j];
      if (m === Mode.Acting || m === Mode.Idle) others.push(this.cell[j] as number);
      else if (m === Mode.Walking) {
        const path = this.paths[j] as number[];
        others.push(path.length > 0 ? (path[path.length - 1] as number) : (this.cell[j] as number));
      }
    }
    if (others.length === 0) return thing.useCells;
    const reach = Math.ceil(ARRIVAL_CLEAR_MM / g.cellMm);
    const free = new Set<number>();
    for (const c of thing.useCells) {
      const x = c % g.width;
      const z = Math.floor(c / g.width);
      let clear = true;
      for (const o of others) {
        const dx = (o % g.width) - x;
        const dz = Math.floor(o / g.width) - z;
        if (dx * dx + dz * dz < reach * reach) {
          clear = false;
          break;
        }
      }
      if (clear) free.add(c);
    }
    return free.size > 0 ? free : thing.useCells;
  }

  #beginWalk(i: number, t: number, a: number, path: number[]): void {
    this.targetThing[i] = t;
    this.targetAction[i] = a;
    this.paths[i] = path;
    this.pathPos[i] = 0;
    this.stepProgress[i] = 0;
    this.mode[i] = Mode.Walking;
  }

  /** One of someone's marks, by key; 0 if the place doesn't know it. */
  mark(agent: number, key: string): number {
    const j = this.markKeys.indexOf(key);
    return j < 0 || agent < 0 ? 0 : (this.marks[agent * this.markKeys.length + j] ?? 0);
  }

  #moveMark(i: number, key: string, by: number): void {
    const j = this.markKeys.indexOf(key);
    if (j < 0) return;
    const at = i * this.markKeys.length + j;
    this.marks[at] = Math.max(
      0,
      Math.min(this.#markMax[j] as number, (this.marks[at] as number) + by),
    );
  }

  /**
   * Whether this go at it moved the mark. What's paid for is yours; a skill you practise comes
   * slower the better you are: going from level n to n+1 takes about n+1 goes, so the first steps
   * come quickly and the top of a trade takes real time.
   */
  #practiceTakes(i: number, action: ActionDef, m: { mark: string; by: number }): boolean {
    if (m.by <= 0 || action.cost > 0) return true;
    const level = this.mark(i, m.mark);
    return level <= 0 || this.#rngOutcome.int(level + 1) === 0;
  }

  /** How an action turned out, by chance, with the odds shifted by what the person is good at. */
  #outcome(i: number, action: ActionDef): NonNullable<ActionDef["outcomes"]>[number] | null {
    const list = action.outcomes;
    if (!list || list.length === 0) return null;
    const weights = list.map(
      (o) => o.weight + (o.favours ? this.mark(i, o.favours.mark) * o.favours.perPoint : 0),
    );
    let roll = this.#rngOutcome.int(weights.reduce((sum, w) => sum + w, 0));
    for (const [n, w] of weights.entries()) {
      if (roll < w) return list[n] ?? null;
      roll -= w;
    }
    return null;
  }

  /** Whether someone has what an action asks of them. */
  #hasMarks(i: number, action: ActionDef): boolean {
    for (const ask of action.asks ?? []) {
      const v = this.mark(i, ask.mark);
      if (ask.op === "gte" ? v < ask.value : v > ask.value) return false;
    }
    return true;
  }

  /** What a person keeps of their pay or pace, permille: the harshest of their empty needs. */
  #emptyShare(i: number, what: "pay" | "walk"): number {
    const N = this.needKeys.length;
    let share = 1000;
    for (const cost of this.#emptyCosts) {
      if ((this.needs[i * N + cost.need] as number) <= 0) share = Math.min(share, cost[what]);
    }
    return share;
  }

  #walk(i: number, events: SimEvent[]): void {
    const path = this.paths[i] as number[];
    const pace = this.#emptyShare(i, "walk");
    let progress =
      (this.stepProgress[i] as number) + Math.floor(((this.speed[i] as number) * pace) / 1000);
    let pos = this.pathPos[i] as number;
    while (pos < path.length) {
      const next = path[pos] as number;
      const here = this.cell[i] as number;
      const diagonal =
        here % this.grid.width !== next % this.grid.width &&
        Math.floor(here / this.grid.width) !== Math.floor(next / this.grid.width);
      // Bodies walk at their speed in real time while the city's clock runs fast (like any
      // life-sim): a step costs as many ticks as there are ticks to a real second.
      const cost =
        (diagonal ? this.grid.diagMm : this.grid.cellMm) * this.settings.ticksPerRealSecond;
      if (progress < cost) break;
      progress -= cost;
      this.cell[i] = next;
      pos++;
    }
    this.pathPos[i] = pos;
    this.stepProgress[i] = progress;
    if (pos < path.length) return;

    this.paths[i] = null;
    const t = this.targetThing[i] as number;
    if (t < 0) {
      this.#idle(i);
      return;
    }
    const a = this.actions[this.targetAction[i] as number] as CompiledAction;
    const refused = this.#cannotUse(i, t, a);
    if (refused) {
      // Someone got there first, or it shut while they walked: tell them, don't just stop.
      events.push({
        type: "command_rejected",
        tick: this.tick,
        agent: this.agentIds[i] ?? null,
        reason: refused,
      });
      this.#idle(i);
      return;
    }
    const thing = this.things[t] as SimThing;
    this.wallet[i] = (this.wallet[i] as number) - a.def.cost;
    this.users[t] = (this.users[t] as number) + 1;
    const fullTicks = a.def.durationMin * TICKS_PER_MINUTE;
    const ticks = this.controlled[i] ? heldActionTicks(a.def, this.settings) : fullTicks;
    this.actionEnd[i] = this.tick + ticks;
    this.actionPace[i] = Math.floor((fullTicks * 1000) / Math.max(1, ticks));
    events.push({
      type: "action_started",
      tick: this.tick,
      agent: this.agentIds[i] as string,
      object: thing.id,
      action: a.def.key,
      paid: a.def.cost,
    });
    if (a.def.leaves) {
      this.mode[i] = Mode.Away;
      if (a.def.leaves.withThing) this.thingAway[t] = this.actionEnd[i] as number;
      events.push({
        type: "left",
        tick: this.tick,
        agent: this.agentIds[i] as string,
        object: a.def.leaves.withThing ? thing.id : null,
        minutes: a.def.durationMin,
      });
    } else {
      this.mode[i] = Mode.Acting;
    }
  }

  #act(i: number, events: SimEvent[]): void {
    const t = this.targetThing[i] as number;
    const a = this.actions[this.targetAction[i] as number] as CompiledAction;
    const away = this.mode[i] === Mode.Away;
    // Conditions must keep holding here (a power cut stops the TV); not while away.
    if (!away && !this.#holds(t, a.requires, null)) {
      this.#stop(i, events, "conditions");
      return;
    }
    const N = this.needKeys.length;
    const pace = this.actionPace[i] as number;
    // Only purely need-driven actions may end early once the needs are met (stop eating when
    // full). Anything that pays, changes state or goes away runs its whole duration, so ending
    // early can never be used to farm income or skip time.
    const endsWhenMet =
      a.def.income === 0 &&
      a.sets.length === 0 &&
      !a.def.leaves &&
      a.needs.some((e) => e.perHour > 0);
    let satisfied = endsWhenMet;
    for (const e of a.needs) {
      const at = i * N + e.need;
      const fill = e.perHour > 0 ? (this.settings.needFillPermille ?? 1000) : 1000;
      const change = Math.floor((Math.floor((e.perHour * pace) / 1000) * fill) / 1000);
      const v = Math.min(NEED_MAX, Math.max(0, (this.needs[at] as number) + change));
      this.needs[at] = v;
      if (e.perHour > 0 && v < NEED_MAX - 10 * NEED_SCALE) satisfied = false;
    }
    if (
      !away &&
      !this.controlled[i] &&
      a.def.income === 0 &&
      this.tick % WAKE_CHECK_TICKS === 0 &&
      this.#somethingMoreUrgent(i, a)
    ) {
      this.#stop(i, events, "conditions");
      this.nextThink[i] = this.tick + 1;
      return;
    }
    if (this.tick < (this.actionEnd[i] as number) && (away || !satisfied)) return;

    const thing = this.things[t] as SimThing;
    let practised = false;
    let gained = false;
    for (const m of a.def.marks ?? []) {
      if (m.by <= 0) {
        this.#moveMark(i, m.mark, m.by);
      } else {
        practised = true;
        if (this.#practiceTakes(i, a.def, m)) {
          this.#moveMark(i, m.mark, m.by);
          gained = true;
        }
      }
    }
    const practiceMissed = practised && !gained;
    const outcome = this.#outcome(i, a.def);
    for (const m of outcome?.marks ?? []) this.#moveMark(i, m.mark, m.by);
    const share = this.#emptyShare(i, "pay");
    const bonus = outcome?.money ?? 0;
    const earned =
      Math.floor((a.def.income * share) / 1000) +
      (bonus > 0 ? Math.floor((bonus * share) / 1000) : bonus);
    this.wallet[i] = Math.max(0, (this.wallet[i] as number) + earned);
    for (const s of a.sets) {
      this.thingVars[thing.base + s.var] = s.value;
      this.revertAt[thing.base + s.var] = s.forTicks > 0 ? this.tick + s.forTicks : 0;
    }
    if (away) {
      this.thingAway[t] = 0;
      events.push({
        type: "returned",
        tick: this.tick,
        agent: this.agentIds[i] as string,
        object: a.def.leaves?.withThing ? thing.id : null,
      });
    }
    events.push({
      type: "action_finished",
      tick: this.tick,
      agent: this.agentIds[i] as string,
      object: thing.id,
      action: a.def.key,
      earned,
      ...(share < 1000 && a.def.income > 0
        ? { docked: a.def.income - Math.floor((a.def.income * share) / 1000) }
        : {}),
      ...(outcome?.say ? { say: outcome.say } : {}),
      ...(practiceMissed ? { practiceMissed } : {}),
    });
    this.users[t] = (this.users[t] as number) - 1;
    this.#idle(i);
  }

  #stop(i: number, events: SimEvent[], reason: "cancelled" | "conditions"): void {
    const t = this.targetThing[i] as number;
    if (this.mode[i] === Mode.Idle) return;
    if (t < 0) {
      this.#idle(i);
      return;
    }
    if (this.mode[i] === Mode.Acting) this.users[t] = (this.users[t] as number) - 1;
    events.push({
      type: "action_interrupted",
      tick: this.tick,
      agent: this.agentIds[i] as string,
      object: (this.things[t] as SimThing).id,
      action: (this.actions[this.targetAction[i] as number] as CompiledAction).def.key,
      reason,
    });
    this.#idle(i);
  }

  #idle(i: number): void {
    this.mode[i] = Mode.Idle;
    this.targetThing[i] = -1;
    this.targetAction[i] = -1;
    this.paths[i] = null;
    this.nextThink[i] = this.tick + 1;
  }
}
