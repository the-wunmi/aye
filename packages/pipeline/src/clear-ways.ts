/**
 * Keeping the ways through a place clear: a layout a model imagines (or reads from a video)
 * can stand a bed across the front door, which makes everything beyond it unreachable. People
 * would never do that, and physics is code's, so after assembly every object
 * that stands in a doorway's approach (a door, an open doorway, a way out) is slid the
 * smallest distance that clears it: along the wall first, else away from it, never out of its
 * own space. Objects that can't be cleared stay where they are (the play-test will say so).
 *
 * Pure and deterministic: integer millimetres, the sim's integer trig, passages in id order.
 */
import { deriveId } from "@aye/artifacts";
import { Opening, type Scene, type WorldSettings, type WorldSpec } from "@aye/schema";
import {
  buildNavGrid,
  cellAt,
  cellCentre,
  cosQ16,
  entryCells,
  floodFill,
  labelRegions,
  type Mover,
  ORDINARY_BODY,
  PathFinder,
  Q16,
  Sim,
  sinQ16,
  solidity,
} from "@aye/sim";

/** How much of a doorway's approach is kept clear: either side of its width, and its depth. */
const SIDE_MM = 150;
const DEPTH_MM = 700;

type Pt = readonly [number, number];
interface Passage {
  at: Pt;
  /** Unit vector along the wall, and its normal. */
  u: Pt;
  n: Pt;
  half: number;
}

function insideAll(points: readonly Pt[], poly: readonly Pt[]): boolean {
  return points.every(([x, z]) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, zi] = poly[i] as Pt;
      const [xj, zj] = poly[j] as Pt;
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    }
    return hit;
  });
}

function corners(o: Scene["objects"][number], at: Pt): Pt[] {
  const c = cosQ16(o.transform.yawDeg) / Q16;
  const s = sinQ16(o.transform.yawDeg) / Q16;
  const hw = o.size.w / 2;
  const hd = o.size.d / 2;
  return [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ].map(
    ([x, z]) =>
      [
        at[0] + (x as number) * c - (z as number) * s,
        at[1] + (x as number) * s + (z as number) * c,
      ] as Pt,
  );
}

/** The object's extent in a passage's frame: [min, max] along the wall and across it. */
function extent(points: readonly Pt[], p: Passage) {
  let a0 = Infinity;
  let a1 = -Infinity;
  let n0 = Infinity;
  let n1 = -Infinity;
  for (const [x, z] of points) {
    const dx = x - p.at[0];
    const dz = z - p.at[1];
    const a = dx * p.u[0] + dz * p.u[1];
    const n = dx * p.n[0] + dz * p.n[1];
    a0 = Math.min(a0, a);
    a1 = Math.max(a1, a);
    n0 = Math.min(n0, n);
    n1 = Math.max(n1, n);
  }
  return { a0, a1, n0, n1 };
}

function blocks(points: readonly Pt[], p: Passage): boolean {
  const e = extent(points, p);
  return e.a1 > -p.half && e.a0 < p.half && e.n1 > -DEPTH_MM && e.n0 < DEPTH_MM;
}

export function passagesOf(scene: Scene): Passage[] {
  const walls = new Map(scene.walls.map((w) => [w.id as string, w]));
  const out: Passage[] = [];
  for (const o of [...scene.openings].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (o.kind === "window" || o.sillMm > 0) continue;
    const w = o.wallId ? walls.get(o.wallId) : undefined;
    let u: Pt = [cosQ16(o.yawDeg) / Q16, sinQ16(o.yawDeg) / Q16];
    if (w) {
      const len = Math.sqrt((w.b[0] - w.a[0]) ** 2 + (w.b[1] - w.a[1]) ** 2) || 1;
      u = [(w.b[0] - w.a[0]) / len, (w.b[1] - w.a[1]) / len];
    }
    out.push({ at: o.at, u, n: [-u[1], u[0]], half: o.clearWidthMm / 2 + SIDE_MM });
  }
  for (const p of [...scene.portals].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const u: Pt = [cosQ16(p.yawDeg) / Q16, sinQ16(p.yawDeg) / Q16];
    out.push({ at: p.at, u, n: [-u[1], u[0]], half: p.widthMm / 2 + SIDE_MM });
  }
  // Both ends of a flight of stairs or a ramp are ways through too.
  for (const l of [...scene.levelChanges].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const dx = l.to[0] - l.from[0];
    const dz = l.to[1] - l.from[1];
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const n: Pt = [dx / len, dz / len];
    const u: Pt = [-n[1], n[0]];
    for (const at of [l.from, l.to]) out.push({ at, u, n, half: l.widthMm / 2 + SIDE_MM });
  }
  return out;
}

/** The scene with objects slid out of every doorway's approach, where they can be. */
export function clearWays(scene: Scene): { scene: Scene; moved: number } {
  const passages = passagesOf(scene);
  if (passages.length === 0) return { scene, moved: 0 };
  const spaces = new Map(scene.spaces.map((s) => [s.id as string, s.polygon]));
  const footprint = scene.levels[0]?.footprint ?? [];
  let moved = 0;
  // Each object is cleared on its own (none is moved for another's sake), in scene order.
  const objects = scene.objects.map((o) => {
    let at: Pt = [o.transform.position[0], o.transform.position[2]];
    const within = (o.spaceId ? spaces.get(o.spaceId) : undefined) ?? footprint;
    for (let pass = 0; pass < 3; pass++) {
      const blocked = passages.find((p) => blocks(corners(o, at), p));
      if (!blocked) break;
      const e = extent(corners(o, at), blocked);
      const margin = 50;
      // Smallest moves first: along the wall either way, then away from it either way.
      const moves: [number, Pt][] = [
        [blocked.half - e.a0 + margin, blocked.u],
        [e.a1 + blocked.half + margin, [-blocked.u[0], -blocked.u[1]]],
        [DEPTH_MM - e.n0 + margin, blocked.n],
        [e.n1 + DEPTH_MM + margin, [-blocked.n[0], -blocked.n[1]]],
      ];
      moves.sort((a, b) => a[0] - b[0]);
      const next = moves
        .map(([d, dir]) => [Math.round(at[0] + dir[0] * d), Math.round(at[1] + dir[1] * d)] as Pt)
        .find((cand) => {
          const pts = corners(o, cand);
          return (
            (within.length < 3 || insideAll(pts, within)) && !passages.some((p) => blocks(pts, p))
          );
        });
      if (!next) break;
      at = next;
    }
    if (at[0] === o.transform.position[0] && at[1] === o.transform.position[2]) return o;
    moved++;
    return {
      ...o,
      transform: {
        ...o.transform,
        position: [at[0], o.transform.position[1], at[1]] as [number, number, number],
      },
    };
  });
  return { scene: { ...scene, objects }, moved };
}

/** An ordinary person on foot: who every space must be open to. */
const WALKER: Mover = ORDINARY_BODY;
const PROBE_MM = 100;

/** What stands on the floor and is big enough that nobody would plan to walk through it. */
const standsInTheWay = (o: Scene["objects"][number]) =>
  o.transform.position[1] < 150 && o.size.h >= 300;
/** Floor smaller than this, cut off, is a gap behind the furniture and nobody's loss. */
const WORTH_REACHING_CELLS = 100;
const SLIDES_MM = [200, 400, 600, 800, 1_000, 1_250, 1_500, 2_000];
const DIRECTIONS: readonly Pt[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];
const MAX_PASSES = 6;

/**
 * Furniture can seal off a floor the building leaves open: two things that each leave a gap can
 * together close it, so no one of them is to blame. So code does what anyone moving in would:
 * it finds the way someone would walk if nothing were there, and slides whatever stands on that
 * way the smallest distance that clears it, staying in its own space. It knows nothing about
 * what any of them is, only where it is and how big. Deterministic: things in id order, and
 * the first smallest slide that works.
 */
export function makeWayThrough(
  scene: Scene,
  inTheWay: (object: Scene["objects"][number]) => boolean = standsInTheWay,
): { scene: Scene; moved: string[] } {
  const level = scene.levels[0];
  if (!level) return { scene, moved: [] };
  const open = buildNavGrid(scene, level.id, { cellMm: PROBE_MM, isSolid: () => false });
  const starts = entryCells(scene, open);
  if (starts.length === 0) return { scene, moved: [] };
  const reachable = floodFill(open, starts, WALKER);
  const finder = new PathFinder(open);
  const polygons = new Map(scene.spaces.map((s) => [s.id as string, s.polygon]));
  const passages = passagesOf(scene);
  let current = scene;
  const moved = new Set<string>();
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const grid = buildNavGrid(current, level.id, { cellMm: PROBE_MM, isSolid: inTheWay });
    const regions = labelRegions(grid, WALKER);
    const sizes = new Map<number, number>();
    for (const r of regions) if (r >= 0) sizes.set(r, (sizes.get(r) ?? 0) + 1);
    // The ground people arrive on: of the ways in, the one that opens onto the most.
    let main = -1;
    for (const c of entryCells(current, grid)) {
      const r = regions[c] as number;
      if (r >= 0 && (sizes.get(r) ?? 0) > (sizes.get(main) ?? 0)) main = r;
    }
    if (main < 0) break;
    let stranded = -1;
    for (let c = 0; c < regions.length; c++) {
      const r = regions[c] as number;
      if (r < 0 || r === main || reachable[c] !== 1) continue;
      if ((sizes.get(r) ?? 0) >= WORTH_REACHING_CELLS) {
        stranded = c;
        break;
      }
    }
    if (stranded < 0) break;
    // The way someone would walk with nothing there.
    const startCell = regions.findIndex((r) => r === main);
    const way = finder.find(startCell, new Set([stranded]), stranded, WALKER);
    if (!way || way.length === 0) break;
    const points = way.map((c) => cellCentre(open, c) as Pt);
    const clear = WALKER.clearWidthMm / 2 + 50;
    const onTheWay = (o: Scene["objects"][number], at: Pt) => {
      const c = cosQ16(o.transform.yawDeg) / Q16;
      const s = sinQ16(o.transform.yawDeg) / Q16;
      return points.some(([x, z]) => {
        const dx = x - at[0];
        const dz = z - at[1];
        return (
          Math.abs(dx * c + dz * s) < o.size.w / 2 + clear &&
          Math.abs(-dx * s + dz * c) < o.size.d / 2 + clear
        );
      });
    };
    let changed = false;
    // Floor that can really be walked to: a move is only as good as what it opens up.
    const floorReached = (at: Scene) => {
      const g = buildNavGrid(at, level.id, { cellMm: PROBE_MM, isSolid: inTheWay });
      const rs = labelRegions(g, WALKER);
      const counts = new Map<number, number>();
      for (const r of rs) if (r >= 0) counts.set(r, (counts.get(r) ?? 0) + 1);
      let biggest = -1;
      for (const c of entryCells(at, g)) {
        const r = rs[c] as number;
        if (r >= 0 && (counts.get(r) ?? 0) > (counts.get(biggest) ?? 0)) biggest = r;
      }
      let n = 0;
      for (let c = 0; c < rs.length; c++) if (rs[c] === biggest && reachable[c] === 1) n++;
      return n;
    };
    const placedAt = (o: Scene["objects"][number], cand: Pt) => ({
      ...o,
      transform: {
        ...o.transform,
        position: [cand[0], o.transform.position[1], cand[1]] as [number, number, number],
      },
    });
    for (const original of [...current.objects].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const o = current.objects.find((x) => x.id === original.id) ?? original;
      const at: Pt = [o.transform.position[0], o.transform.position[2]];
      if (!inTheWay(o) || !onTheWay(o, at)) continue;
      const within = (o.spaceId ? polygons.get(o.spaceId) : undefined) ?? level.footprint;
      const before = floorReached(current);
      const found: {
        best: { placed: Scene["objects"][number]; floor: number } | null;
        clearOfTheWay: Scene["objects"][number] | null;
      } = { best: null, clearOfTheWay: null };
      const tryAt = (shape: Scene["objects"][number], cand: Pt) => {
        const pts = corners(shape, cand);
        if (!insideAll(pts, within) || passages.some((p) => blocks(pts, p))) return;
        const placed = placedAt(shape, cand);
        const objects = current.objects.map((x) => (x.id === o.id ? placed : x));
        const floor = floorReached({ ...current, objects });
        if (floor > (found.best?.floor ?? before)) found.best = { placed, floor };
        if (!found.clearOfTheWay && !onTheWay(shape, cand) && floor >= before) {
          found.clearOfTheWay = placed;
        }
      };
      // Slid first, then turned, as anyone would: in a narrow space, a bench end-on to a door
      // can't be slid anywhere that helps, and turning it along the wall frees the way.
      const turned = {
        ...o,
        transform: { ...o.transform, yawDeg: (o.transform.yawDeg + 90) % 360 },
      };
      for (const shape of [o, turned]) {
        if (shape === turned) tryAt(shape, at);
        for (const d of SLIDES_MM) {
          for (const [ux, uz] of DIRECTIONS) {
            const len = Math.sqrt(ux * ux + uz * uz);
            tryAt(shape, [Math.round(at[0] + (ux * d) / len), Math.round(at[1] + (uz * d) / len)]);
          }
        }
      }
      // What opens the most floor; failing that (several things close it only together), out
      // of the way, so long as that shuts nothing else.
      const placed = found.best?.placed ?? found.clearOfTheWay;
      if (!placed) continue;
      changed = true;
      moved.add(o.id);
      current = {
        ...current,
        objects: current.objects.map((x) => (x.id === o.id ? placed : x)),
      };
    }
    if (!changed) break;
  }
  return { scene: current, moved: [...moved].sort() };
}

/** The things with something to do that none of a world's people can get to, by object id. */
function outOfReach(scene: Scene, spec: WorldSpec, settings: WorldSettings): string[] {
  if (spec.people.length === 0) return [];
  const probe = new Sim({ scene, spec, settings, people: spec.people });
  probe.step([]);
  const kindOf = new Map(spec.things.map((t) => [t.object as string, t.kind]));
  const acts = new Set(spec.kinds.filter((k) => k.actions.length > 0).map((k) => k.key));
  return probe.things.flatMap((t, ti) => {
    if (!acts.has(kindOf.get(t.id) ?? "")) return [];
    for (let i = 0; i < probe.agentIds.length; i++) {
      if (probe.present[i] && probe.canReach(i, ti)) return [];
    }
    return [t.id as string];
  });
}

/**
 * A thing nobody can get to is moved the smallest distance that lets them: a television in a
 * corner the furniture closed off, a stool whose every side is against something. It stays in
 * its own space, clear of the ways through and of anything solid, and a move only counts if
 * fewer things are out of reach afterwards. Anything it can't help is left for the play-test.
 */
export function bringWithinReach(
  scene: Scene,
  spec: WorldSpec,
  settings: WorldSettings,
): { scene: Scene; moved: string[] } {
  const level = scene.levels[0];
  if (!level) return { scene, moved: [] };
  const solid = solidity(spec);
  const polygons = new Map(scene.spaces.map((s) => [s.id as string, s.polygon]));
  const passages = passagesOf(scene);
  const moved: string[] = [];
  let current = scene;
  let missing = outOfReach(current, spec, settings);
  for (const id of [...missing].sort()) {
    const o = current.objects.find((x) => x.id === id);
    if (!o || !missing.includes(id)) continue;
    const at: Pt = [o.transform.position[0], o.transform.position[2]];
    const within = (o.spaceId ? polygons.get(o.spaceId) : undefined) ?? level.footprint;
    const others = current.objects.filter((x) => x.id !== id && solid(x));
    const attempt = (shape: Scene["objects"][number], cand: Pt) => {
      const pts = corners(shape, cand);
      if (!insideAll(pts, within) || passages.some((p) => blocks(pts, p))) return null;
      const position = (x: Scene["objects"][number]): Pt => [
        x.transform.position[0],
        x.transform.position[2],
      ];
      if (solid(shape) && others.some((x) => overlaps(pts, corners(x, position(x))))) return null;
      const placed = {
        ...shape,
        transform: {
          ...shape.transform,
          position: [cand[0], shape.transform.position[1], cand[1]] as [number, number, number],
        },
      };
      const next = {
        ...current,
        objects: current.objects.map((x) => (x.id === id ? placed : x)),
      };
      const after = outOfReach(next, spec, settings);
      return after.length < missing.length ? { next, after } : null;
    };
    const turned = {
      ...o,
      transform: { ...o.transform, yawDeg: (o.transform.yawDeg + 90) % 360 },
    };
    let done: { next: Scene; after: string[] } | null = attempt(turned, at);
    for (const shape of [o, turned]) {
      for (const d of SLIDES_MM) {
        for (const [ux, uz] of DIRECTIONS) {
          if (done) break;
          const len = Math.sqrt(ux * ux + uz * uz);
          done = attempt(shape, [
            Math.round(at[0] + (ux * d) / len),
            Math.round(at[1] + (uz * d) / len),
          ]);
        }
      }
    }
    if (!done) continue;
    current = done.next;
    missing = done.after;
    moved.push(id);
  }
  return { scene: current, moved };
}

/**
 * The scene with a doorway cut into any space nobody can walk into from a way in: a layout
 * can draw an awning's open front as a wall, sealing the whole room. Each sealed space gets
 * one doorway, in its longest wall with walkable ground on the other side, and is then
 * open to the next. Returns the names of the spaces it opened, so the caller can say so.
 */
export function openSealedSpaces(scene: Scene): { scene: Scene; opened: string[] } {
  const level = scene.levels[0];
  if (!level || scene.portals.length === 0) return { scene, opened: [] };
  let current = scene;
  const opened: string[] = [];
  const tried = new Set<string>();
  const spaces = [...scene.spaces]
    .filter((s) => s.levelId === level.id)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  for (let round = 0; round < spaces.length; round++) {
    const grid = buildNavGrid(current, level.id, { cellMm: PROBE_MM, isSolid: () => false });
    const reached = floodFill(grid, entryCells(current, grid), WALKER);
    const walkable = (x: number, z: number) => {
      const c = cellAt(grid, x, z);
      return c >= 0 && reached[c] === 1;
    };
    // A space is sealed when none of its floor (sampled on a grid) is reachable.
    const sealed = spaces.find((sp) => {
      const xs = sp.polygon.map((p) => p[0]);
      const zs = sp.polygon.map((p) => p[1]);
      const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
      let inside = 0;
      for (let x = x0 + 250; x < x1; x += 500) {
        for (let z = z0 + 250; z < z1; z += 500) {
          if (!insideAll([[x, z]], sp.polygon)) continue;
          inside++;
          if (walkable(x, z)) return false;
        }
      }
      return inside > 0 && !tried.has(sp.id);
    });
    if (!sealed) break;
    // Its walls with reachable floor just beyond them, longest first.
    let best: { wall: Scene["walls"][number]; at: [number, number]; len: number } | null = null;
    for (const w of [...current.walls].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (w.levelId !== level.id) continue;
      const dx = w.b[0] - w.a[0];
      const dz = w.b[1] - w.a[1];
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 1000) continue;
      const nx = -dz / len;
      const nz = dx / len;
      const off = w.thicknessMm / 2 + 450;
      for (const t of [0.5, 0.3, 0.7]) {
        const mx = w.a[0] + dx * t;
        const mz = w.a[1] + dz * t;
        const a: [number, number] = [mx + nx * off, mz + nz * off];
        const b: [number, number] = [mx - nx * off, mz - nz * off];
        const ok =
          (insideAll([a], sealed.polygon) && walkable(b[0], b[1])) ||
          (insideAll([b], sealed.polygon) && walkable(a[0], a[1]));
        if (ok) {
          if (!best || len > best.len)
            best = { wall: w, at: [Math.round(mx), Math.round(mz)], len };
          break;
        }
      }
    }
    tried.add(sealed.id);
    if (!best) continue;
    opened.push(sealed.name);
    const { wall, at, len } = best;
    const outside = current.spaces.find(
      (s) => s.id !== sealed.id && insideAll([[at[0] + 1, at[1] + 1]], s.polygon),
    );
    current = {
      ...current,
      openings: [
        ...current.openings,
        Opening.parse({
          // One wall can be the way into more than one space.
          id: deriveId("opening", [wall.id, "opened", sealed.id]),
          levelId: level.id,
          kind: "doorway",
          wallId: wall.id,
          at,
          // Navigation cuts it along its wall; this is for anything drawing it.
          yawDeg:
            (Math.round(
              (Math.atan2(wall.b[1] - wall.a[1], wall.b[0] - wall.a[0]) * 180) / Math.PI,
            ) +
              360) %
            360,
          clearWidthMm: Math.min(1200, Math.floor(len) - 300),
          heightMm: 2100,
          sillMm: 0,
          thresholdMm: 0,
          connects: [sealed.id, outside?.id ?? null],
        }),
      ].sort((a, b) => (a.id < b.id ? -1 : 1)),
    };
  }
  return { scene: current, opened };
}

/** Do two footprints (corner lists) overlap? Separating axes of both boxes. */
function overlaps(a: readonly Pt[], b: readonly Pt[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i] as Pt;
      const q = poly[(i + 1) % poly.length] as Pt;
      const ax = -(q[1] - p[1]);
      const az = q[0] - p[0];
      const span = (pts: readonly Pt[]) => {
        let lo = Infinity;
        let hi = -Infinity;
        for (const [x, z] of pts) {
          const v = x * ax + z * az;
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
        return [lo, hi] as const;
      };
      const [a0, a1] = span(a);
      const [b0, b1] = span(b);
      if (a1 <= b0 || b1 <= a0) return false;
    }
  }
  return true;
}

/** Which spaces people can walk into from a way in (sampled floor points). */
function reachableSpaces(scene: Scene): Set<string> {
  const level = scene.levels[0];
  const out = new Set<string>();
  if (!level) return out;
  const grid = buildNavGrid(scene, level.id, { cellMm: PROBE_MM });
  const reached = floodFill(grid, entryCells(scene, grid), WALKER);
  for (const sp of scene.spaces) {
    const xs = sp.polygon.map((p) => p[0]);
    const zs = sp.polygon.map((p) => p[1]);
    for (let x = Math.min(...xs) + 250; x < Math.max(...xs) && !out.has(sp.id); x += 500) {
      for (let z = Math.min(...zs) + 250; z < Math.max(...zs); z += 500) {
        const c = cellAt(grid, x, z);
        if (c >= 0 && reached[c] === 1 && insideAll([[x, z]], sp.polygon)) {
          out.add(sp.id);
          break;
        }
      }
    }
  }
  return out;
}

/**
 * The scene with every object that stands outside all of its spaces (a layout can put a
 * parked motorbike in solid ground between two yards) brought inside: to the nearest spot in
 * its own space, else in any space, where it fits without overlapping anything, stays out of
 * every doorway's approach, and leaves every space people could walk into still reachable.
 * Objects already inside are untouched. Returns the labels it moved.
 */
export function bringInside(scene: Scene): { scene: Scene; moved: string[] } {
  const passages = passagesOf(scene);
  const inSome = (pts: readonly Pt[]) => scene.spaces.some((s) => insideAll(pts, s.polygon));
  const stray = scene.objects.filter(
    (o) => !inSome([[o.transform.position[0], o.transform.position[2]]]),
  );
  if (stray.length === 0) return { scene, moved: [] };
  let current = scene;
  const moved: string[] = [];
  const reachBefore = reachableSpaces(scene);
  for (const o of stray) {
    const at: Pt = [o.transform.position[0], o.transform.position[2]];
    const own = scene.spaces.find((s) => s.id === o.spaceId);
    const others = scene.spaces.filter((s) => s.id !== o.spaceId);
    const candidates: { spaceId: string; at: Pt; d: number; own: boolean }[] = [];
    for (const sp of [...(own ? [own] : []), ...others]) {
      const xs = sp.polygon.map((p) => p[0]);
      const zs = sp.polygon.map((p) => p[1]);
      for (let x = Math.min(...xs); x <= Math.max(...xs); x += 250) {
        for (let z = Math.min(...zs); z <= Math.max(...zs); z += 250) {
          const d = Math.sqrt((x - at[0]) ** 2 + (z - at[1]) ** 2);
          candidates.push({ spaceId: sp.id, at: [x, z], d, own: sp === own });
        }
      }
    }
    // Its own space first, then nearest first; ties broken by position (deterministic).
    candidates.sort(
      (a, b) =>
        Number(b.own) - Number(a.own) || a.d - b.d || a.at[0] - b.at[0] || a.at[1] - b.at[1],
    );
    const others2 = current.objects.filter((x) => x.id !== o.id);
    let tries = 0;
    for (const c of candidates) {
      const space = current.spaces.find((s) => s.id === c.spaceId);
      if (!space) continue;
      const pts = corners(o, c.at);
      if (!insideAll(pts, space.polygon)) continue;
      if (passages.some((p) => blocks(pts, p))) continue;
      if (
        others2.some((x) =>
          overlaps(pts, corners(x, [x.transform.position[0], x.transform.position[2]])),
        )
      ) {
        continue;
      }
      if (++tries > 40) break;
      const next: Scene = {
        ...current,
        objects: current.objects.map((x) =>
          x.id === o.id
            ? {
                ...x,
                spaceId: space.id,
                transform: {
                  ...x.transform,
                  position: [c.at[0], x.transform.position[1], c.at[1]] as [number, number, number],
                },
              }
            : x,
        ),
      };
      const reachNow = reachableSpaces(next);
      if (![...reachBefore].every((s) => reachNow.has(s))) continue;
      current = next;
      moved.push(o.label);
      break;
    }
  }
  return { scene: current, moved };
}
