/**
 * Making a place your own: someone says what they want ("a green sofa by the window", "get rid
 * of that table"), a model says which things from the asset library, where, what they'd cost
 * here and what can be done with them, and code decides what physically happens: everything
 * goes through the same placement checks as any furnishing, nothing may shut off a room, and a
 * bed across a doorway gets moved. The answer is a proposal: a scene, a world and a price. It
 * changes nothing until its owner buys it.
 *
 * Their words are data for the model. Its text is cleaned and display-only, and every number
 * it gives is bounded here. It never chooses ids.
 */
import { type ArtifactStore, deriveId, hashJson, type RecipeIndex } from "@aye/artifacts";
import {
  type KindDef,
  type LibraryCatalog,
  libraryIndex,
  type ObjectId,
  Scene,
  type StageRecord,
  WORLD_BOUNDS,
  WorldSpec,
} from "@aye/schema";
import { cutOff, PlacementField, solidity } from "@aye/sim";
import { z } from "zod";
import { cleanText } from "./assemble.ts";
import { makeWayThrough } from "./clear-ways.ts";
import { DraftKind } from "./contracts.ts";
import { DECOR_PREFIX, inside, m1, solidOf } from "./decorate.ts";
import { NONE } from "./furnish.ts";
import type { ProviderContext } from "./providers.ts";
import { json, readJson, runStage, type StageDeps } from "./stage.ts";
import { compileKind, draftOfKind, keyOf } from "./world.ts";

/** Bump when what a change sends, accepts or how it's applied changes. */
export const MAKE_YOURS_VERSION = 8;

/** The most one request may change. */
const MAX_CHANGES = 6;
/** The dearest single thing, in hours of ordinary work. */
const MOST_HOURS_FOR_ONE = 40;
const UseActions = DraftKind.shape.actions.max(3);
/** Where to try standing something, nearest first, around where the model said. */
const NUDGES_MM: readonly (readonly [number, number])[] = [
  [0, 0],
  ...[300, 600, 900, 1_200, 1_500].flatMap((r) => [
    [r, 0] as const,
    [-r, 0] as const,
    [0, r] as const,
    [0, -r] as const,
    [r, r] as const,
    [-r, r] as const,
    [r, -r] as const,
    [-r, -r] as const,
  ]),
];

export interface MakeYoursRequest {
  /** What they said. */
  ask: string;
  place: { name: string; summary: string };
  hourPay: number;
  currency: string;
  /** Name these by key in actions. */
  needs: { key: string; label: string }[];
  marks: { key: string; label: string }[];
  spaces: { index: number; name: string; outline: [number, number][] }[];
  things: { index: number; label: string; x: number; z: number; w: number; d: number }[];
  doors: { x: number; z: number }[];
  library: { id: string; label: string; tags: string[]; sizeM: [number, number, number] }[];
}

export function makeYoursSchema(catalog: LibraryCatalog) {
  return z.strictObject({
    /** One line to the player, in the city's voice. */
    say: z.string().max(200),
    add: z
      .array(
        z.strictObject({
          asset: z.enum([NONE, ...catalog.things.map((t) => t.id)]),
          space: z.int().min(0),
          x: z.number(),
          z: z.number(),
          yawDeg: z.int(),
          /** What it costs here, minor units. */
          price: z.int().min(0),
          actions: UseActions,
        }),
      )
      .max(MAX_CHANGES),
    remove: z.array(z.int().min(0)).max(MAX_CHANGES),
    move: z
      .array(
        z.strictObject({ thing: z.int().min(0), x: z.number(), z: z.number(), yawDeg: z.int() }),
      )
      .max(MAX_CHANGES),
  });
}

const Answer = z.object({
  say: z.string().max(400).default(""),
  add: z
    .array(
      z.object({
        asset: z.string().max(64),
        space: z.int(),
        x: z.number(),
        z: z.number(),
        yawDeg: z.int(),
        price: z.int(),
        actions: UseActions.default([]),
      }),
    )
    .max(MAX_CHANGES * 2)
    .default([]),
  remove: z
    .array(z.int())
    .max(MAX_CHANGES * 2)
    .default([]),
  move: z
    .array(z.object({ thing: z.int(), x: z.number(), z: z.number(), yawDeg: z.int() }))
    .max(MAX_CHANGES * 2)
    .default([]),
});

/** Changes places as asked (a model). */
export interface PlaceChanger {
  readonly model: { provider: string; model: string; version: string };
  readonly prompt: string;
  readonly effort: string;
  change(request: MakeYoursRequest, schema: z.ZodType, ctx: ProviderContext): Promise<unknown>;
}

export interface MakeYoursDeps {
  changer: PlaceChanger;
  store: ArtifactStore;
  index: RecipeIndex;
  catalog: LibraryCatalog;
  signal?: AbortSignal;
  onStage?: StageDeps["onStage"];
}

export interface MakeYoursResult {
  say: string;
  /** Null: nothing that was asked for could be done. */
  scene: Scene | null;
  spec: WorldSpec | null;
  price: number;
  /** What's different, in plain words: the things added, moved and taken away. */
  added: string[];
  moved: string[];
  removed: string[];
  /** What it wanted to add but physics wouldn't allow. */
  missed: string[];
  stage: StageRecord;
}

/**
 * What a bought thing can do. Comfort, never a money printer: it can't pay, moves a mark only a
 * step at a time, and uses only the needs and marks that exist here. What you buy makes life
 * better; earning is what the city's work is for.
 */
function boughtActions(
  kind: KindDef,
  actions: DraftKind["actions"],
  spec: WorldSpec,
  kindKey: string,
): KindDef["actions"] {
  const needs = new Set(spec.needs.map((n) => n.key));
  const marks = new Set((spec.marks ?? []).map((m) => m.key));
  // Used where it stands: "alone" here means nobody else on it, not going out, as models read it.
  const stayingHere = actions.map((a) =>
    a.leaves === "alone" ? { ...a, leaves: "no" as const } : a,
  );
  const compiled = compileKind({ ...draftOfKind(kind), actions: stayingHere }, [], kindKey).actions;
  // Someone paid for this: what it does has to do them some good, or it's better left as a thing.
  const worthHaving = compiled.filter(
    (a) => a.leaves || a.sets.length > 0 || a.needs.some((n) => n.perHour > 0),
  );
  return worthHaving.map((a) => ({
    ...a,
    income: 0,
    outcomes: [],
    needs: a.needs.filter((n) => needs.has(n.need)),
    marks: (a.marks ?? [])
      // What you buy for your home is yours to enjoy, not a shortcut to being good at something.
      .filter((x) => marks.has(x.mark) && x.by < 0)
      .map((x) => ({ ...x, by: Math.max(-1, x.by) })),
    asks: (a.asks ?? []).filter((x) => marks.has(x.mark)),
  }));
}

export async function makeYours(
  scene: Scene,
  spec: WorldSpec,
  ask: string,
  deps: MakeYoursDeps,
): Promise<MakeYoursResult> {
  const signal = deps.signal ?? new AbortController().signal;
  const library = libraryIndex(deps.catalog);
  const cutOffNow = new Set<string>(cutOff(scene, solidity(spec)).spaces);
  const request: MakeYoursRequest = {
    ask: cleanText(ask, 300),
    place: { name: spec.name, summary: spec.summary },
    hourPay: spec.hourPay,
    currency: spec.currency,
    needs: spec.needs.map((n) => ({ key: n.key, label: n.label })),
    marks: (spec.marks ?? []).map((m) => ({ key: m.key, label: m.label })),
    // Only where they could really use it: an empty room nobody can get into looks ideal.
    spaces: scene.spaces.flatMap((s, index) =>
      cutOffNow.has(s.id)
        ? []
        : [
            {
              index,
              name: s.name,
              outline: s.polygon.map(([x, z]) => [m1(x), m1(z)] as [number, number]),
            },
          ],
    ),
    things: scene.objects.map((o, index) => ({
      index,
      label: o.label,
      x: m1(o.transform.position[0]),
      z: m1(o.transform.position[2]),
      w: m1(o.size.w),
      d: m1(o.size.d),
    })),
    doors: scene.openings.map((o) => ({ x: m1(o.at[0]), z: m1(o.at[1]) })),
    library: deps.catalog.things
      .filter((t) => !t.tags.includes("building"))
      .map((t) => ({
        id: t.id,
        label: t.label,
        tags: t.tags,
        sizeM: [m1(t.sizeMm[0]), m1(t.sizeMm[1]), m1(t.sizeMm[2])],
      })),
  };
  const [requestRef, catalogRef] = await Promise.all([
    deps.store.put(json(request).bytes, "application/json"),
    deps.store.put(json(deps.catalog.things).bytes, "application/json"),
  ]);
  const result = await runStage<"answer">(
    {
      stage: "make-yours",
      version: MAKE_YOURS_VERSION,
      model: deps.changer.model as never,
      prompt: deps.changer.prompt,
      inputs: { request: requestRef.hash, catalog: catalogRef.hash },
      params: { effort: deps.changer.effort },
    },
    {
      store: deps.store,
      index: deps.index,
      signal,
      ...(deps.onStage ? { onStage: deps.onStage } : {}),
    },
    async (seed) => {
      const raw = await deps.changer.change(request, makeYoursSchema(deps.catalog), {
        store: deps.store,
        seed,
        signal,
      });
      const parsed = Answer.safeParse(raw);
      if (!parsed.success) throw new Error("make-yours: output rejected");
      return { answer: json(parsed.data) };
    },
  );
  const answer = Answer.parse(await readJson(deps.store, result.outputs.answer));
  const say = cleanText(answer.say, 200);
  const none: MakeYoursResult = {
    say,
    scene: null,
    spec: null,
    price: 0,
    added: [],
    moved: [],
    removed: [],
    missed: [],
    stage: result.record,
  };

  // ── What goes ──────────────────────────────────────────────────────────────────────────
  const removedIds = new Set(
    answer.remove.slice(0, MAX_CHANGES).flatMap((n) => {
      const o = scene.objects[n];
      return o ? [o.id as string] : [];
    }),
  );
  const removed = scene.objects.filter((o) => removedIds.has(o.id)).map((o) => o.label);
  let working: Scene = {
    ...scene,
    objects: scene.objects.filter((o) => !removedIds.has(o.id)),
  };
  let things = spec.things.filter((t) => !removedIds.has(t.object));
  let kinds: KindDef[] = spec.kinds;
  const kindOf = () => new Map(things.map((t) => [t.object as string, t.kind]));
  const placedSolid = new Set<string>();
  const isSolid = (o: Scene["objects"][number]) => {
    if (placedSolid.has(o.id)) return true;
    const key = kindOf().get(o.id);
    return kinds.find((k) => k.key === key)?.solid === true;
  };

  // ── What moves ─────────────────────────────────────────────────────────────────────────
  const moved: string[] = [];
  for (const m of answer.move.slice(0, MAX_CHANGES)) {
    const was = scene.objects[m.thing];
    if (!was || removedIds.has(was.id)) continue;
    const x = Math.round(m.x * 1000);
    const z = Math.round(m.z * 1000);
    const space = scene.spaces.find((s) => inside(x, z, s.polygon));
    if (!space || !Number.isFinite(x) || !Number.isFinite(z)) continue;
    const transform = {
      ...was.transform,
      position: [x, was.transform.position[1], z] as [number, number, number],
      yawDeg: ((Math.round(m.yawDeg) % 360) + 360) % 360,
    };
    const trial: Scene = {
      ...working,
      objects: working.objects.map((o) =>
        o.id === was.id ? { ...o, spaceId: space.id, transform } : o,
      ),
    };
    if (PlacementField.for(trial, isSolid, was.id).problem(transform)) continue;
    working = trial;
    moved.push(was.label);
  }

  // ── What arrives ───────────────────────────────────────────────────────────────────────
  const sceneKey = hashJson(scene);
  const doors = scene.openings.map((o) => ({ at: o.at, r: o.clearWidthMm / 2 + 500 }));
  const added: string[] = [];
  const missed: string[] = [];
  let price = 0;
  for (const [n, item] of answer.add.slice(0, MAX_CHANGES).entries()) {
    const asset = library.thing(item.asset);
    const space = scene.spaces[item.space];
    if (!asset || asset.tags.includes("building") || !space) continue;
    const wantX = Math.round(item.x * 1000);
    const wantZ = Math.round(item.z * 1000);
    if (!Number.isFinite(wantX) || !Number.isFinite(wantZ)) continue;
    const [w, h, d] = asset.sizeMm;
    const solid = solidOf(asset);
    const reach = Math.hypot(w, d) / 2;
    const id = deriveId("object", [
      sceneKey,
      "yours",
      request.ask,
      String(n),
      asset.id,
    ]) as ObjectId;
    const yawDeg = ((Math.round(item.yawDeg) % 360) + 360) % 360;
    if (solid) placedSolid.add(id);
    // Where they said, or as near as it'll go: a model's sense of a room is only so exact.
    let trial: Scene | null = null;
    for (const [dx, dz] of NUDGES_MM) {
      const x = wantX + dx;
      const z = wantZ + dz;
      if (!inside(x, z, space.polygon)) continue;
      if (solid && doors.some((o) => Math.hypot(o.at[0] - x, o.at[1] - z) < o.r + reach)) continue;
      const transform = { position: [x, 0, z] as [number, number, number], yawDeg };
      const object = {
        id,
        label: asset.label,
        levelId: space.levelId,
        spaceId: space.id,
        transform,
        size: { w, d, h },
        evidence: null,
      };
      const candidate: Scene = { ...working, objects: [...working.objects, object] };
      if (!PlacementField.for(candidate, isSolid, id).problem(transform)) {
        trial = candidate;
        break;
      }
    }
    if (!trial) {
      placedSolid.delete(id);
      missed.push(asset.label);
      continue;
    }
    working = trial;
    const kindKey = `${DECOR_PREFIX}${keyOf(asset.id)}`.slice(0, 32);
    if (!kinds.some((k) => k.key === kindKey)) {
      const kind: KindDef = {
        key: kindKey,
        label: asset.label,
        solid,
        vars: [],
        actions: [],
        supplies: [],
        look: [
          {
            shape: "box",
            centre: [0, 500, 0],
            size: [1000, 1000, 1000],
            rotateDeg: [0, 0, 0],
            colour: "#b8ab98",
            glow: false,
            when: [],
          },
        ],
        asset: asset.id,
        note: "Bought by whoever lives here.",
      };
      kinds = [
        ...kinds,
        item.actions.length > 0
          ? { ...kind, actions: boughtActions(kind, item.actions, spec, kindKey) }
          : kind,
      ];
    }
    things = [...things, { object: id, kind: kindKey, state: [] }];
    price += Math.max(
      Math.floor(spec.hourPay / 2),
      Math.min(item.price, spec.hourPay * MOST_HOURS_FOR_ONE),
    );
    added.push(asset.label);
  }
  // The model wrote its line before physics had its say: don't let it claim what didn't happen.
  const told = missed.length > 0 ? `${missed.join(", ")} wouldn't fit there.` : say;
  if (added.length + moved.length + removed.length === 0) {
    return { ...none, say: told, missed };
  }
  if (kinds.length > WORLD_BOUNDS.kinds) return none;

  // ── Physics has the last word ──────────────────────────────────────────────────────────
  const nextSpec = WorldSpec.parse({ ...spec, kinds, things });
  const solid = solidity(nextSpec);
  const clear = makeWayThrough(Scene.parse(working), solid).scene;
  const before = cutOff(scene, solidity(spec));
  const after = cutOff(clear, solid);
  if (after.spaces.length > before.spaces.length) {
    return { ...none, say: "That wouldn't leave a way through." };
  }
  // Never sell someone what they couldn't get to: a part of the place may be out of reach already.
  const stillThere = new Set(spec.things.map((t) => t.object as string));
  if (
    after.things.some((id) => !stillThere.has(id) && nextSpec.things.some((t) => t.object === id))
  ) {
    return { ...none, say: "You couldn't get to it there. Try somewhere else in the place." };
  }
  return {
    say: told,
    scene: clear,
    spec: nextSpec,
    price,
    added,
    moved,
    removed,
    missed,
    stage: result.record,
  };
}
