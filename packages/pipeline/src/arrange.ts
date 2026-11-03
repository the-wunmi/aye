/**
 * Arranging a place: the harness looks at every seat and bed the way a player would, with
 * what's around it, and a model says which way each should face (a bench's back to the
 * wall and its seat toward the table it serves, a sofa toward the TV). Models write, code
 * checks: a turn is taken only if physics lets the thing stand that way and the
 * place plays no worse; anything else is left as it was.
 *
 * Why a picture: which way a library model faces is in its geometry, not in any word about
 * it, so the model judges what it can see; nothing in code says what a seat is or which side
 * is its front. Seats are whatever the world says people sit or lie on.
 *
 * A memoised stage per round: a replay makes no model call.
 */
import type { ArtifactStore, RecipeIndex } from "@aye/artifacts";
import {
  type LibraryCatalog,
  libraryIndex,
  type ObjectId,
  type Scene,
  type StageRecord,
  type WorldSettings,
  type WorldSpec,
} from "@aye/schema";
import { cosQ16, PlacementField, Q16, sinQ16 } from "@aye/sim";
import { z } from "zod";
import { fitMesh, type LibraryMesh, readLibraryMesh } from "./library-mesh.ts";
import { thingTile } from "./looks.ts";
import type { Arranger } from "./providers.ts";
import { contactSheet, shapeTriangles, type Tile, type Triangles } from "./raster.ts";
import { json, readJson, runStage, type StageDeps } from "./stage.ts";

/** Bump when what arranging draws, sends, accepts or applies changes. */
export const ARRANGE_VERSION = 3;

/**
 * What a seat's picture shows: things whose edge comes within NEAR_MM of its own, walls
 * within WALLS_MM of its middle; big tiles, a few to a sheet, so its shape reads clearly.
 */
const NEAR_MM = 1500;
const WALLS_MM = 2500;
const PER_SHEET = 6;
const TILE_PX = 512;
const ROUNDS = 2;

export const ArrangeAnswer = z.strictObject({
  tiles: z
    .array(
      z.strictObject({
        index: z
          .int()
          .min(0)
          .max(PER_SHEET - 1),
        /** Clockwise seen from above. */
        turnDeg: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
        why: z.string().max(200),
      }),
    )
    .max(PER_SHEET),
});
export type ArrangeAnswer = z.infer<typeof ArrangeAnswer>;

/** What the arranger is told about each tile (labels are the world's words: data). */
export interface ArrangeItem {
  index: number;
  thing: string;
  /** What people do on it. */
  uses: string[];
  /** What else is in the picture. */
  around: string[];
}

export interface ArrangeDeps {
  arranger: Arranger;
  store: ArtifactStore;
  index: RecipeIndex;
  catalog: LibraryCatalog;
  /** A library file's bytes, or null if it isn't here (then its primitives are drawn). */
  readAsset: (file: string) => Promise<Uint8Array | null>;
  /** Plays a world; arranging may not add errors to it. */
  critique: (scene: Scene, spec: WorldSpec) => { severity: string; message: string }[];
  settings: WorldSettings;
  signal?: AbortSignal;
  onStage?: StageDeps["onStage"];
}

export interface ArrangeResult {
  scene: Scene;
  turned: { thing: string; turnDeg: number; why: string }[];
  stages: StageRecord[];
  cached: number;
}

type SceneObject = Scene["objects"][number];

const SUBJECT = "#d23c3c";
/** Overhead parts (an awning's canvas) are left out, as the game's camera leaves them out. */
const OVERHEAD_M = 1.6;

function belowHead(tris: Triangles): Triangles {
  const keep: number[] = [];
  const colours: string[] = [];
  for (let i = 0; i + 8 < tris.positions.length; i += 9) {
    const p = tris.positions;
    const low = Math.min(p[i + 1] as number, p[i + 4] as number, p[i + 7] as number);
    if (low >= OVERHEAD_M) continue;
    for (let k = 0; k < 9; k++) keep.push(p[i + k] as number);
    colours.push(tris.colours[i / 9] ?? "#bbbbbb");
  }
  return { positions: Float32Array.from(keep), colours };
}
const WALL = "#d9d3c5";

/** Things people sit or lie ON, as the world says (unsaid: low enough to be sat on). */
export function seatsOf(scene: Scene, spec: WorldSpec): SceneObject[] {
  const kindOf = new Map(spec.things.map((t) => [t.object as string, t.kind]));
  return scene.objects.filter((o) => {
    const kind = spec.kinds.find((k) => k.key === kindOf.get(o.id));
    return kind?.actions.some(
      (a) =>
        (a.pose === "sit" || a.pose === "lie") &&
        (a.on ?? o.size.h <= (a.pose === "lie" ? 900 : 600)),
    );
  });
}

/** An object's triangles in a frame centred on `origin` (metres), turned by its yaw. */
function placeIn(tris: Triangles, o: SceneObject, origin: readonly [number, number]): Triangles {
  const c = cosQ16(o.transform.yawDeg) / Q16;
  const s = sinQ16(o.transform.yawDeg) / Q16;
  const ox = (o.transform.position[0] - origin[0]) / 1000;
  const oy = o.transform.position[1] / 1000;
  const oz = (o.transform.position[2] - origin[1]) / 1000;
  const out = new Float32Array(tris.positions.length);
  for (let i = 0; i < tris.positions.length; i += 3) {
    const x = tris.positions[i] as number;
    const z = tris.positions[i + 2] as number;
    out[i] = ox + x * c - z * s;
    out[i + 1] = oy + (tris.positions[i + 1] as number);
    out[i + 2] = oz + x * s + z * c;
  }
  return { positions: out, colours: tris.colours };
}

export async function arrangePlace(
  scene: Scene,
  spec: WorldSpec,
  deps: ArrangeDeps,
): Promise<ArrangeResult> {
  const signal = deps.signal ?? new AbortController().signal;
  const stageDeps: StageDeps = {
    store: deps.store,
    index: deps.index,
    signal,
    ...(deps.onStage ? { onStage: deps.onStage } : {}),
  };
  const library = libraryIndex(deps.catalog);
  const kindOf = new Map(spec.things.map((t) => [t.object as string, t.kind]));
  const kindFor = (o: SceneObject) => spec.kinds.find((k) => k.key === kindOf.get(o.id)) ?? null;
  const meshes = new Map<string, Promise<LibraryMesh | null>>();
  const meshOf = (assetId: string) => {
    const asset = library.thing(assetId);
    if (!asset) return Promise.resolve(null);
    let m = meshes.get(assetId);
    if (!m) {
      m = deps.readAsset(asset.file).then((b) => (b ? readLibraryMesh(b) : null));
      meshes.set(assetId, m);
    }
    return m;
  };
  /** How a thing looks, as triangles in its own frame (metres). */
  const looksOf = async (o: SceneObject): Promise<Triangles> => {
    const kind = kindFor(o);
    const w = o.size.w / 1000;
    const h = o.size.h / 1000;
    const d = o.size.d / 1000;
    const mesh = kind?.asset ? await meshOf(kind.asset) : null;
    if (mesh) return fitMesh(mesh, w, h, d);
    if (kind && kind.look.length > 0) return shapeTriangles(thingTile(kind, o.size).shapes);
    return shapeTriangles([
      {
        primitive: "box",
        position: [0, h / 2, 0],
        scale: [w, h, d],
        rotateDeg: [0, 0, 0],
        colour: "#a8a29a",
      },
    ]);
  };

  const isSolid = (o: SceneObject) => kindFor(o)?.solid === true;
  const errors = (sc: Scene) =>
    deps.critique(sc, spec).filter((f) => f.severity === "error").length;
  const before = errors(scene);
  let working = scene;
  const turned: ArrangeResult["turned"] = [];
  const stages: StageRecord[] = [];
  let cached = 0;
  let subjects = seatsOf(scene, spec);

  for (let round = 0; round < ROUNDS && subjects.length > 0; round++) {
    const next: SceneObject[] = [];
    for (let start = 0; start < subjects.length; start += PER_SHEET) {
      const batch = subjects.slice(start, start + PER_SHEET);
      const tiles: Tile[] = [];
      const items: ArrangeItem[] = [];
      for (const [index, seat] of batch.entries()) {
        const live = working.objects.find((o) => o.id === seat.id) ?? seat;
        const origin = [live.transform.position[0], live.transform.position[2]] as const;
        const reach = (o: SceneObject) => Math.max(o.size.w, o.size.d) / 2;
        const near = working.objects.filter(
          (o) =>
            o.id !== live.id &&
            Math.hypot(o.transform.position[0] - origin[0], o.transform.position[2] - origin[1]) -
              reach(o) -
              reach(live) <=
              NEAR_MM,
        );
        const own = placeIn(await looksOf(live), live, origin);
        const meshesHere: Triangles[] = [{ ...own, colours: own.colours.map(() => SUBJECT) }];
        for (const o of near) meshesHere.push(belowHead(placeIn(await looksOf(o), o, origin)));
        // Walls nearby, as low stubs so they don't hide the seat, clipped to the picture.
        const stubs = working.walls.flatMap((wall) => {
          const dx = wall.b[0] - wall.a[0];
          const dz = wall.b[1] - wall.a[1];
          const len = Math.hypot(dx, dz);
          if (len === 0) return [];
          const ux = dx / len;
          const uz = dz / len;
          // The stretch of the wall within WALLS_MM of the seat.
          const t0 = (origin[0] - wall.a[0]) * ux + (origin[1] - wall.a[1]) * uz;
          const off = Math.abs((origin[0] - wall.a[0]) * -uz + (origin[1] - wall.a[1]) * ux);
          if (off > WALLS_MM) return [];
          const half = Math.sqrt(WALLS_MM * WALLS_MM - off * off);
          const from = Math.max(0, t0 - half);
          const to = Math.min(len, t0 + half);
          if (to - from < 50) return [];
          const mid = (from + to) / 2;
          const yaw = (Math.atan2(dz, dx) * 180) / Math.PI;
          return [
            {
              primitive: "box" as const,
              position: [
                (wall.a[0] + ux * mid - origin[0]) / 1000,
                0.5,
                (wall.a[1] + uz * mid - origin[1]) / 1000,
              ] as [number, number, number],
              scale: [(to - from) / 1000, 1, wall.thicknessMm / 1000] as [number, number, number],
              rotateDeg: [0, -yaw, 0] as [number, number, number],
              colour: WALL,
            },
          ];
        });
        if (stubs.length > 0) meshesHere.push(shapeTriangles(stubs));
        tiles.push({ shapes: [], meshes: meshesHere });
        const kind = kindFor(live);
        items.push({
          index,
          thing: live.label,
          uses: (kind?.actions ?? []).map((a) => a.label).slice(0, 6),
          around: near.map((o) => o.label).slice(0, 10),
        });
      }
      const sheet = await contactSheet(tiles, 3, TILE_PX);
      const sheetRef = await deps.store.put(sheet, "image/png");
      const itemsRef = await deps.store.put(json(items).bytes, "application/json");
      const result = await runStage<"answer">(
        {
          stage: "arrange-place",
          version: ARRANGE_VERSION,
          model: deps.arranger.model,
          prompt: deps.arranger.prompt,
          inputs: { sheet: sheetRef.hash, items: itemsRef.hash },
          params: { effort: deps.arranger.effort, round },
        },
        stageDeps,
        async (seed) => {
          const raw = await deps.arranger.arrange(sheet, items, {
            store: deps.store,
            seed,
            signal,
          });
          const parsed = ArrangeAnswer.safeParse(raw);
          if (!parsed.success) throw new Error("arranger: output rejected");
          return { answer: json(parsed.data) };
        },
      );
      stages.push(result.record);
      if (result.cached) cached++;
      const answer = ArrangeAnswer.parse(await readJson(deps.store, result.outputs.answer));

      // ── Physics decides each turn; the place must play no worse ─────────────────────
      for (const t of answer.tiles) {
        const seat = batch[t.index];
        if (!seat || t.turnDeg === 0) continue;
        const live = working.objects.find((o) => o.id === seat.id);
        if (!live) continue;
        const transform = {
          ...live.transform,
          yawDeg: (live.transform.yawDeg + t.turnDeg) % 360,
        };
        const trial: Scene = {
          ...working,
          objects: working.objects.map((o) => (o.id === live.id ? { ...o, transform } : o)),
        };
        if (PlacementField.for(trial, isSolid, live.id as ObjectId).problem(transform)) continue;
        if (errors(trial) > before) continue;
        working = trial;
        turned.push({ thing: live.label, turnDeg: t.turnDeg, why: t.why });
        next.push(live);
      }
    }
    // Look again at what was turned: the model confirms (or corrects) its own work.
    subjects = next;
  }
  return { scene: working, turned, stages, cached };
}
