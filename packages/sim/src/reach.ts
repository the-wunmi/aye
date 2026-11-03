/**
 * Where bodies can be: the cells an object is used from and the cells people arrive at.
 *
 * Both respect the physical world. An object is usable only from floor that is within its
 * approach depth *and* connected to it without passing through a wall, so nobody uses a TV
 * through one. Arrivals land on floor roomy enough for any body.
 */
import type { Scene } from "@aye/schema";
import {
  cellAt,
  cellCentre,
  edgeClearance,
  Flag,
  forEachCellInObb,
  type NavGrid,
} from "./navgrid.ts";

/**
 * Walkable cells from which an object can be used: within its approach depth, and connected
 * to the object without passing through a wall (so nobody uses a TV through one). Furniture
 * doesn't stop an arm: a bottle on a counter is used from the floor in front of the counter.
 * Returned in ascending cell order.
 */
export function objectUseCells(
  grid: NavGrid,
  obj: Scene["objects"][number],
  approachDepthMm: number,
): number[] {
  const box = {
    cx: obj.transform.position[0],
    cz: obj.transform.position[2],
    halfAlong: obj.size.w / 2,
    halfAcross: obj.size.d / 2,
    yawDeg: obj.transform.yawDeg,
  };
  const inReach = new Set<number>();
  forEachCellInObb(
    grid,
    {
      ...box,
      halfAlong: box.halfAlong + approachDepthMm,
      halfAcross: box.halfAcross + approachDepthMm,
    },
    (i) => {
      // Open floor, or furniture: an arm goes across a counter, never through a wall.
      const f = grid.flags[i] as number;
      if (!(f & Flag.Blocked) || f & Flag.Object) inReach.add(i);
    },
  );
  // Seed from the footprint (and its ring, for objects that block), then flood within reach.
  const footprint: number[] = [];
  forEachCellInObb(grid, box, (i) => footprint.push(i));
  if (footprint.length === 0) {
    const c = cellAt(grid, box.cx, box.cz);
    if (c >= 0) footprint.push(c);
  }
  // Breadth-first by walking steps, capped at the approach depth: "within reach" means
  // reachable on foot within that distance, never around a wall or out a door and back.
  const maxSteps = Math.ceil(approachDepthMm / grid.cellMm) + 1;
  const depth = new Map<number, number>();
  const queue: number[] = [];
  const visit = (i: number, d: number) => {
    if (d <= maxSteps && inReach.has(i) && !depth.has(i)) {
      depth.set(i, d);
      queue.push(i);
    }
  };
  for (const f of footprint) visit(f, 0);
  for (const f of footprint) for (const n of neighbours4(grid, f)) visit(n, 1);
  for (let k = 0; k < queue.length; k++) {
    const c = queue[k] as number;
    const d = depth.get(c) as number;
    for (const n of neighbours4(grid, c)) visit(n, d + 1);
  }
  // Only floor is somewhere to stand, and beside a thing beats inside it: what's not solid can
  // still have sides (you'd use a booth from its counter, not vanish in its walls). Standing
  // in it is for when there's nowhere else.
  const standing = [...depth.keys()].filter((i) => !((grid.flags[i] as number) & Flag.Blocked));
  const within = new Set(footprint);
  const beside = standing.filter((i) => !within.has(i));
  return (beside.length > 0 ? beside : standing).sort((a, b) => a - b);
}

function neighbours4(grid: NavGrid, i: number): number[] {
  const x = i % grid.width;
  const out: number[] = [];
  if (x > 0) out.push(i - 1);
  if (x < grid.width - 1) out.push(i + 1);
  if (i >= grid.width) out.push(i - grid.width);
  if (i < grid.width * (grid.height - 1)) out.push(i + grid.width);
  return out;
}

const ARRIVAL_DEPTH_MM = 1500;
const ARRIVAL_CLEAR_WIDTH_MM = 1000;

/** Cells agents start from: the entry portal, else every portal, on this level. */
export function entryCells(scene: Scene, grid: NavGrid): number[] {
  const portals = scene.portals.filter(
    (p) => p.levelId === grid.levelId && (scene.entry === null || p.id === scene.entry),
  );
  const cells: number[] = [];
  for (const p of portals) {
    // Exits often sit exactly on the edge of the mapped ground: look from just inside it.
    const inside = (v: number, origin: number, cells: number) =>
      Math.min(origin + cells * grid.cellMm - 1, Math.max(origin, v));
    const c = cellAt(
      grid,
      inside(p.at[0], grid.originX, grid.width),
      inside(p.at[1], grid.originZ, grid.height),
    );
    if (c < 0) continue;
    // Portals sit on the scene boundary, where clearance is ~0. Arrive at the nearest cell
    // roomy enough for any body (so the boundary itself never reads as a barrier), else
    // the nearest walkable cell.
    let roomy = -1;
    let roomyD = Number.POSITIVE_INFINITY;
    let any = -1;
    let anyD = Number.POSITIVE_INFINITY;
    const region = {
      cx: p.at[0],
      cz: p.at[1],
      halfAlong: p.widthMm / 2,
      halfAcross: ARRIVAL_DEPTH_MM,
      yawDeg: p.yawDeg,
    };
    forEachCellInObb(grid, region, (i) => {
      if ((grid.flags[i] as number) & Flag.Blocked) return;
      const [x, z] = cellCentre(grid, i);
      const d = (x - p.at[0]) ** 2 + (z - p.at[1]) ** 2;
      if (d < anyD) {
        anyD = d;
        any = i;
      }
      if (edgeClearance(grid, i) * 2 >= ARRIVAL_CLEAR_WIDTH_MM && d < roomyD) {
        roomyD = d;
        roomy = i;
      }
    });
    const best = roomy >= 0 ? roomy : any;
    if (best >= 0) cells.push(best);
  }
  return cells;
}
