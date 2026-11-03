/**
 * Decorating: a place built quickly has only the things it needs to work. Here a
 * model fills it out like a set dresser, choosing library models (rugs, plants, shelves,
 * crates, stalls, trees) and where they go, so it looks lived-in.
 *
 * The model only *proposes*. Code places each item through the same placement physics that
 * moving furniture obeys (inside the place, off the walls, not on top of anything solid,
 * carriable to where it stands), keeps doorways clear, and then plays the world again: if the
 * dressing would stop anyone doing what they could before (a blocked path), it is pared back
 * until it doesn't. The model also says what people really do with what it chose (sit on a bench,
 * get a cold drink from a fridge), in the terms any other thing's actions are written in; those
 * are compiled and bounded the same way, and whatever would add a problem to the place is
 * dropped. Things nobody would use stay scenery. Every id comes from code.
 *
 * A memoised stage keyed by the scene, the world and the catalog: a replay makes no call.
 */
import type { ArtifactStore, RecipeIndex } from "@aye/artifacts";
import { deriveId, hashJson } from "@aye/artifacts";
import {
  type KindDef,
  type LibraryCatalog,
  libraryIndex,
  type ObjectId,
  Scene,
  type StageRecord,
  type ThingAsset,
  WORLD_BOUNDS,
  type WorldSettings,
  WorldSpec,
} from "@aye/schema";
import { PlacementField, Sim } from "@aye/sim";
import { z } from "zod";
import { DraftKind } from "./contracts.ts";
import { NONE } from "./furnish.ts";
import type { Furnisher } from "./providers.ts";
import { json, readJson, runStage, type StageDeps } from "./stage.ts";
import { compileKind, draftOfKind, keyOf } from "./world.ts";

/** Bump when what decorating sends, accepts or how it places changes. */
export const DECORATE_VERSION = 2;

/** The most items one pass may add, and the share of kinds it may use. */
const MAX_ITEMS = 36;
const MAX_NEW_KINDS = 14;

export interface DecorateRequest {
  place: { name: string; summary: string };
  /** What people here need, what an ordinary hour pays and the money: for what things do. */
  needs: { key: string; label: string }[];
  hourPay: number;
  currency: string;
  /** Spaces with their outline in metres. */
  spaces: { index: number; name: string; outdoor: boolean; outline: [number, number][] }[];
  /** What stands there already: leave room around it. */
  things: { label: string; x: number; z: number; w: number; d: number }[];
  /** Doorways and gaps people walk through: keep clear. */
  doors: { x: number; z: number; widthM: number }[];
  library: { id: string; label: string; tags: string[]; sizeM: [number, number, number] }[];
}

/** What people do with a thing, as any thing's actions are drafted. */
const UseActions = DraftKind.shape.actions.max(4);

export function decorateSchema(catalog: LibraryCatalog) {
  return z.strictObject({
    items: z
      .array(
        z.strictObject({
          asset: z.enum([NONE, ...catalog.things.map((t) => t.id)]),
          space: z.int().min(0),
          x: z.number(),
          z: z.number(),
          yawDeg: z.int(),
        }),
      )
      .max(MAX_ITEMS),
    uses: z
      .array(z.strictObject({ asset: z.string().max(64), actions: UseActions }))
      .max(MAX_NEW_KINDS),
  });
}

const LooseAnswer = z.object({
  items: z
    .array(
      z.object({
        asset: z.string().max(64),
        space: z.int(),
        x: z.number(),
        z: z.number(),
        yawDeg: z.int(),
      }),
    )
    .max(MAX_ITEMS * 2),
  uses: z
    .array(z.object({ asset: z.string().max(64), actions: UseActions }))
    .max(MAX_NEW_KINDS * 2)
    .default([]),
});

export interface DecorateDeps {
  furnisher: Furnisher;
  store: ArtifactStore;
  index: RecipeIndex;
  catalog: LibraryCatalog;
  /** Plays a world (the worker's settings); decorating may not add errors to it. */
  critique: (scene: Scene, spec: WorldSpec) => { severity: string; message: string }[];
  /** The place's settings (grid), for checking nothing becomes unreachable. */
  settings: WorldSettings;
  signal?: AbortSignal;
  onStage?: StageDeps["onStage"];
}

export interface DecorateResult {
  scene: Scene;
  spec: WorldSpec;
  added: number;
  stages: StageRecord[];
  cached: number;
}

export const m1 = (mm: number) => Math.round(mm / 100) / 10;

export function inside(
  x: number,
  z: number,
  poly: readonly (readonly [number, number])[],
): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i] as readonly [number, number];
    const [xj, zj] = poly[j] as readonly [number, number];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/** Set dressing: solid unless it lies flat or hangs (rugs, curtains, things a few cm tall). */
export const solidOf = (a: ThingAsset) =>
  a.sizeMm[1] >= 250 && !a.tags.some((t) => t === "rug" || t === "window");

/** Already-decorated places say so in their kinds; they're left alone. */
export const DECOR_PREFIX = "set_";

export async function decoratePlace(
  scene: Scene,
  spec: WorldSpec,
  deps: DecorateDeps,
): Promise<DecorateResult> {
  const signal = deps.signal ?? new AbortController().signal;
  const library = libraryIndex(deps.catalog);
  const none = { scene, spec, added: 0, stages: [], cached: 0 };
  if (deps.catalog.things.length === 0) return none;
  if (spec.kinds.some((k) => k.key.startsWith(DECOR_PREFIX))) return none;
  const level = scene.levels[0];
  if (!level) return none;

  const request: DecorateRequest = {
    place: { name: spec.name, summary: spec.summary },
    needs: spec.needs.map((n) => ({ key: n.key, label: n.label })),
    hourPay: spec.hourPay,
    currency: spec.currency,
    spaces: scene.spaces.map((s, index) => ({
      index,
      name: s.name,
      outdoor: s.ceilingMm === null,
      outline: s.polygon.map(([x, z]) => [m1(x), m1(z)] as [number, number]),
    })),
    things: scene.objects.map((o) => ({
      label: o.label,
      x: m1(o.transform.position[0]),
      z: m1(o.transform.position[2]),
      w: m1(o.size.w),
      d: m1(o.size.d),
    })),
    doors: [
      ...scene.openings.map((o) => ({
        x: m1(o.at[0]),
        z: m1(o.at[1]),
        widthM: m1(o.clearWidthMm),
      })),
      ...scene.portals.map((p) => ({ x: m1(p.at[0]), z: m1(p.at[1]), widthM: m1(p.widthMm) })),
    ],
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
      stage: "decorate-place",
      version: DECORATE_VERSION,
      model: deps.furnisher.model,
      prompt: deps.furnisher.decoratePrompt,
      inputs: { request: requestRef.hash, catalog: catalogRef.hash },
      params: { effort: deps.furnisher.effort },
    },
    {
      store: deps.store,
      index: deps.index,
      signal,
      ...(deps.onStage ? { onStage: deps.onStage } : {}),
    },
    async (seed) => {
      const raw = await deps.furnisher.decorate(request, decorateSchema(deps.catalog), {
        store: deps.store,
        seed,
        signal,
      });
      const parsed = LooseAnswer.safeParse(raw);
      if (!parsed.success) throw new Error("decorator: output rejected");
      return { answer: json(parsed.data) };
    },
  );
  const answer = LooseAnswer.parse(await readJson(deps.store, result.outputs.answer));
  const stages = [result.record];
  const cached = result.cached ? 1 : 0;

  // ── Place each proposal through physics, in order ─────────────────────────────────────
  const sceneKey = hashJson(scene);
  const kindOf = new Map(spec.things.map((t) => [t.object as string, t.kind]));
  const solidKind = new Map(spec.kinds.map((k) => [k.key, k.solid]));
  const placedSolid = new Set<string>();
  const isSolid = (o: Scene["objects"][number]) =>
    placedSolid.has(o.id) || solidKind.get(kindOf.get(o.id) ?? "") === true;
  const doors = [
    ...scene.openings.map((o) => ({ at: o.at, r: o.clearWidthMm / 2 + 700 })),
    ...scene.portals.map((p) => ({ at: p.at, r: p.widthMm / 2 + 900 })),
  ];
  let working: Scene = scene;
  const placed: { object: Scene["objects"][number]; asset: ThingAsset; solid: boolean }[] = [];
  for (const [n, item] of answer.items.slice(0, MAX_ITEMS).entries()) {
    const asset = library.thing(item.asset);
    const space = scene.spaces[item.space];
    if (!asset || asset.tags.includes("building") || !space) continue;
    const x = Math.round(item.x * 1000);
    const z = Math.round(item.z * 1000);
    if (!Number.isFinite(x) || !Number.isFinite(z) || !inside(x, z, space.polygon)) continue;
    const [w, h, d] = asset.sizeMm;
    const solid = solidOf(asset);
    const reach = Math.hypot(w, d) / 2;
    if (solid && doors.some((o) => Math.hypot(o.at[0] - x, o.at[1] - z) < o.r + reach)) continue;
    const yawDeg = ((Math.round(item.yawDeg) % 360) + 360) % 360;
    const id = deriveId("object", [sceneKey, "set", String(n), asset.id]) as ObjectId;
    const object = {
      id,
      label: asset.label,
      levelId: space.levelId,
      spaceId: space.id,
      transform: { position: [x, 0, z] as [number, number, number], yawDeg },
      size: { w, d, h },
      evidence: null,
    };
    // Physics decides: start it where it would stand, and ask if it may stand there.
    const trial: Scene = { ...working, objects: [...working.objects, object] };
    if (solid) placedSolid.add(id);
    const problem = PlacementField.for(trial, isSolid, id).problem(object.transform);
    if (problem) {
      placedSolid.delete(id);
      continue;
    }
    working = trial;
    placed.push({ object, asset, solid });
  }
  if (placed.length === 0) return { ...none, stages, cached };

  const usesOf = new Map(answer.uses.map((u) => [u.asset, u.actions]));
  /** Give a scenery kind what the model said people do with it, compiled like any other. */
  const withUses = (kind: KindDef, enabled: (asset: string) => boolean): KindDef => {
    const actions = kind.asset && enabled(kind.asset) ? usesOf.get(kind.asset) : undefined;
    if (!actions?.length) return kind;
    return {
      ...kind,
      // Dressing is something you use where it stands: "alone" here means nobody else on it, not
      // going out, which is how models read it. Only a thing you take out with you leaves.
      actions: compileKind(
        {
          ...draftOfKind(kind),
          actions: actions.map((a) => (a.leaves === "alone" ? { ...a, leaves: "no" as const } : a)),
        },
        [],
        kind.key,
      ).actions,
    };
  };
  const build = (keep: typeof placed, enabled: (asset: string) => boolean = () => true) => {
    const used = [...new Set(keep.map((p) => p.asset.id))].slice(0, MAX_NEW_KINDS);
    const kinds: KindDef[] = used.flatMap((id) => {
      const a = library.thing(id);
      if (!a) return [];
      return [
        withUses(
          {
            key: `${DECOR_PREFIX}${keyOf(id)}`.slice(0, 32),
            label: a.label,
            solid: solidOf(a),
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
            asset: id,
            note: "Set dressing chosen from the library.",
          },
          enabled,
        ),
      ];
    });
    const keyFor = new Map(kinds.map((k) => [k.asset as string, k.key]));
    const kept = keep.filter((p) => keyFor.has(p.asset.id));
    const nextScene = Scene.parse({
      ...scene,
      objects: [...scene.objects, ...kept.map((p) => p.object)],
    });
    const nextSpec = WorldSpec.parse({
      ...spec,
      kinds: [...spec.kinds, ...kinds],
      things: [
        ...spec.things,
        ...kept.map((p) => ({
          object: p.object.id,
          kind: keyFor.get(p.asset.id) as string,
          state: [],
        })),
      ],
    });
    return { scene: nextScene, spec: nextSpec, added: kept.length };
  };

  // ── Dressing may never cost anyone something they could do before ────────────────────
  // Every thing each person could reach must stay reachable (no bench boxed in by crates),
  // and the place must play no worse. Solid dressing is dropped, last first, until it holds.
  const reachable = (sc: Scene, w: WorldSpec): string[] => {
    const sim = new Sim({ scene: sc, spec: w, settings: deps.settings });
    // People arrive at the entrance on the first tick; reach is measured from there.
    sim.step([]);
    const out: string[] = [];
    for (let i = 0; i < sim.agentIds.length; i++) {
      if (!sim.present[i]) continue;
      sim.things.forEach((t, ti) => {
        if (sim.canReach(i, ti)) out.push(`${sim.agentIds[i]}:${t.id}`);
      });
    }
    return out;
  };
  const errors = (sc: Scene, w: WorldSpec) =>
    deps.critique(sc, w).filter((f) => f.severity === "error").length;
  const before = errors(scene, spec);
  const reachBefore = reachable(scene, spec);
  const keepsReach = (sc: Scene, w: WorldSpec) => {
    const now = new Set(reachable(sc, w));
    return reachBefore.every((r) => now.has(r));
  };
  let keep = placed;
  for (let guard = 0; guard <= placed.length && keep.length > 0; guard++) {
    const fits =
      spec.kinds.length + new Set(keep.map((p) => p.asset.id)).size <= WORLD_BOUNDS.kinds;
    if (fits) {
      const holds = (next: ReturnType<typeof build>) =>
        keepsReach(next.scene, next.spec) && errors(next.scene, next.spec) <= before;
      const all = build(keep);
      if (holds(all)) return { ...all, stages, cached };
      // One thing's uses breaking the place shouldn't leave every bed and chair doing nothing:
      // keep whichever uses the place can take, one thing at a time.
      let best = build(keep, () => false);
      if (holds(best)) {
        const kept = new Set<string>();
        for (const asset of new Set(keep.map((p) => p.asset.id))) {
          if (!usesOf.has(asset)) continue;
          const next = build(keep, (a) => a === asset || kept.has(a));
          if (holds(next)) {
            kept.add(asset);
            best = next;
          }
        }
        return { ...best, stages, cached };
      }
    }
    // Drop the last solid item (solid things are what can block), else the last of any.
    const lastSolid = keep.map((p) => p.solid).lastIndexOf(true);
    const drop = lastSolid >= 0 ? lastSolid : keep.length - 1;
    keep = keep.filter((_, i) => i !== drop);
  }
  return { ...none, stages, cached };
}
