/**
 * The visual half of the harness: draw what models designed (things, people, buildings,
 * scenery) into numbered contact sheets, show them to a vision model, and turn what it says
 * into findings the authors revise from. Nothing here knows what anything should look like;
 * the critic judges each tile against its own name, and the author fixes it with primitives.
 *
 * Sheets and critiques are memoised stages (the sheet's bytes are an input), so a look that
 * hasn't changed is never judged twice.
 */
import type { ArtifactStore, RecipeIndex } from "@aye/artifacts";
import {
  type CityPlace,
  type KindDef,
  type Look,
  mapBlock,
  type PersonDef,
  type PersonLook,
  type Shape,
  type Solid,
  type StageRecord,
} from "@aye/schema";
import { LookReview } from "./contracts.ts";
import type { LookCritic, LookDesigner, LookDesignRequest, LookItem } from "./providers.ts";
import { contactSheet, type Placed, type Tile } from "./raster.ts";
import { json, readJson, runStage, type StageDeps } from "./stage.ts";
import type { WorldCritique } from "./world.ts";

/** Bump when how looks are drawn or judged changes. */
export const LOOK_CRITIQUE_VERSION = 1;
/** Below this score (out of 10), a look comes back to be fixed. */
export const LOOK_PASS_SCORE = 7;
const PER_SHEET = 16;

/** Solids sized in permille of a box (w, h, d metres), as placed primitives. */
export function placeSolids(solids: readonly Solid[], w: number, h: number, d: number): Placed[] {
  return solids.map((s) => ({
    primitive: s.shape,
    position: [(s.centre[0] / 1000) * w, (s.centre[1] / 1000) * h, (s.centre[2] / 1000) * d],
    scale: [
      Math.max(0.005, (s.size[0] / 1000) * w),
      Math.max(0.005, (s.size[1] / 1000) * h),
      Math.max(0.005, (s.size[2] / 1000) * d),
    ],
    rotateDeg: s.rotateDeg,
    colour: s.colour,
    glow: s.glow,
  }));
}

/** A kind as it first appears: shapes whose conditions hold for its initial state. */
export function thingTile(kind: KindDef, sizeMm: { w: number; h: number; d: number }): Tile {
  const initial = new Map(kind.vars.map((v) => [v.key, v.initial]));
  const shown = kind.look.filter((s: Shape) =>
    s.when.every((c) => {
      if ("resource" in c) return true;
      const v = initial.get(c.var) ?? 0;
      return c.op === "eq"
        ? v === c.value
        : c.op === "ne"
          ? v !== c.value
          : c.op === "gte"
            ? v >= c.value
            : v <= c.value;
    }),
  );
  return { shapes: placeSolids(shown, sizeMm.w / 1000, sizeMm.h / 1000, sizeMm.d / 1000) };
}

/** A person standing at rest, coloured with their own colours. */
export function personTile(look: PersonLook, colours: PersonDef["colours"]): Tile {
  const slot = (c: string) =>
    c === "skin"
      ? colours.skin
      : c === "top"
        ? colours.top
        : c === "bottom"
          ? colours.bottom
          : c === "hair"
            ? (colours.hair ?? "#1a1310")
            : c === "accent"
              ? (colours.accent ?? "#f2e6c9")
              : c;
  return {
    shapes: look.parts.flatMap((p) =>
      p.shapes.map((s) => ({
        primitive: s.shape,
        position: [s.centre[0] / 1000, s.centre[1] / 1000, s.centre[2] / 1000] as [
          number,
          number,
          number,
        ],
        scale: [
          Math.max(0.005, s.size[0] / 1000),
          Math.max(0.005, s.size[1] / 1000),
          Math.max(0.005, s.size[2] / 1000),
        ] as [number, number, number],
        rotateDeg: s.rotateDeg,
        colour: slot(s.colour),
      })),
    ),
  };
}

export function buildingTile(place: Pick<CityPlace, "sizeM" | "heightM" | "look">): Tile {
  const [w, h, d] = mapBlock(place);
  return { shapes: placeSolids(place.look?.solids ?? [], w, h, d) };
}

/** Anything's look in its own box (a mover's front faces +x). */
export function lookTile(look: Pick<Look, "sizeM" | "solids">): Tile {
  return { shapes: placeSolids(look.solids, look.sizeM[0], look.sizeM[1], look.sizeM[2]) };
}

export interface LookToJudge extends Omit<LookItem, "index"> {
  tile: Tile;
}

export interface LookDeps {
  critic: LookCritic;
  store: ArtifactStore;
  index: RecipeIndex;
  signal?: AbortSignal;
  onStage?: StageDeps["onStage"];
}

/**
 * Show the critic every look (16 to a sheet) and return what to fix, as warnings: looks are
 * worth revising, never a reason to refuse a world that plays.
 */
export async function reviewLooks(
  looks: readonly LookToJudge[],
  deps: LookDeps,
): Promise<{ findings: WorldCritique[]; stages: StageRecord[]; cached: number }> {
  const signal = deps.signal ?? new AbortController().signal;
  const stageDeps: StageDeps = {
    store: deps.store,
    index: deps.index,
    signal,
    ...(deps.onStage ? { onStage: deps.onStage } : {}),
  };
  const findings: WorldCritique[] = [];
  const stages: StageRecord[] = [];
  let cached = 0;
  const drawable = looks.filter(
    (l) => l.tile.shapes.length > 0 || (l.tile.meshes?.length ?? 0) > 0,
  );
  for (const l of looks) {
    if (l.tile.shapes.length === 0) {
      findings.push({ severity: "warning", message: `${l.label} (${l.role}) has no look at all.` });
    }
  }
  for (let start = 0; start < drawable.length; start += PER_SHEET) {
    const batch = drawable.slice(start, start + PER_SHEET);
    const sheet = await contactSheet(batch.map((l) => l.tile));
    const sheetRef = await deps.store.put(sheet, "image/png");
    const items: LookItem[] = batch.map((l, index) => ({ index, label: l.label, role: l.role }));
    const itemsRef = await deps.store.put(json(items).bytes, "application/json");
    const result = await runStage<"review">(
      {
        stage: "critique-looks",
        version: LOOK_CRITIQUE_VERSION,
        model: deps.critic.model,
        prompt: deps.critic.prompt,
        inputs: { sheet: sheetRef.hash, items: itemsRef.hash },
        params: { effort: deps.critic.effort },
      },
      stageDeps,
      async (seed) => {
        const raw = await deps.critic.critique(sheet, items, { store: deps.store, seed, signal });
        const parsed = LookReview.safeParse(raw);
        if (!parsed.success) throw new Error("look critic: output rejected");
        return { review: json(parsed.data) };
      },
    );
    stages.push(result.record);
    if (result.cached) cached++;
    const review = LookReview.parse(await readJson(deps.store, result.outputs.review));
    for (const t of review.tiles) {
      const item = batch[t.index];
      if (!item || t.score >= LOOK_PASS_SCORE) continue;
      const fixes = t.fixes.length > 0 ? t.fixes.join("; ") : "it doesn't read as what it is";
      findings.push({
        severity: "warning",
        message: `The look of ${item.label} (${item.role}) scores ${Math.max(0, Math.min(10, t.score))}/10: ${fixes}`,
      });
    }
  }
  return { findings, stages, cached };
}

// ── Refining: judge, redesign what's weak, judge again ─────────────────────────────────

/** Bump when the refinement loop's wiring changes. */
export const LOOK_REFINE_VERSION = 1;

/** One look to refine: as the model writes it, how to draw it, and what a redesign returns. */
export interface LookSubject<D> {
  id: string;
  label: string;
  role: string;
  /** How this look's coordinates work, for the designer. */
  frame: string;
  draft: D;
  /** Validates a redesign; null if it doesn't fit. */
  parse(raw: unknown): D | null;
  tile(draft: D): Tile;
}

export interface RefineDeps extends LookDeps {
  designer: LookDesigner;
  /** Redesigns allowed per look (default 3). */
  maxRedesigns?: number;
  /** Looks redesigned at once (default 4). */
  concurrency?: number;
  /** Score a look must reach to be left alone (default 8). */
  passScore?: number;
}

export interface RefineResult<D> {
  /** The best version of each look, by id. */
  drafts: Map<string, D>;
  scores: Map<string, number>;
  /** Looks that still don't pass after every redesign. */
  findings: WorldCritique[];
  stages: StageRecord[];
  cached: number;
}

async function pool<T>(items: readonly T[], width: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.max(1, width) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
    }),
  );
}

/**
 * The visual loop for many looks at once: a critic scores every look on contact sheets; each
 * weak one goes to a designer with a picture of itself and the critic's fixes, and comes back
 * whole; redesigned looks are judged again. Each look keeps its best version. Every critique
 * and redesign is a memoised stage, so finished looks replay with no calls.
 */
export async function refineLooks<D>(
  subjects: readonly LookSubject<D>[],
  deps: RefineDeps,
): Promise<RefineResult<D>> {
  const signal = deps.signal ?? new AbortController().signal;
  const stageDeps: StageDeps = {
    store: deps.store,
    index: deps.index,
    signal,
    ...(deps.onStage ? { onStage: deps.onStage } : {}),
  };
  const pass = deps.passScore ?? 8;
  const maxRedesigns = deps.maxRedesigns ?? 3;
  const stages: StageRecord[] = [];
  let cached = 0;
  const state = new Map(
    subjects.map((s) => [
      s.id,
      { s, draft: s.draft, best: s.draft, bestScore: -1, score: -1, fixes: [] as string[] },
    ]),
  );

  const at = (id: string) => {
    const x = state.get(id);
    if (!x) throw new Error(`refineLooks: unknown look ${id}`);
    return x;
  };
  const judge = async (ids: readonly string[]) => {
    const list = ids.map((id) => at(id)).filter((x) => x.s.tile(x.draft).shapes.length > 0);
    for (const x of ids.map((id) => at(id))) {
      if (x.s.tile(x.draft).shapes.length === 0) {
        x.score = 0;
        x.fixes = ["it has no shapes at all: build it from primitives"];
      }
    }
    for (let start = 0; start < list.length; start += PER_SHEET) {
      const batch = list.slice(start, start + PER_SHEET);
      const sheet = await contactSheet(batch.map((x) => x.s.tile(x.draft)));
      const sheetRef = await deps.store.put(sheet, "image/png");
      const items: LookItem[] = batch.map((x, index) => ({
        index,
        label: x.s.label,
        role: x.s.role,
      }));
      const itemsRef = await deps.store.put(json(items).bytes, "application/json");
      const result = await runStage<"review">(
        {
          stage: "critique-looks",
          version: LOOK_CRITIQUE_VERSION,
          model: deps.critic.model,
          prompt: deps.critic.prompt,
          inputs: { sheet: sheetRef.hash, items: itemsRef.hash },
          params: { effort: deps.critic.effort },
        },
        stageDeps,
        async (seed) => {
          const raw = await deps.critic.critique(sheet, items, { store: deps.store, seed, signal });
          const parsed = LookReview.safeParse(raw);
          if (!parsed.success) throw new Error("look critic: output rejected");
          return { review: json(parsed.data) };
        },
      );
      stages.push(result.record);
      if (result.cached) cached++;
      const review = LookReview.parse(await readJson(deps.store, result.outputs.review));
      batch.forEach((x, i) => {
        const t = review.tiles.find((r) => r.index === i);
        // Unreviewed tiles count as passing: the critic had nothing to say.
        x.score = t ? Math.max(0, Math.min(10, t.score)) : 10;
        x.fixes = t?.fixes ?? [];
      });
    }
    for (const id of ids) {
      const x = at(id);
      if (x.score > x.bestScore) {
        x.best = x.draft;
        x.bestScore = x.score;
      }
    }
  };

  const redesign = async (id: string) => {
    const x = at(id);
    const image = await contactSheet([x.s.tile(x.draft)], 1);
    const imageRef = await deps.store.put(image, "image/png");
    const request: LookDesignRequest = {
      label: x.s.label,
      role: x.s.role,
      frame: x.s.frame,
      current: x.draft,
      score: x.score,
      fixes: x.fixes,
    };
    const requestRef = await deps.store.put(json(request).bytes, "application/json");
    try {
      const result = await runStage<"look">(
        {
          stage: "redesign-look",
          version: LOOK_REFINE_VERSION,
          model: deps.designer.model,
          prompt: deps.designer.prompt,
          inputs: { request: requestRef.hash, image: imageRef.hash },
          params: { effort: deps.designer.effort },
        },
        stageDeps,
        async (seed) => {
          const raw = await deps.designer.redesign(request, image, {
            store: deps.store,
            seed,
            signal,
          });
          const parsed = x.s.parse(raw);
          if (parsed === null) throw new Error("look designer: output rejected");
          return { look: json(parsed) };
        },
      );
      stages.push(result.record);
      if (result.cached) cached++;
      const next = x.s.parse(await readJson(deps.store, result.outputs.look));
      if (next !== null) x.draft = next;
    } catch {
      // A failed redesign keeps the look as it was; the loop carries on with the rest.
    }
  };

  let pending = [...state.keys()];
  await judge(pending);
  for (let round = 0; round < maxRedesigns; round++) {
    pending = pending.filter((id) => at(id).score < pass);
    if (pending.length === 0) break;
    await pool(pending, deps.concurrency ?? 4, redesign);
    await judge(pending);
  }

  const findings: WorldCritique[] = [];
  for (const x of state.values()) {
    if (x.bestScore < LOOK_PASS_SCORE) {
      findings.push({
        severity: "warning",
        message: `The look of ${x.s.label} (${x.s.role}) still scores ${x.bestScore}/10 after redesigns.`,
      });
    }
  }
  return {
    drafts: new Map([...state].map(([id, x]) => [id, x.best])),
    scores: new Map([...state].map(([id, x]) => [id, x.bestScore])),
    findings,
    stages,
    cached,
  };
}
