/**
 * The world harness: a model writes a place's world, code checks it, the simulation plays it,
 * and the model fixes what went wrong, until it works.
 *
 *   brief ─ author-world (model) ─ draft ─ compile-world (code) ─ spec ─ critique (play-test)
 *              ▲                                                              │
 *              └──────── revise-world (model), given every finding ◄──────────┘
 *
 * and, later, on demand:
 *
 *   spec + thing + "can I drive this?" ─ improvise (model) ─ kind ─ compile ─ critique ─ spec'
 *
 * The model chooses names and numbers. Code chooses everything the simulation keys on: keys
 * are derived from the model's names, objects and spaces are referenced by index and mapped
 * back to ids here, and every number is clamped to `WORLD_BOUNDS`. Anything that doesn't add
 * up comes back as a finding in plain words, which is what the next round answers.
 *
 * Every model call is a memoised stage keyed by everything it saw (brief, previous draft,
 * findings), so a finished world replays byte for byte with no calls.
 */
import type { ArtifactStore, RecipeIndex } from "@aye/artifacts";
import {
  type ArtifactHash,
  type ArtifactRef,
  type Condition,
  closenessKey,
  type KindDef,
  type MarkDef,
  type ModelRef,
  type NeedDef,
  type PersonLook,
  type Scene,
  type StageRecord,
  WORLD_BOUNDS,
  WORLD_SPEC_FORMAT,
  WorldSpec,
} from "@aye/schema";
import { cleanText } from "./assemble.ts";
import {
  type DraftCondition,
  DraftKind,
  type DraftPersonShape,
  WorldBrief,
  WorldDraft,
} from "./contracts.ts";
import { type LookToJudge, personTile, thingTile } from "./looks.ts";
import type { WorldAuthor } from "./providers.ts";
import { json, readJson, runStage, type StageDeps, type StageResult } from "./stage.ts";

/** The most one action moves a mark: a skill comes from doing it a few times, not once. */
const MOST_MARK_STEP = 3;

/** Bump when the authoring loop's wiring or the brief's shape changes. */
export const WORLD_HARNESS_VERSION = 9;
/** Bump when draft → spec compilation changes. */
export const WORLD_COMPILER_VERSION = 11;
/** How close anyone can get to someone. */
const CLOSENESS_MAX = 10;

/** A problem with a world, from compilation or play-testing (see `evaluateWorld` in @aye/sim). */
export interface WorldCritique {
  severity: "error" | "fix" | "warning";
  message: string;
}

export interface WorldDeps {
  author: WorldAuthor;
  store: ArtifactStore;
  index: RecipeIndex;
  /** Plays a spec and reports problems; findings drive the next round. */
  critique: (spec: WorldSpec) => WorldCritique[];
  /** Model rounds allowed in total, including the first (default 3). */
  maxRounds?: number;
  /** Stop as soon as nothing is broken (warnings allowed): a quick first pass. */
  untilNoErrors?: boolean;
  signal?: AbortSignal;
  onStage?: StageDeps["onStage"];
}

export interface WorldResult {
  /** The best spec found; null only if no round produced a valid one. */
  spec: WorldSpec | null;
  specRef: ArtifactRef | null;
  findings: WorldCritique[];
  rounds: number;
  stages: StageRecord[];
  cached: number;
}

// ── Brief ─────────────────────────────────────────────────────────────────────────────

/** What the author sees: the layout by index, the place's description, the local money. */
export function briefFor(args: {
  scene: Scene;
  name: string;
  summary: string;
  description: string;
  currency: string;
  /** The city this place is part of, if any: a line about it, its needs and pay. */
  city?: { line: string; needs: readonly NeedDef[]; marks?: readonly MarkDef[]; hourPay: number };
  /** A real place someone filmed (`description` is whatever they said about it). */
  filmed?: boolean;
}): WorldBrief {
  const rooms = new Map(args.scene.spaces.map((s) => [s.id as string, s.name]));
  return WorldBrief.parse({
    name: cleanText(args.name, 120),
    summary: cleanText(args.summary, 500),
    description: cleanText(args.description, 4_000),
    currency: args.currency,
    hourPay: args.city?.hourPay ?? 0,
    city: cleanText(args.city?.line ?? "", 300),
    filmed: args.filmed ?? false,
    needs: (args.city?.needs ?? []).map((n) => ({
      key: n.key,
      label: n.label,
      decayPerHour: n.decayPerHour,
      ...(n.whenEmpty ? { whenEmpty: n.whenEmpty } : {}),
    })),
    marks: args.city?.marks ?? [],
    spaces: args.scene.spaces.map((s, index) => ({
      index,
      name: cleanText(s.name),
      outdoor: s.ceilingMm === null,
    })),
    objects: args.scene.objects.map((o, index) => ({
      index,
      label: cleanText(o.label),
      space: o.spaceId === null ? null : (rooms.get(o.spaceId) ?? null),
      sizeM: [o.size.w / 1000, o.size.d / 1000, o.size.h / 1000],
    })),
  });
}

// ── Compile: draft → bounded spec ─────────────────────────────────────────────────────

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v)));

/** "Door open!" → "door_open". Deterministic, ASCII, starts with a letter, never empty. */
export function keyOf(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30)
    .replace(/_+$/, "");
  if (!s) return "x";
  return /^[a-z]/.test(s) ? s : `k_${s}`.slice(0, 32);
}

const COLOUR_SLOTS = new Set(["skin", "top", "bottom", "hair", "accent"]);

/** A person's draft look → a bounded `PersonLook`, grouped by the part each shape moves with. */
export function compilePersonLook(
  shapes: readonly DraftPersonShape[],
  heightMm: number,
  issues: string[],
  where: string,
): PersonLook | undefined {
  if (shapes.length === 0) {
    issues.push(`${where} has no look; people need a body made of shapes.`);
    return undefined;
  }
  const parts = new Map<
    PersonLook["parts"][number]["part"],
    PersonLook["parts"][number]["shapes"]
  >();
  for (const [i, d] of shapes.entries()) {
    const list = parts.get(d.part) ?? [];
    if (list.length >= 14) {
      issues.push(`${where} ${d.part} has more than 14 shapes; kept the first 14.`);
      continue;
    }
    const raw = d.colour.trim().toLowerCase();
    list.push({
      shape: d.shape,
      centre: [clamp(d.x, -800, 800), clamp(d.y, 0, 2400), clamp(d.z, -800, 800)],
      size: [clamp(d.w, 1, 1200), clamp(d.h, 1, 1200), clamp(d.d, 1, 1200)],
      rotateDeg: [clamp(d.rx, -180, 180), clamp(d.ry, -180, 180), clamp(d.rz, -180, 180)],
      colour: COLOUR_SLOTS.has(raw)
        ? (raw as "skin")
        : colourOf(d.colour, issues, `${where} shape ${i}`),
    });
    parts.set(d.part, list);
  }
  return {
    heightMm: clamp(heightMm, 900, 2100),
    parts: [...parts.entries()].map(([part, list]) => ({ part, shapes: list })),
  };
}

/** The inverse, for revisions: a look as the model wrote it. */
export function draftOfPersonLook(look: PersonLook): DraftPersonShape[] {
  return look.parts.flatMap((p) =>
    p.shapes.map((s) => ({
      part: p.part,
      shape: s.shape,
      x: s.centre[0],
      y: s.centre[1],
      z: s.centre[2],
      w: s.size[0],
      h: s.size[1],
      d: s.size[2],
      rx: s.rotateDeg[0],
      ry: s.rotateDeg[1],
      rz: s.rotateDeg[2],
      colour: s.colour,
      glow: false,
    })),
  );
}

function colourOf(c: string, issues: string[], where: string): string {
  const t = c.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(t)) return t;
  if (/^#[0-9a-f]{3}$/.test(t)) return `#${[...t.slice(1)].map((x) => x + x).join("")}`;
  issues.push(`${where}: colour "${c.slice(0, 16)}" isn't #rrggbb; used grey.`);
  return "#888888";
}

/** Keeps the first of each key, noting duplicates. */
function unique<T extends { key: string }>(items: T[], what: string, issues: string[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    if (seen.has(i.key)) {
      issues.push(`${what} "${i.key}" is defined twice; kept the first.`);
      return false;
    }
    seen.add(i.key);
    return true;
  });
}

/** One kind from a draft, keys derived and numbers bounded. */
export function compileKind(
  d: DraftKind,
  issues: string[],
  key: string = keyOf(d.key || d.label),
): KindDef {
  const b = WORLD_BOUNDS;
  const where = `kind "${key}"`;
  const vars = unique(
    d.vars.slice(0, b.varsPerKind).map((v) => {
      const max = clamp(v.max, 1, b.varMax);
      return {
        key: keyOf(v.key || v.label),
        label: cleanText(v.label, 80) || v.key,
        max,
        initial: clamp(v.initial, 0, max),
      };
    }),
    `${where} var`,
    issues,
  );
  const cond = (c: DraftCondition): Condition =>
    c.op === "available"
      ? { resource: keyOf(c.var) }
      : { var: keyOf(c.var), op: c.op, value: clamp(c.value, 0, b.varMax) };
  const conds = (list: DraftCondition[]) => list.slice(0, b.conditions).map(cond);
  const actions = unique(
    d.actions.slice(0, b.actionsPerKind).map((a) => {
      const durationMin = clamp(a.durationMin, b.durationMin.min, b.durationMin.max);
      return {
        key: keyOf(a.key || a.label),
        label: cleanText(a.label, 80) || a.key,
        durationMin,
        capacity: clamp(a.capacity, 1, b.capacity),
        cost: clamp(a.cost, 0, b.cost),
        income: clamp(a.income, 0, Math.floor((b.incomePerHour * durationMin) / 60)),
        requires: conds(a.requires),
        ...(a.marks.length > 0
          ? {
              marks: a.marks.slice(0, b.effects).flatMap((m) => {
                const by = clamp(m.by, -MOST_MARK_STEP, MOST_MARK_STEP);
                return by === 0 ? [] : [{ mark: keyOf(m.mark), by }];
              }),
            }
          : {}),
        ...(a.outcomes.length > 1
          ? {
              outcomes: a.outcomes.slice(0, 4).map((o) => ({
                weight: clamp(o.weight, 1, 100),
                ...(o.favours.trim()
                  ? { favours: { mark: keyOf(o.favours), perPoint: clamp(o.perPoint, 0, 20) } }
                  : {}),
                say: cleanText(o.say, 160),
                money: clamp(o.money, -1_000_000_000, 1_000_000_000),
                marks: o.marks.slice(0, b.effects).flatMap((m) => {
                  const by = clamp(m.by, -MOST_MARK_STEP, MOST_MARK_STEP);
                  return by === 0 ? [] : [{ mark: keyOf(m.mark), by }];
                }),
              })),
            }
          : {}),
        ...(a.asks.length > 0
          ? {
              asks: a.asks.slice(0, b.conditions).map((x) => ({
                mark: keyOf(x.mark),
                op: x.op,
                value: clamp(x.value, 0, b.markMax),
              })),
            }
          : {}),
        needs: a.needs.slice(0, b.effects).flatMap((n) => {
          const perHour = clamp(n.perHour, -b.needPerHour, b.needPerHour);
          return perHour === 0 ? [] : [{ need: keyOf(n.need), perHour }];
        }),
        sets: a.sets.slice(0, b.effects).map((s) => ({
          var: keyOf(s.var),
          value: clamp(s.value, 0, b.varMax),
          forMin: clamp(s.forMin, 0, b.timedMin),
        })),
        leaves: a.leaves === "no" ? null : { withThing: a.leaves === "with_thing" },
        // Off somewhere else on their own, how they'd sit here means nothing: not worth losing a
        // whole place over. Leaving with the thing keeps its pose: that's how they ride in it.
        pose: a.leaves === "alone" ? ("stand" as const) : a.pose,
        // Only a body at rest can be on something.
        ...(a.leaves !== "alone" && (a.pose === "sit" || a.pose === "lie") ? { on: a.on } : {}),
      };
    }),
    `${where} action`,
    issues,
  );
  const look = d.look.slice(0, b.shapesPerKind).map((s, i) => ({
    shape: s.shape,
    centre: [clamp(s.x, -1000, 1000), clamp(s.y, 0, 2000), clamp(s.z, -1000, 1000)] as [
      number,
      number,
      number,
    ],
    size: [clamp(s.w, 1, 2000), clamp(s.h, 1, 2000), clamp(s.d, 1, 2000)] as [
      number,
      number,
      number,
    ],
    rotateDeg: [clamp(s.rx, -180, 180), clamp(s.ry, -180, 180), clamp(s.rz, -180, 180)] as [
      number,
      number,
      number,
    ],
    colour: colourOf(s.colour, issues, `${where} shape ${i}`),
    glow: s.glow,
    when: conds(s.when),
  }));
  if (look.length === 0) {
    issues.push(`${where} has no look; drew a plain box.`);
    look.push({
      shape: "box",
      centre: [0, 500, 0],
      size: [1000, 1000, 1000],
      rotateDeg: [0, 0, 0],
      colour: "#888888",
      glow: false,
      when: [],
    });
  }
  return {
    key,
    label: cleanText(d.label, 80) || key,
    solid: d.solid,
    ...(d.travelKmh > 0
      ? {
          travel: {
            speedKmh: clamp(d.travelKmh, WORLD_BOUNDS.travelKmh.min, WORLD_BOUNDS.travelKmh.max),
          },
        }
      : {}),
    vars,
    actions,
    supplies: d.supplies.slice(0, 4).map((s) => ({
      resource: keyOf(s.resource),
      when: conds(s.when),
    })),
    look,
    note: cleanText(d.note, 300),
  };
}

/** The city's hour of pay if it has one, else what the world judged (it must judge one). */
function hourPayOf(city: number, drafted: number, issues: string[]): number {
  if (city > 0) return city;
  if (drafted < 1) {
    issues.push("hourPay must be what an hour of ordinary work pays here (minor units).");
    return 1;
  }
  return Math.min(1_000_000_000, Math.round(drafted));
}

/** Pure: draft + scene → a bounded spec, or null, and every issue found on the way. */
export function compileWorld(args: {
  draft: WorldDraft;
  scene: Scene;
  sceneHash: ArtifactHash;
  currency: string;
  /** The city's hour of pay (minor units); 0: the world's own judgement (its draft). */
  hourPay?: number;
  author: ModelRef;
  /** The city's needs: the world always has exactly these, plus any of its own that fit. */
  cityNeeds?: readonly NeedDef[];
  /** What stays with people here: actions change and ask for these. */
  cityMarks?: readonly MarkDef[];
  /**
   * A real place someone filmed. Its people can only be who they said (`namedNobody`: they
   * said nothing of anyone, so anyone written is made up).
   */
  filmed?: { namedNobody: boolean };
}): { spec: WorldSpec | null; issues: string[] } {
  const { draft, scene } = args;
  const b = WORLD_BOUNDS;
  const issues: string[] = [];
  const drafted = unique(
    draft.needs.slice(0, b.needs).map((n) => ({
      key: keyOf(n.key || n.label),
      label: cleanText(n.label, 80) || n.key,
      decayPerHour: clamp(n.decayPerHour, 0, b.needDecayPerHour),
    })),
    "need",
    issues,
  );
  // People carry the city's needs between places, so every place has them, as the city says.
  const city = args.cityNeeds ?? [];
  const needs = [...city, ...drafted.filter((n) => !city.some((c) => c.key === n.key))].slice(
    0,
    b.needs,
  );
  const resources = unique(
    draft.resources.slice(0, b.resources).map((r) => ({
      key: keyOf(r.key || r.label),
      label: cleanText(r.label, 80) || r.key,
      supply: r.publicSupply
        ? {
            uptimePermille: clamp(r.uptimePermille, 0, 1000),
            meanOutageMin: clamp(r.meanOutageMin, 0, b.meanOutageMin),
          }
        : null,
    })),
    "resource",
    issues,
  );
  const kinds = unique(
    draft.kinds.slice(0, b.kinds).map((k) => compileKind(k, issues)),
    "kind",
    issues,
  );
  const kindKeys = new Set(kinds.map((k) => k.key));
  const claimed = new Set<number>();
  const things = draft.things.flatMap((t) => {
    const obj = scene.objects[t.object];
    if (!obj) {
      issues.push(
        `thing for object ${t.object} doesn't exist; objects are 0..${scene.objects.length - 1}.`,
      );
      return [];
    }
    if (claimed.has(t.object)) {
      issues.push(`object ${t.object} (${obj.label}) is given a kind twice; kept the first.`);
      return [];
    }
    claimed.add(t.object);
    return [
      {
        object: obj.id,
        kind: keyOf(t.kind),
        state: t.state
          .slice(0, 6)
          .map((s) => ({ var: keyOf(s.var), value: clamp(s.value, 0, b.varMax) })),
        ...(t.owner.trim() ? { owner: keyOf(t.owner) } : {}),
      },
    ];
  });
  scene.objects.forEach((o, i) => {
    if (!claimed.has(i)) issues.push(`object ${i} (${o.label}) has no kind, so nobody can use it.`);
  });
  for (const t of things) {
    if (!kindKeys.has(t.kind)) issues.push(`a thing uses kind "${t.kind}", which isn't defined.`);
  }
  const people = unique(
    draft.people.slice(0, b.people).map((p, i) => ({
      key: keyOf(p.key || p.name || `person_${i}`),
      name: cleanText(p.name, 80) || `Person ${i + 1}`,
      about: cleanText(p.about, 200),
      colours: {
        skin: colourOf(p.skin, issues, `person ${p.name} skin`),
        top: colourOf(p.top, issues, `person ${p.name} top`),
        bottom: colourOf(p.bottom, issues, `person ${p.name} bottom`),
        hair: colourOf(p.hair || "#1a1310", issues, `person ${p.name} hair`),
        accent: colourOf(p.accent || "#f2e6c9", issues, `person ${p.name} accent`),
      },
      ...((look) => (look ? { look } : {}))(
        compilePersonLook(p.look, p.heightMm, issues, `person ${cleanText(p.name, 40)}`),
      ),
      body: {
        widthMm: clamp(p.widthMm, b.body.widthMm.min, b.body.widthMm.max),
        stepMm: clamp(p.stepMm, b.body.stepMm.min, b.body.stepMm.max),
        stairs: p.stairs,
        slopePermille: clamp(p.slopePermille, b.body.slopePermille.min, b.body.slopePermille.max),
        speedMmPerS: clamp(p.speedMmPerS, b.body.speedMmPerS.min, b.body.speedMmPerS.max),
        seated: p.seated,
      },
      money: clamp(p.money, 0, b.money),
      needs: p.needs
        .slice(0, b.needs)
        .map((n) => ({ need: keyOf(n.need), start: clamp(n.start, 0, 1000) })),
    })),
    "person",
    issues,
  );
  if (needs.length === 0) issues.push("the world has no needs; people need reasons to act.");
  if (args.filmed?.namedNobody && people.length > 0) {
    issues.push(
      "this is a real place and nobody was named there; the people written were left out.",
    );
    people.length = 0;
  }
  if (people.length === 0 && !args.filmed) issues.push("the world has no people.");
  // A thing can only belong to someone who's here.
  const personKeys = new Set(people.map((p) => p.key));
  for (const t of things) {
    if (t.owner !== undefined && !personKeys.has(t.owner)) {
      issues.push(`${t.object} belongs to "${t.owner}", who isn't one of the people here.`);
      delete (t as { owner?: string }).owner;
    }
  }
  const ground = draft.ground.flatMap((g) => {
    const space = scene.spaces[g.space];
    return space
      ? [{ space: space.id, colour: colourOf(g.colour, issues, `ground ${g.space}`) }]
      : [];
  });

  const hourPay = hourPayOf(args.hourPay ?? 0, draft.hourPay, issues);
  // What stays with people: the city's, and how close someone is to each person here. Actions
  // can name a person for that: "Tariq" means how close you are to Tariq.
  const marks = [
    ...(args.cityMarks ?? []),
    ...people.map((p) => ({
      key: closenessKey(p.key),
      label: p.name,
      max: CLOSENESS_MAX,
      shown: false,
    })),
  ].slice(0, b.marks);
  const markKeys = new Set(marks.map((m) => m.key));
  const closeTo = new Map<string, string>();
  for (const p of people) {
    closeTo.set(p.key, closenessKey(p.key));
    closeTo.set(keyOf(p.name), closenessKey(p.key));
  }
  const markOf = (raw: string, where: string): string | null => {
    const key = markKeys.has(raw) ? raw : closeTo.get(raw);
    if (key && markKeys.has(key)) return key;
    issues.push(`${where} uses "${raw}", which isn't one of the marks people have here.`);
    return null;
  };
  const markedKinds = kinds.map((k) => ({
    ...k,
    actions: k.actions.map((a) => {
      const where = `"${k.label}: ${a.label}"`;
      const moved = (a.marks ?? []).flatMap((m) => {
        const mark = markOf(m.mark, where);
        return mark ? [{ ...m, mark }] : [];
      });
      const asked = (a.asks ?? []).flatMap((x) => {
        const mark = markOf(x.mark, where);
        return mark ? [{ ...x, mark }] : [];
      });
      // A chance of more isn't a licence to print money: it's bounded by what work pays here.
      const mostChance = Math.max(hourPay, Math.floor((hourPay * 3 * a.durationMin) / 60));
      const outcomes = (a.outcomes ?? []).map((o) => {
        const favoured = o.favours ? markOf(o.favours.mark, where) : null;
        const { favours: _f, ...plain } = o;
        return {
          ...plain,
          ...(favoured && o.favours ? { favours: { ...o.favours, mark: favoured } } : {}),
          money: clamp(o.money, -mostChance, mostChance),
          marks: o.marks.flatMap((m) => {
            const mark = markOf(m.mark, where);
            return mark ? [{ ...m, mark }] : [];
          }),
        };
      });
      const { marks: _m, asks: _a, outcomes: _o, ...rest } = a;
      return {
        ...rest,
        ...(moved.length > 0 ? { marks: moved } : {}),
        ...(asked.length > 0 ? { asks: asked } : {}),
        ...(outcomes.length > 1 ? { outcomes } : {}),
      };
    }),
  }));

  const parsed = WorldSpec.safeParse({
    format: WORLD_SPEC_FORMAT,
    version: 1,
    scene: args.sceneHash,
    author: args.author,
    name: cleanText(draft.name, 120) || "Untitled place",
    summary: cleanText(draft.summary, 500),
    currency: args.currency,
    hourPay,
    livedIn: draft.livedIn,
    needs,
    marks,
    resources,
    kinds: markedKinds,
    things,
    people,
    ground,
    walls: { colour: colourOf(draft.wallColour, issues, "walls") },
  });
  if (!parsed.success) {
    for (const i of parsed.error.issues.slice(0, 30)) {
      issues.push(i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message);
    }
    return { spec: null, issues };
  }
  return { spec: parsed.data, issues };
}

// ── The loop ──────────────────────────────────────────────────────────────────────────

/** Errors dominate, then things to fix, then warnings. A missing spec is worst. */
const badness = (spec: WorldSpec | null, findings: readonly WorldCritique[]) =>
  spec === null
    ? Number.POSITIVE_INFINITY
    : findings.reduce(
        (n, f) => n + (f.severity === "error" ? 1000 : f.severity === "fix" ? 10 : 1),
        0,
      );

export async function authorWorld(
  input: { scene: Scene; sceneHash: ArtifactHash; brief: WorldBrief },
  deps: WorldDeps,
): Promise<WorldResult> {
  const signal = deps.signal ?? new AbortController().signal;
  const stageDeps: StageDeps = {
    store: deps.store,
    index: deps.index,
    signal,
    ...(deps.onStage ? { onStage: deps.onStage } : {}),
  };
  const stages: StageRecord[] = [];
  let cached = 0;
  const run = async <K extends string>(
    spec: Parameters<typeof runStage>[0],
    exec: Parameters<typeof runStage<K>>[2],
  ) => {
    const result = await runStage(spec, stageDeps, exec);
    stages.push(result.record);
    if (result.cached) cached++;
    return result;
  };
  const ctx = (seed: number) => ({ store: deps.store, seed, signal });
  const briefRef = await deps.store.put(json(input.brief).bytes, "application/json");

  let best: { spec: WorldSpec | null; specRef: ArtifactRef | null; findings: WorldCritique[] } = {
    spec: null,
    specRef: null,
    findings: [{ severity: "error", message: "no world was written" }],
  };
  let previous: { draftRef: ArtifactRef; draft: WorldDraft; findings: WorldCritique[] } | null =
    null;
  const maxRounds = deps.maxRounds ?? 3;
  let rounds = 0;
  for (let round = 0; round < maxRounds; round++) {
    rounds++;
    const findingsRef = previous
      ? await deps.store.put(json(previous.findings).bytes, "application/json")
      : null;
    const authored: StageResult<"draft"> = await run<"draft">(
      {
        stage: previous ? "revise-world" : "author-world",
        version: WORLD_HARNESS_VERSION,
        model: deps.author.model,
        prompt: previous ? deps.author.revisePrompt : deps.author.prompt,
        inputs: {
          brief: briefRef.hash,
          scene: input.sceneHash,
          ...(previous && findingsRef
            ? { draft: previous.draftRef.hash, findings: findingsRef.hash }
            : {}),
        },
        params: { effort: deps.author.effort, round },
      },
      async (seed) => {
        const raw = previous
          ? await deps.author.revise(
              input.brief,
              previous.draft,
              previous.findings.map((f) => `${f.severity}: ${f.message}`),
              ctx(seed),
            )
          : await deps.author.author(input.brief, ctx(seed));
        const parsed = WorldDraft.safeParse(raw);
        if (!parsed.success) {
          const first = parsed.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join(".")}: ${i.message}`);
          throw new Error(`world author: output rejected — ${first.join("; ")}`);
        }
        return { draft: json(parsed.data) };
      },
    );
    const draftRef: ArtifactRef = authored.outputs.draft;
    const draft = WorldDraft.parse(await readJson(deps.store, draftRef));

    const compiled = await run<"result">(
      {
        stage: "compile-world",
        version: WORLD_COMPILER_VERSION,
        model: null,
        prompt: null,
        inputs: { draft: draftRef.hash, scene: input.sceneHash, brief: briefRef.hash },
        params: {},
      },
      async () =>
        ({
          result: json(
            compileWorld({
              draft,
              scene: input.scene,
              sceneHash: input.sceneHash,
              currency: input.brief.currency,
              hourPay: input.brief.hourPay,
              author: deps.author.model,
              ...(input.brief.filmed
                ? { filmed: { namedNobody: !input.brief.description.trim() } }
                : {}),
              cityNeeds: input.brief.needs.map((n) => ({
                key: keyOf(n.key),
                label: n.label,
                decayPerHour: clamp(n.decayPerHour, 0, WORLD_BOUNDS.needDecayPerHour),
                ...(n.whenEmpty ? { whenEmpty: n.whenEmpty } : {}),
              })),
              cityMarks: input.brief.marks,
            }),
          ),
        }) as const,
    );
    const { spec, issues } = (await readJson(deps.store, compiled.outputs.result)) as {
      spec: unknown;
      issues: string[];
    };
    const valid = spec === null ? null : WorldSpec.parse(spec);
    const findings: WorldCritique[] = [
      // Anything compilation had to fix or drop is the model's to put right next round.
      ...issues.map((message) => ({
        severity: (valid === null ? "error" : "warning") as WorldCritique["severity"],
        message,
      })),
      ...(valid ? deps.critique(valid) : []),
    ];
    if (badness(valid, findings) < badness(best.spec, best.findings)) {
      const specRef = valid ? await deps.store.put(json(valid).bytes, "application/json") : null;
      best = { spec: valid, specRef, findings };
    }
    if (valid && findings.length === 0) break;
    if (valid && deps.untilNoErrors && !findings.some((f) => f.severity !== "warning")) break;
    previous = { draftRef, draft, findings };
  }
  return { ...best, rounds, stages, cached };
}

/** Every kind (at the size of a thing of that kind) and every person, to be looked at. */
export function looksOfWorld(spec: WorldSpec, scene: Scene): LookToJudge[] {
  const sizeOf = new Map<string, { w: number; h: number; d: number }>();
  for (const t of spec.things) {
    if (sizeOf.has(t.kind)) continue;
    const o = scene.objects.find((x) => x.id === t.object);
    if (o) sizeOf.set(t.kind, o.size);
  }
  return [
    ...spec.kinds.map((k) => ({
      label: k.label,
      role: `a thing in ${spec.name}`,
      tile: thingTile(k, sizeOf.get(k.key) ?? { w: 1000, h: 1000, d: 1000 }),
    })),
    ...spec.people.flatMap((p) =>
      p.look
        ? [
            {
              label: `${p.name}, ${p.about}`,
              role: `a person in ${spec.name}`,
              tile: personTile(p.look, p.colours),
            },
          ]
        : [],
    ),
  ];
}

// ── Improvising: a new ability on demand ──────────────────────────────────────────────

export interface ImproviseResult {
  spec: WorldSpec;
  specRef: ArtifactRef;
  kind: KindDef;
  findings: WorldCritique[];
  cached: boolean;
}

/** The model-facing form of an existing kind, so improvising edits what is there. */
export function draftOfKind(kind: KindDef): DraftKind {
  const cond = (c: Condition) =>
    "resource" in c
      ? { var: c.resource, op: "available" as const, value: 0 }
      : { var: c.var, op: c.op, value: c.value };
  return DraftKind.parse({
    key: kind.key,
    label: kind.label,
    solid: kind.solid,
    travelKmh: kind.travel?.speedKmh ?? 0,
    note: kind.note,
    vars: kind.vars,
    actions: kind.actions.map((a) => ({
      key: a.key,
      label: a.label,
      durationMin: a.durationMin,
      capacity: a.capacity,
      cost: a.cost,
      income: a.income,
      requires: a.requires.map(cond),
      marks: a.marks ?? [],
      asks: a.asks ?? [],
      outcomes: (a.outcomes ?? []).map((o) => ({
        weight: o.weight,
        favours: o.favours?.mark ?? "",
        perPoint: o.favours?.perPoint ?? 0,
        say: o.say,
        money: o.money,
        marks: o.marks,
      })),
      needs: a.needs,
      sets: a.sets,
      leaves: a.leaves === null ? "no" : a.leaves.withThing ? "with_thing" : "alone",
      pose: a.pose,
      // Worlds from before it existed: lying is on something, sitting is unsaid (beside).
      on: a.on ?? a.pose === "lie",
    })),
    supplies: kind.supplies.map((s) => ({ resource: s.resource, when: s.when.map(cond) })),
    look: kind.look.map((s) => ({
      shape: s.shape,
      x: s.centre[0],
      y: s.centre[1],
      z: s.centre[2],
      w: s.size[0],
      h: s.size[1],
      d: s.size[2],
      rx: s.rotateDeg[0],
      ry: s.rotateDeg[1],
      rz: s.rotateDeg[2],
      colour: s.colour,
      glow: s.glow,
      when: s.when.map(cond),
    })),
  });
}

/**
 * Someone tried something the world doesn't cover yet ("can I drive this?"). The model
 * rewrites that thing's kind to include it (new state, new actions, new looks), code compiles
 * and checks it in the context of the whole world, and it is play-tested. The kind keeps its
 * key, so every thing of that kind gains the ability. Memoised by spec, thing and request.
 */
export async function improvise(
  input: {
    scene: Scene;
    spec: WorldSpec;
    brief: WorldBrief;
    object: string;
    request: string;
  },
  deps: Omit<WorldDeps, "maxRounds">,
): Promise<ImproviseResult> {
  const signal = deps.signal ?? new AbortController().signal;
  const thing = input.spec.things.find((t) => t.object === input.object);
  const index = input.scene.objects.findIndex((o) => o.id === input.object);
  const current = thing ? input.spec.kinds.find((k) => k.key === thing.kind) : undefined;
  if (!thing || !current || index < 0) throw new Error("that thing isn't part of this world");
  const request = cleanText(input.request, 300);
  const stageDeps: StageDeps = {
    store: deps.store,
    index: deps.index,
    signal,
    ...(deps.onStage ? { onStage: deps.onStage } : {}),
  };
  const specRef = await deps.store.put(json(input.spec).bytes, "application/json");
  const briefRef = await deps.store.put(json(input.brief).bytes, "application/json");
  const result = await runStage(
    {
      stage: "improvise",
      version: WORLD_HARNESS_VERSION,
      model: deps.author.model,
      prompt: deps.author.improvisePrompt,
      inputs: { spec: specRef.hash, brief: briefRef.hash },
      params: {
        object: index,
        request,
        effort: deps.author.improviseEffort ?? deps.author.effort,
      },
    },
    stageDeps,
    async (seed) => {
      const raw = await deps.author.improvise(
        input.brief,
        {
          object: index,
          kind: draftOfKind(current),
          needs: input.spec.needs.map((n) => n.key),
          resources: input.spec.resources.map((r) => r.key),
          request,
        },
        { store: deps.store, seed, signal },
      );
      const parsed = DraftKind.safeParse(raw);
      if (!parsed.success) throw new Error("improvise: output rejected");
      return { kind: json(parsed.data) };
    },
  );
  const draft = DraftKind.parse(await readJson(deps.store, result.outputs.kind));
  const issues: string[] = [];
  const kind = compileKind(draft, issues, current.key);
  const next = WorldSpec.safeParse({
    ...input.spec,
    kinds: input.spec.kinds.map((k) => (k.key === current.key ? kind : k)),
  });
  if (!next.success) {
    throw new Error(
      `improvise: the new abilities don't fit this world — ${next.error.issues
        .slice(0, 3)
        .map((i) => i.message)
        .join("; ")}`,
    );
  }
  const findings = [
    ...issues.map((message) => ({ severity: "warning" as const, message })),
    ...deps.critique(next.data),
  ];
  const nextRef = await deps.store.put(json(next.data).bytes, "application/json");
  return { spec: next.data, specRef: nextRef, kind, findings, cached: result.cached };
}
