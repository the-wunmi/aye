/**
 * World specs: everything about a place that isn't geometry, written by a model.
 *
 * Nothing about what a world contains is fixed in code. A spec defines the needs people there
 * have, the resources that exist (grid power, fuel, water, whatever the place runs on), the
 * kinds of things in it, each with its own state (a car is `covered`, its `door_open`, it is
 * `away`), the actions that read and change that state (remove the cover, open the door,
 * drive off), how each kind looks in each state (a few simple coloured shapes), and the
 * people who live there or pass through.
 *
 * Code owns only what makes a world trustworthy: physics (space, bodies, collision), a generic
 * interpreter for the spec, ids, and the bounds below. A spec is data, never code: conditions
 * are comparisons, effects are assignments and rates, all integers. So any spec a model writes
 * runs deterministically, and none can break the game (no money printers, no endless needs).
 */
import { z } from "zod";
import { ArtifactHash, ModelRef } from "./artifact.ts";
import { ObjectId, SpaceId } from "./ids.ts";
import { AssetId } from "./library.ts";
import { CurrencyCode, Label, LIMITS } from "./primitives.ts";

/** Hard limits on generated worlds. Game balance and abuse resistance; change deliberately. */
export const WORLD_BOUNDS = {
  needs: 12,
  resources: 8,
  kinds: 48,
  varsPerKind: 6,
  actionsPerKind: 8,
  shapesPerKind: 20,
  conditions: 4,
  effects: 6,
  /** Marks a place knows about: the city's, and how close you are to each person here. */
  marks: 32,
  markMax: 1_000,
  /** The least a person keeps of their pay or pace when a need runs out, permille. */
  emptyLeastPermille: 250,
  people: 8,
  /** Need change per simulated hour of an action. */
  needPerHour: 6_000,
  needDecayPerHour: 300,
  durationMin: { min: 1, max: 720 },
  /** Minor units of the world currency. */
  cost: 10_000_000,
  incomePerHour: 1_000_000,
  capacity: 8,
  varMax: 1_000,
  timedMin: 1_440,
  meanOutageMin: 1_440,
  money: 1_000_000_000,
  /** How fast a thing can carry its owner between places (a bicycle to a car on a highway). */
  travelKmh: { min: 3, max: 120 },
  body: {
    widthMm: { min: 300, max: 1_200 },
    stepMm: { min: 0, max: 400 },
    slopePermille: { min: 20, max: 1_000 },
    speedMmPerS: { min: 200, max: 3_000 },
  },
} as const;

/** Identifiers inside a spec. Derived by code from the model's names. */
export const SpecKey = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, "spec key, e.g. door_open");
export type SpecKey = z.infer<typeof SpecKey>;
const Colour = z.string().regex(/^#[0-9a-f]{6}$/, "colour as #rrggbb");
const Text = (max: number) => z.string().max(max);

export const NeedDef = z.object({
  key: SpecKey,
  label: Label.min(1),
  /** Points lost per simulated hour, out of 1000. */
  decayPerHour: z.int().min(0).max(WORLD_BOUNDS.needDecayPerHour),
  /**
   * What running out costs a person until they top it up, if anything. Bounded so it can
   * slow someone down but never strand them: they can always walk and earn their way back.
   */
  whenEmpty: z
    .object({
      /** Share of what work pays that they still earn, permille. */
      payPermille: z.int().min(WORLD_BOUNDS.emptyLeastPermille).max(1000),
      /** Share of their usual walking speed, permille. */
      walkPermille: z.int().min(WORLD_BOUNDS.emptyLeastPermille).max(1000),
      /** How it feels, shown to them while it lasts. */
      feeling: Label.min(1),
    })
    .optional(),
});
export type NeedDef = z.infer<typeof NeedDef>;

/**
 * What a person's empty needs cost them right now: the harshest pay and pace (the sim plays
 * by the same rule), and how the worst of it feels. Permille; 1000 and null if nothing.
 */
export function emptyCost(
  needs: readonly NeedDef[],
  levelOf: (need: NeedDef, index: number) => number,
): { payPermille: number; walkPermille: number; feeling: string | null } {
  let payPermille = 1000;
  let walkPermille = 1000;
  let feeling: string | null = null;
  let worst = 2001;
  needs.forEach((need, index) => {
    if (!need.whenEmpty || levelOf(need, index) > 0) return;
    payPermille = Math.min(payPermille, need.whenEmpty.payPermille);
    walkPermille = Math.min(walkPermille, need.whenEmpty.walkPermille);
    const harm = need.whenEmpty.payPermille + need.whenEmpty.walkPermille;
    if (harm < worst) {
      worst = harm;
      feeling = need.whenEmpty.feeling;
    }
  });
  return { payPermille, walkPermille, feeling };
}

/**
 * Something that stays with a person wherever they go, as a whole number: a skill, what they're
 * carrying, what they own, how a neighbourhood sees them, how close they are to someone. Code
 * doesn't know which: a model says what each one is, and actions change and ask for them.
 */
export const MarkDef = z.object({
  key: SpecKey,
  label: Label.min(1),
  max: z.int().min(1).max(WORLD_BOUNDS.markMax),
  /** Worth showing the player all the time (a skill), or only when it comes up. */
  shown: z.boolean(),
});
export type MarkDef = z.infer<typeof MarkDef>;

/** The mark for how close someone is to a person of a place. */
/**
 * Only its owner can do it: taking out a thing that isn't for hire, when every one of them here
 * belongs to someone. A newcomer shouldn't be pointed at it.
 */
export function ownersOnly(spec: WorldSpec, kind: string, action: ActionDef): boolean {
  if (!action.leaves?.withThing || action.cost !== 0) return false;
  const things = spec.things.filter((t) => t.kind === kind);
  return things.length > 0 && things.every((t) => t.owner !== undefined);
}

/**
 * A copy of a place someone has made their own, brought up to date with what's been added to the
 * place since: a thing someone asked for more of is that much more here too. Kinds only the copy
 * has are left alone, and so is all of it if the two can't be put together.
 */
export function carryAsked(own: WorldSpec, from: WorldSpec): WorldSpec {
  const kinds = own.kinds.map((k) => {
    const newer = from.kinds.find((x) => x.key === k.key);
    const adds = newer?.actions.some((a) => !k.actions.some((b) => b.key === a.key));
    return newer && adds ? newer : k;
  });
  if (kinds.every((k, i) => k === own.kinds[i])) return own;
  const merged = {
    ...own,
    kinds,
    resources: [
      ...own.resources,
      ...from.resources.filter((r) => !own.resources.some((x) => x.key === r.key)),
    ],
  };
  return specIssues(merged).length === 0 ? merged : own;
}

export function closenessKey(personKey: string): string {
  return `close_${personKey}`.slice(0, 32).replace(/_+$/, "");
}

export const ResourceDef = z.object({
  key: SpecKey,
  label: Label.min(1),
  /** Public supply, if any, which comes and goes. Null: only things here can supply it. */
  supply: z
    .object({
      uptimePermille: z.int().min(0).max(1000),
      meanOutageMin: z.int().min(0).max(WORLD_BOUNDS.meanOutageMin),
    })
    .nullable(),
});
export type ResourceDef = z.infer<typeof ResourceDef>;

/** A state variable of a kind of thing: a flag (0/1) or a level (0..max). */
export const VarDef = z.object({
  key: SpecKey,
  label: Label.min(1),
  max: z.int().min(1).max(WORLD_BOUNDS.varMax),
  initial: z.int().min(0).max(WORLD_BOUNDS.varMax),
});
export type VarDef = z.infer<typeof VarDef>;

/** A test on the thing's own state, or on whether a resource is available here now. */
export const Condition = z.union([
  z.object({
    var: SpecKey,
    op: z.enum(["eq", "ne", "gte", "lte"]),
    value: z.int().min(0).max(WORLD_BOUNDS.varMax),
  }),
  z.object({ resource: SpecKey }),
]);
export type Condition = z.infer<typeof Condition>;

/**
 * One primitive of a kind's look, in the thing's own frame and relative to its size, so one
 * kind fits every instance: x and z in permille of width and depth around the centre, y in
 * permille of height up from the floor; sizes in permille of the thing's size. Drawn only
 * while every `when` condition holds (a cover only while `covered`).
 */
/**
 * The primitives every look is built from: geometry only, never what anything is. A model
 * composes them into a danfo, a church, a person; code just draws them.
 */
export const Primitive = z.enum([
  "box",
  "rounded_box",
  "cylinder",
  "sphere",
  "hemisphere",
  "cone",
  "capsule",
  "torus",
  "wedge",
]);
export type Primitive = z.infer<typeof Primitive>;

const Rotation = z.tuple([
  z.int().min(-180).max(180),
  z.int().min(-180).max(180),
  z.int().min(-180).max(180),
]);

/**
 * One primitive placed relative to whatever it belongs to: x and z in permille of its width
 * and depth around the centre, y in permille of its height up from the ground; sizes in
 * permille of its size. So one look fits every instance, whatever its measured size.
 */
export const Solid = z.object({
  shape: Primitive,
  centre: z.tuple([
    z.int().min(-1000).max(1000),
    z.int().min(0).max(2000),
    z.int().min(-1000).max(1000),
  ]),
  size: z.tuple([z.int().min(1).max(2000), z.int().min(1).max(2000), z.int().min(1).max(2000)]),
  rotateDeg: Rotation,
  colour: Colour,
  /** Gives off light (a lamp, a screen, a neon sign, a flame): drawn unlit, bright at night. */
  glow: z.boolean().default(false),
});
export type Solid = z.infer<typeof Solid>;

/** A thing's primitive, drawn only while every `when` condition holds (a cover while covered). */
export const Shape = Solid.extend({
  when: z.array(Condition).max(WORLD_BOUNDS.conditions),
});
export type Shape = z.infer<typeof Shape>;

/** How a person is shown while doing something: a rendering hint, not a rule. */
export const Pose = z.enum(["stand", "sit", "lie", "inside"]);
export type Pose = z.infer<typeof Pose>;

export const ActionDef = z.object({
  key: SpecKey,
  label: Label.min(1),
  durationMin: z.int().min(WORLD_BOUNDS.durationMin.min).max(WORLD_BOUNDS.durationMin.max),
  capacity: z.int().min(1).max(WORLD_BOUNDS.capacity),
  /** Paid at the start, earned at the end; minor units. */
  cost: z.int().min(0).max(WORLD_BOUNDS.cost),
  income: z.int().min(0).max(WORLD_BOUNDS.cost),
  /** All must hold to start, and to keep going. */
  requires: z.array(Condition).max(WORLD_BOUNDS.conditions),
  /** Need changes per simulated hour while the action runs. */
  needs: z
    .array(
      z.object({
        need: SpecKey,
        perHour: z.int().min(-WORLD_BOUNDS.needPerHour).max(WORLD_BOUNDS.needPerHour),
      }),
    )
    .max(WORLD_BOUNDS.effects),
  /** What finishing it does to the marks of whoever did it: +1 Cooking, -1 Groceries. */
  marks: z
    .array(
      z.object({ mark: SpecKey, by: z.int().min(-WORLD_BOUNDS.markMax).max(WORLD_BOUNDS.markMax) }),
    )
    .max(WORLD_BOUNDS.effects)
    .optional(),
  /**
   * How it can turn out, one chosen by chance when it finishes: a great day, or the stock seized.
   * Weights are relative; a mark can shift the odds, so being good at something helps.
   */
  outcomes: z
    .array(
      z.object({
        weight: z.int().min(1).max(100),
        /** Each point of this mark adds this much weight. */
        favours: z.object({ mark: SpecKey, perPoint: z.int().min(0).max(20) }).optional(),
        /** What the person is told. */
        say: Text(160),
        /** On top of the action's income, or taken away, minor units. */
        money: z.int().min(-1_000_000_000).max(1_000_000_000),
        marks: z
          .array(
            z.object({
              mark: SpecKey,
              by: z.int().min(-WORLD_BOUNDS.markMax).max(WORLD_BOUNDS.markMax),
            }),
          )
          .max(WORLD_BOUNDS.effects),
      }),
    )
    .max(4)
    .optional(),
  /** The marks someone being played has to have to start it: Cooking at least 3. */
  asks: z
    .array(
      z.object({
        mark: SpecKey,
        op: z.enum(["gte", "lte"]),
        value: z.int().min(0).max(WORLD_BOUNDS.markMax),
      }),
    )
    .max(WORLD_BOUNDS.conditions)
    .optional(),
  /** State changes when the action completes; `forMin` > 0 reverts to the initial value after. */
  sets: z
    .array(
      z.object({
        var: SpecKey,
        value: z.int().min(0).max(WORLD_BOUNDS.varMax),
        forMin: z.int().min(0).max(WORLD_BOUNDS.timedMin),
      }),
    )
    .max(WORLD_BOUNDS.effects),
  /** The person (with the thing, if `withThing`) leaves by the nearest exit for the duration. */
  leaves: z.object({ withThing: z.boolean() }).nullable(),
  pose: Pose,
  /**
   * Sitting or lying ON the thing itself (a bench, a bed, a mat), rather than at or beside it
   * (a desk, a table, under a tree). Where the person is drawn, never what they may do.
   * Absent in worlds written before it existed.
   */
  on: z.boolean().optional(),
});
export type ActionDef = z.infer<typeof ActionDef>;

export const KindDef = z.object({
  key: SpecKey,
  label: Label.min(1),
  /** People must walk around it. */
  solid: z.boolean(),
  vars: z.array(VarDef).max(WORLD_BOUNDS.varsPerKind),
  actions: z.array(ActionDef).max(WORLD_BOUNDS.actionsPerKind),
  /** Resources it supplies to the place while the conditions hold (a running generator). */
  supplies: z
    .array(z.object({ resource: SpecKey, when: z.array(Condition).max(WORLD_BOUNDS.conditions) }))
    .max(4),
  look: z.array(Shape).min(1).max(WORLD_BOUNDS.shapesPerKind),
  /**
   * A library model chosen to draw it, fitted to each thing's measured size. It
   * shows the thing as it starts; shapes that only appear in other states still draw over it.
   * Absent: drawn from the look's primitives.
   */
  asset: AssetId.optional(),
  /** A city panel this thing opens when tapped (a TV, a shop's laptop, a notice board). */
  panel: SpecKey.optional(),
  /**
   * It carries its owner between the city's places (a car, a motorbike, a bicycle), at this
   * average speed. Only things people go out with (an action that leaves with the thing).
   */
  travel: z
    .object({
      speedKmh: z.int().min(WORLD_BOUNDS.travelKmh.min).max(WORLD_BOUNDS.travelKmh.max),
    })
    .optional(),
  /** One line on why, shown when reviewing. Display only. */
  note: Text(300),
});
export type KindDef = z.infer<typeof KindDef>;

export const ThingDef = z.object({
  /** The scene object this is (position, size and identity come from the scene). */
  object: ObjectId,
  kind: SpecKey,
  /** Initial state that differs from the kind's (this car starts uncovered). */
  state: z.array(z.object({ var: SpecKey, value: z.int().min(0).max(WORLD_BOUNDS.varMax) })).max(6),
  /**
   * Whose it is (a person of this place, by key): only they may take it away. Absent:
   * nobody's in particular (in someone's own home, theirs).
   */
  owner: SpecKey.optional(),
  /**
   * A picture of the real thing's front (for a filmed place): drawn as a box wearing it. An
   * artifact, readable by whoever can read the place. Never a URL a model wrote.
   */
  front: ArtifactHash.optional(),
  /** A picture of its top, where that's what you see of it (a worktop). */
  top: ArtifactHash.optional(),
});
export type ThingDef = z.infer<typeof ThingDef>;

/** The parts of a person the engine animates: limbs swing from shoulders and hips. */
export const BodyPart = z.enum(["body", "head", "arm_left", "arm_right", "leg_left", "leg_right"]);
export type BodyPart = z.infer<typeof BodyPart>;

/** A colour, or a slot filled from the person's own colours (so one look suits anyone). */
export const LookColour = z.union([Colour, z.enum(["skin", "top", "bottom", "hair", "accent"])]);
export type LookColour = z.infer<typeof LookColour>;

/**
 * How a person looks, designed by a model from primitives: millimetres from their feet (x to
 * their right, y up, z forward), grouped by the part of the body each moves with.
 */
export const PersonLook = z.object({
  heightMm: z.int().min(900).max(2100),
  parts: z
    .array(
      z.object({
        part: BodyPart,
        shapes: z
          .array(
            z.object({
              shape: Primitive,
              centre: z.tuple([
                z.int().min(-800).max(800),
                z.int().min(0).max(2400),
                z.int().min(-800).max(800),
              ]),
              size: z.tuple([
                z.int().min(1).max(1200),
                z.int().min(1).max(1200),
                z.int().min(1).max(1200),
              ]),
              rotateDeg: Rotation,
              colour: LookColour,
            }),
          )
          .max(14),
      }),
    )
    .max(6),
});
export type PersonLook = z.infer<typeof PersonLook>;

export const PersonDef = z.object({
  key: SpecKey,
  name: Label.min(1),
  /** Who they are, one line. Display only. */
  about: Text(200),
  colours: z.object({
    skin: Colour,
    top: Colour,
    bottom: Colour,
    hair: Colour.optional(),
    accent: Colour.optional(),
  }),
  /** Designed by a model; absent only in older worlds, which renderers draw plainly. */
  look: PersonLook.optional(),
  /** A rigged library outfit chosen for them, in their colours; else `look`. */
  outfit: AssetId.optional(),
  body: z.object({
    widthMm: z.int().min(WORLD_BOUNDS.body.widthMm.min).max(WORLD_BOUNDS.body.widthMm.max),
    stepMm: z.int().min(WORLD_BOUNDS.body.stepMm.min).max(WORLD_BOUNDS.body.stepMm.max),
    stairs: z.boolean(),
    /** Steepest slope they can climb, rise per 1000 run (a 1:12 ramp is 83). */
    slopePermille: z
      .int()
      .min(WORLD_BOUNDS.body.slopePermille.min)
      .max(WORLD_BOUNDS.body.slopePermille.max),
    speedMmPerS: z
      .int()
      .min(WORLD_BOUNDS.body.speedMmPerS.min)
      .max(WORLD_BOUNDS.body.speedMmPerS.max),
    /** Drawn seated on wheels (a wheelchair user). Rendering only; the body numbers rule. */
    seated: z.boolean(),
  }),
  money: z.int().min(0).max(WORLD_BOUNDS.money),
  needs: z.array(z.object({ need: SpecKey, start: z.int().min(0).max(1000) })).max(12),
  /** What stays with them from place to place. */
  marks: z
    .array(z.object({ mark: SpecKey, value: z.int().min(0).max(WORLD_BOUNDS.markMax) }))
    .max(64)
    .optional(),
});
export type PersonDef = z.infer<typeof PersonDef>;

export const WORLD_SPEC_FORMAT = "aye.world" as const;

export const WorldSpec = z
  .object({
    format: z.literal(WORLD_SPEC_FORMAT),
    version: z.literal(1),
    /** Hash of the scene (geometry) this world was written for. */
    scene: ArtifactHash,
    author: ModelRef,
    name: Label.min(1),
    summary: Text(500),
    currency: CurrencyCode,
    /**
     * What an hour of ordinary work pays here, minor units: what money is worth to people
     * (how much they want it), whatever the currency.
     */
    hourPay: z.int().min(1).max(1_000_000_000),
    /** Somewhere people live (every need met, for days) rather than visit. */
    livedIn: z.boolean(),
    needs: z.array(NeedDef).min(1).max(WORLD_BOUNDS.needs),
    marks: z.array(MarkDef).max(WORLD_BOUNDS.marks).optional(),
    resources: z.array(ResourceDef).max(WORLD_BOUNDS.resources),
    kinds: z.array(KindDef).min(1).max(WORLD_BOUNDS.kinds),
    things: z.array(ThingDef).max(LIMITS.objects),
    /** Who lives here or passes through. Nobody, in a real place filmed with nobody named. */
    people: z.array(PersonDef).max(WORLD_BOUNDS.people),
    /**
     * Ground colour per space, a library surface if one was chosen, and (for a filmed place) a
     * tiling picture of the real floor, which wins over both.
     */
    ground: z
      .array(
        z.object({
          space: SpaceId,
          colour: Colour,
          surface: AssetId.optional(),
          photo: ArtifactHash.optional(),
        }),
      )
      .max(LIMITS.spaces),
    walls: z.object({
      colour: Colour,
      surface: AssetId.optional(),
      photo: ArtifactHash.optional(),
    }),
  })
  .superRefine((spec, ctx) => {
    for (const issue of specIssues(spec)) ctx.addIssue({ code: "custom", message: issue });
  });
export type WorldSpec = z.infer<typeof WorldSpec>;

/**
 * Every broken reference or duplicate in a spec, in words a model can act on. Empty means the
 * spec is consistent; whether it makes a good world is for play-testing to say.
 */
export function specIssues(spec: {
  needs: NeedDef[];
  resources: ResourceDef[];
  kinds: KindDef[];
  things: ThingDef[];
  people: PersonDef[];
}): string[] {
  const issues: string[] = [];
  const dupes = (what: string, keys: string[]) => {
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k)) issues.push(`${what} "${k}" is defined twice`);
      seen.add(k);
    }
  };
  const needs = new Set(spec.needs.map((n) => n.key));
  const resources = new Set(spec.resources.map((r) => r.key));
  dupes(
    "need",
    spec.needs.map((n) => n.key),
  );
  dupes(
    "resource",
    spec.resources.map((r) => r.key),
  );
  dupes(
    "kind",
    spec.kinds.map((k) => k.key),
  );
  dupes(
    "person",
    spec.people.map((p) => p.key),
  );
  const kinds = new Map(spec.kinds.map((k) => [k.key, k]));
  for (const kind of spec.kinds) {
    const where = `kind "${kind.key}"`;
    dupes(
      `${where} var`,
      kind.vars.map((v) => v.key),
    );
    dupes(
      `${where} action`,
      kind.actions.map((a) => a.key),
    );
    const vars = new Map(kind.vars.map((v) => [v.key, v]));
    for (const v of kind.vars) {
      if (v.initial > v.max) issues.push(`${where} var "${v.key}" starts above its max`);
    }
    const checkConditions = (conditions: Condition[], at: string) => {
      for (const c of conditions) {
        if ("resource" in c) {
          if (!resources.has(c.resource))
            issues.push(`${at} needs unknown resource "${c.resource}"`);
        } else if (!vars.has(c.var)) {
          issues.push(`${at} tests unknown var "${c.var}"`);
        }
      }
    };
    for (const a of kind.actions) {
      const at = `${where} action "${a.key}"`;
      checkConditions(a.requires, at);
      for (const n of a.needs) {
        if (!needs.has(n.need)) issues.push(`${at} changes unknown need "${n.need}"`);
      }
      for (const s of a.sets) {
        const v = vars.get(s.var);
        if (!v) issues.push(`${at} sets unknown var "${s.var}"`);
        else if (s.value > v.max) issues.push(`${at} sets "${s.var}" above its max`);
      }
      if (a.income * 60 > WORLD_BOUNDS.incomePerHour * a.durationMin) {
        issues.push(`${at} earns more than ${WORLD_BOUNDS.incomePerHour} per hour`);
      }
    }
    for (const s of kind.supplies) {
      if (!resources.has(s.resource))
        issues.push(`${where} supplies unknown resource "${s.resource}"`);
      checkConditions(s.when, `${where} supply`);
    }
    for (const [i, shape] of kind.look.entries())
      checkConditions(shape.when, `${where} shape ${i}`);
    if (kind.travel && !kind.actions.some((a) => a.leaves?.withThing)) {
      issues.push(`${where} travels between places but no action goes out with it`);
    }
  }
  const people = new Set(spec.people.map((p) => p.key));
  const objects = new Set<string>();
  for (const t of spec.things) {
    const kind = kinds.get(t.kind);
    if (objects.has(t.object)) issues.push(`thing ${t.object} is listed twice`);
    objects.add(t.object);
    if (!kind) {
      issues.push(`thing ${t.object} has unknown kind "${t.kind}"`);
      continue;
    }
    if (t.owner !== undefined && !people.has(t.owner)) {
      issues.push(`thing ${t.object} belongs to unknown person "${t.owner}"`);
    }
    for (const s of t.state) {
      const v = kind.vars.find((x) => x.key === s.var);
      if (!v) issues.push(`thing ${t.object} sets unknown var "${s.var}"`);
      else if (s.value > v.max) issues.push(`thing ${t.object} starts "${s.var}" above its max`);
    }
  }
  for (const p of spec.people) {
    for (const n of p.needs) {
      if (!needs.has(n.need)) issues.push(`person "${p.key}" has unknown need "${n.need}"`);
    }
  }
  return issues;
}
