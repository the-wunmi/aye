/**
 * Navigation grid: rasterises one level of a scene into cells carrying walkability, floor
 * height, threshold lips, clearance and attribution (which opening or level change a cell
 * belongs to).
 *
 * One grid serves every body: whether a move is possible is decided per body (Mover)
 * at query time (see `moveCheck`). That is what lets the same scene answer "can Tolu get to
 * the toilet?" and "can Mama Ronke in her wheelchair?" without rebuilding anything.
 *
 * Determinism: only + - * / and Math.sqrt/floor/round on doubles (all exactly specified by
 * IEEE 754), integer trig from `trig.ts`, and iteration in scene array order.
 */

import type { LevelId, Scene } from "@aye/schema";
import { cosQ16, Q16, sinQ16 } from "./trig.ts";

export const MAX_GRID_CELLS = 2048 * 2048;

export const Flag = {
  Blocked: 1,
  Ramp: 2,
  Opening: 4,
  LevelChange: 8,
  /** Covered by an object that blocks movement (as opposed to a wall or the void). */
  Object: 16,
} as const;

export interface NavGrid {
  readonly levelId: LevelId;
  readonly cellMm: number;
  readonly diagMm: number;
  /** World x/z (mm) of the minimum corner of cell 0. */
  readonly originX: number;
  readonly originZ: number;
  readonly width: number;
  readonly height: number;
  readonly flags: Uint8Array;
  /** Absolute floor height in mm, including any threshold lip. */
  readonly floorMm: Int32Array;
  /** A doorway's raised lip in this cell (already in floorMm), stepped over on its own. */
  readonly lipMm: Int16Array;
  /** Distance from cell centre to the nearest blocked cell centre, in mm. */
  readonly clearanceMm: Int32Array;
  /** Index into scene.openings, or -1. */
  readonly opening: Int16Array;
  /** Index into scene.levelChanges, or -1. */
  readonly levelChange: Int16Array;
  /** Each ramp's whole slope, by level change: cells round their heights, so can't say it. */
  readonly rampPermille: Int32Array;
}

export function cellIndex(grid: NavGrid, cx: number, cz: number): number {
  return cz * grid.width + cx;
}

/** Cell containing a world point, or -1 if outside the grid. */
export function cellAt(grid: NavGrid, x: number, z: number): number {
  const cx = Math.floor((x - grid.originX) / grid.cellMm);
  const cz = Math.floor((z - grid.originZ) / grid.cellMm);
  if (cx < 0 || cz < 0 || cx >= grid.width || cz >= grid.height) return -1;
  return cz * grid.width + cx;
}

/** World-space centre of a cell, in mm. */
export function cellCentre(grid: NavGrid, index: number): [x: number, z: number] {
  const cx = index % grid.width;
  const cz = (index - cx) / grid.width;
  return [
    grid.originX + cx * grid.cellMm + grid.cellMm / 2,
    grid.originZ + cz * grid.cellMm + grid.cellMm / 2,
  ];
}

export function pointInPolygon(
  x: number,
  z: number,
  poly: readonly (readonly [number, number])[],
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i] as readonly [number, number];
    const [xj, zj] = poly[j] as readonly [number, number];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** An oriented rectangle on the floor plane: centre, half extents, and yaw in degrees. */
export interface Obb {
  cx: number;
  cz: number;
  halfAlong: number;
  halfAcross: number;
  yawDeg: number;
}

/** Visit every cell whose centre lies inside the rectangle; passes local coordinates too. */
export function forEachCellInObb(
  grid: NavGrid,
  box: Obb,
  visit: (index: number, along: number, across: number) => void,
): void {
  const c = cosQ16(box.yawDeg) / Q16;
  const s = sinQ16(box.yawDeg) / Q16;
  const reach = Math.abs(box.halfAlong) + Math.abs(box.halfAcross);
  const x0 = Math.max(0, Math.floor((box.cx - reach - grid.originX) / grid.cellMm));
  const x1 = Math.min(grid.width - 1, Math.floor((box.cx + reach - grid.originX) / grid.cellMm));
  const z0 = Math.max(0, Math.floor((box.cz - reach - grid.originZ) / grid.cellMm));
  const z1 = Math.min(grid.height - 1, Math.floor((box.cz + reach - grid.originZ) / grid.cellMm));
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      const dx = grid.originX + cx * grid.cellMm + grid.cellMm / 2 - box.cx;
      const dz = grid.originZ + cz * grid.cellMm + grid.cellMm / 2 - box.cz;
      const along = dx * c + dz * s;
      const across = -dx * s + dz * c;
      if (Math.abs(along) <= box.halfAlong && Math.abs(across) <= box.halfAcross) {
        visit(cz * grid.width + cx, along, across);
      }
    }
  }
}

/** A thing whose bottom is this high (mm) above the floor is over people's heads. */
const OVERHEAD_CLEAR_MM = 2_000;

export interface BuildOptions {
  cellMm: number;
  /** Whether people must walk around this thing. From the world spec; solid if unknown. */
  isSolid?: (obj: Scene["objects"][number]) => boolean;
}

export function buildNavGrid(scene: Scene, levelId: LevelId, opts: BuildOptions): NavGrid {
  const level = scene.levels.find((l) => l.id === levelId);
  if (!level) throw new Error(`unknown level ${levelId}`);
  const cellMm = opts.cellMm;
  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const [x, z] of level.footprint) {
    minX = Math.min(minX, x);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxZ = Math.max(maxZ, z);
  }
  const width = Math.ceil((maxX - minX) / cellMm);
  const height = Math.ceil((maxZ - minZ) / cellMm);
  if (width * height > MAX_GRID_CELLS) {
    throw new RangeError(`level ${levelId} needs ${width}×${height} cells; raise gridCellMm`);
  }
  const n = width * height;
  const grid: NavGrid = {
    levelId,
    cellMm,
    diagMm: Math.round(cellMm * Math.SQRT2),
    originX: minX,
    originZ: minZ,
    width,
    height,
    flags: new Uint8Array(n).fill(Flag.Blocked),
    floorMm: new Int32Array(n).fill(level.elevationMm),
    clearanceMm: new Int32Array(n),
    opening: new Int16Array(n).fill(-1),
    lipMm: new Int16Array(n),
    levelChange: new Int16Array(n).fill(-1),
    rampPermille: new Int32Array(scene.levelChanges.length),
  };

  // 1. Floors: spaces make cells walkable. Later spaces win where polygons overlap.
  const spaceFloor = new Map<string, number>();
  for (const space of scene.spaces) {
    if (space.levelId !== levelId) continue;
    const floor = level.elevationMm + space.floorOffsetMm;
    spaceFloor.set(space.id, floor);
    let sx0 = Number.POSITIVE_INFINITY;
    let sz0 = Number.POSITIVE_INFINITY;
    let sx1 = Number.NEGATIVE_INFINITY;
    let sz1 = Number.NEGATIVE_INFINITY;
    for (const [x, z] of space.polygon) {
      sx0 = Math.min(sx0, x);
      sz0 = Math.min(sz0, z);
      sx1 = Math.max(sx1, x);
      sz1 = Math.max(sz1, z);
    }
    const cx0 = Math.max(0, Math.floor((sx0 - minX) / cellMm));
    const cx1 = Math.min(width - 1, Math.floor((sx1 - minX) / cellMm));
    const cz0 = Math.max(0, Math.floor((sz0 - minZ) / cellMm));
    const cz1 = Math.min(height - 1, Math.floor((sz1 - minZ) / cellMm));
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const x = minX + cx * cellMm + cellMm / 2;
        const z = minZ + cz * cellMm + cellMm / 2;
        if (!pointInPolygon(x, z, space.polygon)) continue;
        const i = cz * width + cx;
        grid.flags[i] = 0;
        grid.floorMm[i] = floor;
      }
    }
  }

  // 2. Walls block a band of their thickness.
  const wallThickness = new Map<string, number>();
  const wallYaw = new Map<string, number>();
  for (const wall of scene.walls) {
    if (wall.levelId !== levelId) continue;
    wallThickness.set(wall.id, wall.thicknessMm);
    wallYaw.set(wall.id, yawOf(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]));
    const [ax, az] = wall.a;
    const [bx, bz] = wall.b;
    const lx = bx - ax;
    const lz = bz - az;
    const len = Math.sqrt(lx * lx + lz * lz);
    if (len === 0) continue;
    forEachCellInObb(
      grid,
      {
        cx: (ax + bx) / 2,
        cz: (az + bz) / 2,
        halfAlong: len / 2,
        halfAcross: wall.thicknessMm / 2,
        yawDeg: yawOf(lx, lz),
      },
      (i) => {
        grid.flags[i] = (grid.flags[i] as number) | Flag.Blocked;
      },
    );
  }

  // 3. Openings carve through walls; thresholds raise the cell's effective floor.
  scene.openings.forEach((o, index) => {
    if (o.levelId !== levelId || o.kind === "window") return;
    const floors = o.connects.map((s) => (s === null ? undefined : spaceFloor.get(s)));
    const floor = Math.max(
      ...floors.filter((f): f is number => f !== undefined),
      level.elevationMm,
    );
    const depth = (o.wallId === null ? 200 : (wallThickness.get(o.wallId) ?? 200)) / 2 + cellMm;
    forEachCellInObb(
      grid,
      {
        cx: o.at[0],
        cz: o.at[1],
        halfAlong: o.clearWidthMm / 2,
        halfAcross: depth,
        // A door in a wall is cut along that wall, whatever angle it was given: a quarter
        // turn off would leave a gap only as wide as the wall is thick.
        yawDeg: (o.wallId === null ? undefined : wallYaw.get(o.wallId)) ?? o.yawDeg,
      },
      (i, _along, across) => {
        // Only the band inside the wall gets the lip; the approach either side keeps its floor.
        const inWall = Math.abs(across) <= depth - cellMm;
        grid.flags[i] = ((grid.flags[i] as number) & ~Flag.Blocked) | Flag.Opening;
        grid.opening[i] = index;
        if (inWall) {
          grid.floorMm[i] = floor + o.thresholdMm;
          grid.lipMm[i] = Math.min(o.thresholdMm, 32_767);
        }
      },
    );
  });

  // 4. Level changes within this level: stairs step up, ramps interpolate, all are attributed.
  scene.levelChanges.forEach((lc, index) => {
    if (lc.fromLevelId !== levelId || lc.toLevelId !== levelId || lc.kind === "lift") return;
    const [fx, fz] = lc.from;
    const [tx, tz] = lc.to;
    const dx = tx - fx;
    const dz = tz - fz;
    const run = Math.sqrt(dx * dx + dz * dz);
    if (run === 0) return;
    const fromCell = cellAt(grid, fx, fz);
    const base = fromCell >= 0 ? (grid.floorMm[fromCell] as number) : level.elevationMm;
    // A ramp joins the floors actually either side of it, wherever its ends were marked: a
    // crossing's first point may already be on the upper floor. Read before anything changes.
    const floorBeyond = (x: number, z: number, dirX: number, dirZ: number) => {
      const here = cellAt(grid, x, z);
      const own = here >= 0 ? (grid.floorMm[here] as number) : null;
      for (let cells = 1; cells * cellMm <= 300; cells++) {
        const at = cellAt(
          grid,
          Math.round(x + dirX * cells * cellMm),
          Math.round(z + dirZ * cells * cellMm),
        );
        if (at < 0 || (grid.flags[at] as number) & (Flag.Blocked | Flag.Ramp)) continue;
        if (grid.floorMm[at] !== own) return grid.floorMm[at] as number;
      }
      return own;
    };
    const alongX = dx / run;
    const alongZ = dz / run;
    const bottom = floorBeyond(fx, fz, -alongX, -alongZ) ?? base;
    // Its top is the floor where it ends, unless that's still the level it started from.
    const toCell = cellAt(grid, tx, tz);
    const ends = toCell >= 0 ? (grid.floorMm[toCell] as number) : null;
    const top =
      ends !== null && ends !== bottom
        ? ends
        : (floorBeyond(tx, tz, alongX, alongZ) ?? base + lc.riseMm);
    if (lc.kind === "ramp") {
      grid.rampPermille[index] = Math.floor((Math.abs(top - bottom) * 1000) / run);
    }
    forEachCellInObb(
      grid,
      {
        cx: (fx + tx) / 2,
        cz: (fz + tz) / 2,
        // One extra cell past the top so the edge itself is attributed to this change.
        halfAlong: run / 2 + cellMm,
        halfAcross: lc.widthMm / 2,
        yawDeg: yawOf(dx, dz),
      },
      (i, along) => {
        grid.levelChange[i] = index;
        grid.flags[i] = (grid.flags[i] as number) | Flag.LevelChange;
        const p = Math.min(1, Math.max(0, (along + run / 2) / run));
        if ((grid.flags[i] as number) & Flag.Blocked) return;
        if (lc.kind === "ramp") {
          // Its top cell too, so nobody meets a lip where the slope meets the floor.
          grid.flags[i] = (grid.flags[i] as number) | Flag.Ramp;
          grid.floorMm[i] = bottom + Math.round((top - bottom) * p);
          return;
        }
        if (p >= 1) return;
        if (lc.stepCount > 1) {
          const step = Math.floor(p * lc.stepCount);
          grid.floorMm[i] = base + Math.round((lc.riseMm * step) / lc.stepCount);
        }
      },
    );
  });

  // 5. Objects that block movement.
  for (const obj of scene.objects) {
    if (obj.levelId !== levelId) continue;
    if (!(opts.isSolid?.(obj) ?? true)) continue;
    // People walk under what's above their heads.
    if (obj.transform.position[1] >= OVERHEAD_CLEAR_MM) continue;
    forEachCellInObb(
      grid,
      {
        cx: obj.transform.position[0],
        cz: obj.transform.position[2],
        halfAlong: obj.size.w / 2,
        halfAcross: obj.size.d / 2,
        yawDeg: obj.transform.yawDeg,
      },
      (i) => {
        grid.flags[i] = (grid.flags[i] as number) | Flag.Blocked | Flag.Object;
      },
    );
  }

  computeClearance(grid);
  return grid;
}

/** Integer yaw (degrees) of a direction on the floor plane, via the deterministic table. */
function yawOf(dx: number, dz: number): number {
  if (dz === 0) return dx >= 0 ? 0 : 180;
  if (dx === 0) return dz > 0 ? 90 : 270;
  // Pick the table angle whose direction best matches; scenes rarely need sub-degree walls.
  let best = 0;
  let bestDot = Number.NEGATIVE_INFINITY;
  const len = Math.sqrt(dx * dx + dz * dz);
  for (let d = 0; d < 360; d++) {
    const dot = (dx * cosQ16(d) + dz * sinQ16(d)) / len;
    if (dot > bestDot) {
      bestDot = dot;
      best = d;
    }
  }
  return best;
}

/** Two-pass chamfer distance transform from blocked cells. Grid edges count as blocked. */
function computeClearance(grid: NavGrid): void {
  const { width, height, flags, clearanceMm: d, cellMm, diagMm } = grid;
  const far = 1 << 30;
  for (let i = 0; i < d.length; i++) d[i] = (flags[i] as number) & Flag.Blocked ? 0 : far;
  const at = (cx: number, cz: number) =>
    cx < 0 || cz < 0 || cx >= width || cz >= height ? 0 : (d[cz * width + cx] as number);
  for (let cz = 0; cz < height; cz++) {
    for (let cx = 0; cx < width; cx++) {
      const i = cz * width + cx;
      const v = Math.min(
        d[i] as number,
        at(cx - 1, cz) + cellMm,
        at(cx, cz - 1) + cellMm,
        at(cx - 1, cz - 1) + diagMm,
        at(cx + 1, cz - 1) + diagMm,
      );
      d[i] = v;
    }
  }
  for (let cz = height - 1; cz >= 0; cz--) {
    for (let cx = width - 1; cx >= 0; cx--) {
      const i = cz * width + cx;
      const v = Math.min(
        d[i] as number,
        at(cx + 1, cz) + cellMm,
        at(cx, cz + 1) + cellMm,
        at(cx + 1, cz + 1) + diagMm,
        at(cx - 1, cz + 1) + diagMm,
      );
      d[i] = v;
    }
  }
}

/** Why a single move between neighbouring cells fails for a body. */
export const Block = {
  None: 0,
  Solid: 1,
  Narrow: 2,
  Step: 3,
  Steep: 4,
  Threshold: 5,
} as const;
export type Block = (typeof Block)[keyof typeof Block];

/** What a body can get past: the physics of moving through a place. */
export interface Mover {
  clearWidthMm: number;
  maxStepRiseMm: number;
  maxSlopePermille: number;
  canUseStairs: boolean;
}

/** Edge clearance a cell offers: distance from its centre to the nearest obstacle's edge. */
export function edgeClearance(grid: NavGrid, i: number): number {
  return (grid.clearanceMm[i] as number) - grid.cellMm / 2;
}

/** Can `mover` step from cell `a` into neighbouring cell `b`? */
export function moveCheck(
  grid: NavGrid,
  a: number,
  b: number,
  _diagonal: boolean,
  mover: Mover,
): Block {
  const fb = grid.flags[b] as number;
  if (fb & Flag.Blocked) return Block.Solid;
  if (edgeClearance(grid, b) * 2 < mover.clearWidthMm) return Block.Narrow;
  const rise = Math.abs((grid.floorMm[b] as number) - (grid.floorMm[a] as number));
  if (rise === 0) return Block.None;
  const fa = grid.flags[a] as number;
  if (fa & fb & Flag.Ramp) {
    const ramp = grid.levelChange[a] as number;
    const slope = ramp >= 0 ? (grid.rampPermille[ramp] as number) : 0;
    return slope > mover.maxSlopePermille ? Block.Steep : Block.None;
  }
  if (rise <= mover.maxStepRiseMm) return Block.None;
  // A door's lip at the top of a step is stepped over on its own (a foot lifts over it), so
  // a walker manages both; wheels still have to roll over the lip, whatever its height.
  const lip = Math.max(grid.lipMm[a] as number, grid.lipMm[b] as number);
  if (lip > 0 && lip <= mover.maxStepRiseMm && rise - lip <= mover.maxStepRiseMm) {
    return Block.None;
  }
  // A rise inside a mapped level change is the step itself.
  if ((fa | fb) & Flag.LevelChange) return Block.Step;
  return (fa | fb) & Flag.Opening ? Block.Threshold : Block.Step;
}
