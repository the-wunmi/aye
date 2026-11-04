/**
 * Placement physics: where an object can be put, and whether it can get there.
 *
 * Moving furniture obeys the same world the characters live in:
 * - it stays inside the place and never overlaps the structure (walls, the void outside);
 *   things that aren't solid (a wall clock, a rug) may sit against or over anything,
 * - solid things don't overlap other solid things,
 * - and it must be carriable from where it is to where it goes without passing through a
 *   wall: through openings wide enough for its slimmest side (you can tip a wardrobe), over
 *   steps (people lift things), around nothing else (furniture can be shuffled).
 *
 * Built once per object being moved, then each candidate pose costs only the cells under its
 * footprint, so a drag can check every pointer move. `moveThing` runs the same check on the
 * worker before a move is saved, and the pipeline's arrangers use it too. Pure and deterministic.
 */
import type { ObjectId, Scene } from "@aye/schema";
import { buildNavGrid, Flag, forEachCellInObb, type Mover, type NavGrid } from "./navgrid.ts";
import { labelRegions } from "./path.ts";

/** Objects may touch walls and each other; this much overlap is forgiven. */
const TOUCH_MM = 40;

export class PlacementField {
  readonly #grid: NavGrid;
  /** Index of the solid object covering each cell, or -1. */
  readonly #owner: Int32Array;
  readonly #labels: string[];
  /** Carry regions per cell, for a body as wide as the object's slimmest side. */
  readonly #regions: Int32Array;
  readonly #reachable: Set<number>;
  readonly #size: { w: number; d: number };
  readonly #solid: boolean;
  readonly #againstWalls: boolean;
  readonly #bounds: { minX: number; maxX: number; minZ: number; maxZ: number };

  private constructor(
    scene: Scene,
    isSolid: (obj: Scene["objects"][number]) => boolean,
    objectId: ObjectId,
    cellMm: number,
    options: { walls?: boolean },
  ) {
    const obj = scene.objects.find((o) => o.id === objectId);
    if (!obj) throw new Error(`unknown object ${objectId}`);
    // The structure alone: walls, openings, level changes, and floor where spaces are.
    this.#grid = buildNavGrid({ ...scene, objects: [] }, obj.levelId, { cellMm });
    this.#size = { w: obj.size.w, d: obj.size.d };
    this.#solid = isSolid(obj);
    this.#againstWalls = !this.#solid && !options.walls;
    const level = scene.levels.find((l) => l.id === obj.levelId);
    const xs = level?.footprint.map((p) => p[0]) ?? [0];
    const zs = level?.footprint.map((p) => p[1]) ?? [0];
    this.#bounds = {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minZ: Math.min(...zs),
      maxZ: Math.max(...zs),
    };

    this.#owner = new Int32Array(this.#grid.width * this.#grid.height).fill(-1);
    this.#labels = [];
    for (const other of scene.objects) {
      if (other.id === objectId || other.levelId !== obj.levelId) continue;
      if (!isSolid(other)) continue;
      const index = this.#labels.length;
      this.#labels.push(other.label);
      forEachCellInObb(this.#grid, this.#box(other.transform, other.size), (i) => {
        this.#owner[i] = index;
      });
    }

    const slimmest = Math.max(100, Math.min(obj.size.w, obj.size.d, obj.size.h));
    const carrier: Mover = {
      clearWidthMm: slimmest,
      maxStepRiseMm: 10_000,
      maxSlopePermille: 1000,
      canUseStairs: true,
    };
    this.#regions = labelRegions(this.#grid, carrier);
    this.#reachable = new Set();
    forEachCellInObb(this.#grid, this.#box(obj.transform, obj.size), (i) => {
      const r = this.#regions[i] as number;
      if (r >= 0) this.#reachable.add(r);
    });
  }

  static for(
    scene: Scene,
    isSolid: (obj: Scene["objects"][number]) => boolean,
    objectId: ObjectId,
    cellMm = 100,
    /** `walls`: walls stop it even if it isn't solid, for something being moved by hand. */
    options: { walls?: boolean } = {},
  ): PlacementField {
    return new PlacementField(scene, isSolid, objectId, cellMm, options);
  }

  /** Why the object can't be at this pose, or null if it can. */
  problem(transform: { position: readonly number[]; yawDeg: number }): string | null {
    const [x = 0, , z = 0] = transform.position;
    const b = this.#bounds;
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return "That's outside the place.";
    let wall = false;
    let overlaps = -1;
    let arrives = this.#reachable.size === 0; // Wedged in already: don't trap it there.
    forEachCellInObb(this.#grid, this.#box(transform, this.#size), (i) => {
      if (!this.#againstWalls && (this.#grid.flags[i] as number) & Flag.Blocked) wall = true;
      if (this.#solid && overlaps < 0 && (this.#owner[i] as number) >= 0) {
        overlaps = this.#owner[i] as number;
      }
      if (this.#reachable.has(this.#regions[i] as number)) arrives = true;
    });
    if (wall) return "It won't go through the wall.";
    if (overlaps >= 0) return `It would bump into the ${this.#labels[overlaps]?.toLowerCase()}.`;
    if (!arrives) return "There's no way to carry it there.";
    return null;
  }

  #box(transform: { position: readonly number[]; yawDeg: number }, size: { w: number; d: number }) {
    return {
      cx: transform.position[0] ?? 0,
      cz: transform.position[2] ?? 0,
      halfAlong: Math.max(1, size.w / 2 - TOUCH_MM),
      halfAcross: Math.max(1, size.d / 2 - TOUCH_MM),
      yawDeg: transform.yawDeg,
    };
  }
}

/**
 * A check for a whole edit: every object whose pose or size changed must be placeable from where
 * it was. Returns the first problem, prefixed with the object's label. Only tests call it now;
 * moves by hand go through `moveThing`.
 */
export function placementProblem(
  before: Scene,
  after: Scene,
  isSolid: (obj: Scene["objects"][number]) => boolean,
  cellMm = 100,
): string | null {
  const was = new Map(before.objects.map((o) => [o.id as string, o]));
  for (const o of after.objects) {
    const prev = was.get(o.id);
    if (!prev) continue;
    const moved =
      prev.transform.position.some((v, i) => v !== o.transform.position[i]) ||
      prev.transform.yawDeg !== o.transform.yawDeg ||
      prev.size.w !== o.size.w ||
      prev.size.d !== o.size.d ||
      prev.levelId !== o.levelId;
    if (!moved) continue;
    if (prev.levelId !== o.levelId) return `${o.label}: moving between floors isn't supported yet.`;
    // Size as edited, starting from where it was.
    const start: Scene = {
      ...after,
      objects: after.objects.map((x) => (x.id === o.id ? { ...o, transform: prev.transform } : x)),
    };
    const problem = PlacementField.for(start, isSolid, o.id, cellMm).problem(o.transform);
    if (problem) return `${o.label}: ${problem}`;
  }
  return null;
}
