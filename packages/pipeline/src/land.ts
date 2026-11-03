/**
 * What covers a real city's ground, from OpenStreetMap: water (the sea from its
 * coastline, lagoons, rivers) and land use (built-up, industry, green), as a `LandCover` on
 * the road network's metre frame.
 *
 * The answer is untrusted input: validated with a bounded schema, tags read defensively,
 * nothing in it interpreted beyond numbers. Conversion is pure and deterministic (elements in
 * id order), so the same answer always gives the same cover.
 *
 * The sea has no polygon in OpenStreetMap, only coastlines (land on their left, water on
 * their right): coastline pieces crossing the map are joined, and each is closed along the
 * map's edge, going clockwise from where it leaves to where the next one enters, which keeps
 * the water inside. Multipolygons (a lagoon with its islands) keep their holes.
 */
import { LAND_BOUNDS, LAND_COVER_FORMAT, LAND_KINDS, LandCover, type LandKind } from "@aye/schema";
import { z } from "zod";
import type { GeoBox } from "./osm.ts";

const NATURAL: Record<string, LandKind> = {
  water: "water",
  wood: "green",
  scrub: "green",
  grassland: "green",
  wetland: "green",
  heath: "green",
};
const LANDUSE: Record<string, LandKind> = {
  residential: "built",
  commercial: "built",
  retail: "built",
  construction: "built",
  industrial: "industrial",
  port: "industrial",
  forest: "green",
  grass: "green",
  meadow: "green",
  recreation_ground: "green",
  cemetery: "green",
  farmland: "green",
  orchard: "green",
  village_green: "green",
  reservoir: "water",
  basin: "water",
};
const LEISURE: Record<string, LandKind> = {
  park: "green",
  golf_course: "green",
  nature_reserve: "green",
  garden: "green",
};

/** Smallest area kept, square metres: what shows at a city's scale (a 100 m × 100 m block). */
const MIN_AREA_M2: Record<LandKind, number> = {
  built: 10_000,
  industrial: 10_000,
  green: 10_000,
  water: 2_500,
};
/** Points closer to a ring's line than this are dropped, metres. */
const SIMPLIFY_M = 10;

const alt = (r: Record<string, unknown>) => Object.keys(r).join("|");

/** The Overpass QL for what covers a box's ground, with every way's geometry inline. */
export function landQuery(box: GeoBox): string {
  const b = [box.south, box.west, box.north, box.east].map((v) => v.toFixed(5)).join(",");
  const natural = `["natural"~"^(${alt(NATURAL)})$"]`;
  const landuse = `["landuse"~"^(${alt(LANDUSE)})$"]`;
  const leisure = `["leisure"~"^(${alt(LEISURE)})$"]`;
  const parts = [
    `way["natural"="coastline"](${b});`,
    `way${natural}(${b});`,
    `relation${natural}(${b});`,
    `way["waterway"="riverbank"](${b});`,
    `relation["waterway"="riverbank"](${b});`,
    `way${landuse}(${b});`,
    `relation${landuse}(${b});`,
    `way${leisure}(${b});`,
    `relation${leisure}(${b});`,
  ];
  return `[out:json][timeout:180];(${parts.join("")});out geom qt;`;
}

const Id = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const LatLon = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });
const Geometry = z.array(LatLon.nullable()).max(200_000);
const Tags = z.record(z.string().max(64), z.string().max(255)).optional();
export const LandAnswer = z.object({
  elements: z
    .array(
      z.union([
        z.object({ type: z.literal("way"), id: Id, tags: Tags, geometry: Geometry.optional() }),
        z.object({
          type: z.literal("relation"),
          id: Id,
          tags: Tags,
          members: z
            .array(
              z.object({
                type: z.string().max(16),
                role: z.string().max(32).optional(),
                geometry: Geometry.optional(),
              }),
            )
            .max(50_000),
        }),
      ]),
    )
    .max(2_000_000),
});
export type LandAnswer = z.infer<typeof LandAnswer>;

function kindOf(tags: Record<string, string> | undefined): LandKind | null {
  if (!tags) return null;
  return (
    NATURAL[tags["natural"] ?? ""] ??
    (tags["waterway"] === "riverbank" ? "water" : undefined) ??
    LANDUSE[tags["landuse"] ?? ""] ??
    LEISURE[tags["leisure"] ?? ""] ??
    null
  );
}

type P = [number, number];
type Ll = { lat: number; lon: number };
const key = (p: Ll) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
const points = (g: (Ll | null)[] | undefined): Ll[] => (g ?? []).filter((p): p is Ll => p !== null);

/** Join lines that share ends into closed rings (either way round); unclosable ones go. */
function joinRings(lines: Ll[][]): Ll[][] {
  const pool = lines.filter((l) => l.length >= 2);
  const used = new Uint8Array(pool.length);
  const byEnd = new Map<string, number[]>();
  pool.forEach((l, i) => {
    for (const end of [l[0] as Ll, l[l.length - 1] as Ll]) {
      const k = key(end);
      byEnd.set(k, [...(byEnd.get(k) ?? []), i]);
    }
  });
  const rings: Ll[][] = [];
  for (let i = 0; i < pool.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const ring = [...(pool[i] as Ll[])];
    for (let guard = 0; guard < pool.length; guard++) {
      if (key(ring[0] as Ll) === key(ring[ring.length - 1] as Ll)) break;
      const end = key(ring[ring.length - 1] as Ll);
      const next = (byEnd.get(end) ?? []).find((j) => !used[j]);
      if (next === undefined) break;
      used[next] = 1;
      const l = pool[next] as Ll[];
      const forward = key(l[0] as Ll) === end;
      ring.push(...(forward ? l : [...l].reverse()).slice(1));
    }
    if (ring.length >= 4 && key(ring[0] as Ll) === key(ring[ring.length - 1] as Ll)) {
      rings.push(ring);
    }
  }
  return rings;
}

/** Join coastline ways end to start into chains (they all run with the water on the right). */
function joinChains(lines: Ll[][]): Ll[][] {
  const pool = lines.filter((l) => l.length >= 2);
  const used = new Uint8Array(pool.length);
  const byStart = new Map<string, number>();
  const byEnd = new Map<string, number>();
  pool.forEach((l, i) => {
    byStart.set(key(l[0] as Ll), i);
    byEnd.set(key(l[l.length - 1] as Ll), i);
  });
  const chains: Ll[][] = [];
  for (let i = 0; i < pool.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const chain = [...(pool[i] as Ll[])];
    for (let guard = 0; guard < pool.length; guard++) {
      const j = byStart.get(key(chain[chain.length - 1] as Ll));
      if (j === undefined || used[j]) break;
      used[j] = 1;
      chain.push(...(pool[j] as Ll[]).slice(1));
    }
    for (let guard = 0; guard < pool.length; guard++) {
      const j = byEnd.get(key(chain[0] as Ll));
      if (j === undefined || used[j]) break;
      used[j] = 1;
      chain.unshift(...(pool[j] as Ll[]).slice(0, -1));
    }
    chains.push(chain);
  }
  return chains;
}

/** A ring cut to the map's rectangle (Sutherland–Hodgman; the rectangle is convex). */
export function clipRing(ring: P[], w: number, h: number): P[] {
  const edges: [(p: P) => boolean, (a: P, b: P) => P][] = [
    [(p) => p[0] >= 0, (a, b) => at(a, b, (0 - a[0]) / (b[0] - a[0]))],
    [(p) => p[0] <= w, (a, b) => at(a, b, (w - a[0]) / (b[0] - a[0]))],
    [(p) => p[1] >= 0, (a, b) => at(a, b, (0 - a[1]) / (b[1] - a[1]))],
    [(p) => p[1] <= h, (a, b) => at(a, b, (h - a[1]) / (b[1] - a[1]))],
  ];
  let out = ring;
  for (const [keep, cross] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[(i + input.length - 1) % input.length] as P;
      const b = input[i] as P;
      if (keep(b)) {
        if (!keep(a)) out.push(cross(a, b));
        out.push(b);
      } else if (keep(a)) out.push(cross(a, b));
    }
    if (out.length === 0) break;
  }
  return out;
}
const at = (a: P, b: P, t: number): P => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Shoelace area, square metres (positive whichever way round). */
export function areaOf(ring: P[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as P;
    const b = ring[(i + 1) % ring.length] as P;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

/** Douglas–Peucker over a closed ring (its first point kept). */
function simplifyRing(ring: P[], tol: number): P[] {
  if (ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  // Split at the point farthest from the first, so a closed ring has a real baseline.
  const [x0, z0] = ring[0] as P;
  let far = 1;
  ring.forEach(([x, z], k) => {
    const [fx, fz] = ring[far] as P;
    if ((x - x0) ** 2 + (z - z0) ** 2 > (fx - x0) ** 2 + (fz - z0) ** 2) far = k;
  });
  keep[far] = 1;
  const stack: [number, number][] = [
    [0, far],
    [far, ring.length - 1],
  ];
  while (stack.length > 0) {
    const [i, j] = stack.pop() as [number, number];
    const [ax, az] = ring[i] as P;
    const [bx, bz] = ring[j] as P;
    const len = Math.hypot(bx - ax, bz - az) || 1;
    let worst = -1;
    let k0 = -1;
    for (let k = i + 1; k < j; k++) {
      const [px, pz] = ring[k] as P;
      const d = Math.abs((bx - ax) * (az - pz) - (ax - px) * (bz - az)) / len;
      if (d > worst) {
        worst = d;
        k0 = k;
      }
    }
    if (worst > tol && k0 > 0) {
      keep[k0] = 1;
      stack.push([i, k0], [k0, j]);
    }
  }
  return ring.filter((_, k) => keep[k]);
}

/** Where a point on the map's edge is, metres along it clockwise from the north-west corner. */
function perimeter([x, z]: P, w: number, h: number): number {
  const d = [z, w - x, h - z, x]; // distance to the north, east, south and west edges
  const edge = d.indexOf(Math.min(...d));
  if (edge === 0) return x;
  if (edge === 1) return w + z;
  if (edge === 2) return w + h + (w - x);
  return 2 * w + h + (h - z);
}

/** Coastline pieces inside the map: each enters and leaves through its edge. */
function coastPieces(chain: P[], w: number, h: number): P[][] {
  const inBox = (p: P) => p[0] >= 0 && p[0] <= w && p[1] >= 0 && p[1] <= h;
  const pieces: P[][] = [];
  let cur: P[] | null = null;
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1] as P;
    const b = chain[i] as P;
    const seg = clipSegment(a, b, w, h);
    if (!seg) continue;
    const [p, q] = seg;
    if (!inBox(a) || !cur) {
      // Entering through the edge (a piece starting inside is incomplete data: dropped).
      cur = inBox(a) ? null : [p];
      if (!cur) continue;
    }
    cur.push(q);
    if (!inBox(b)) {
      pieces.push(cur);
      cur = null;
    }
  }
  return pieces.filter((p) => p.length >= 2);
}

/** A segment cut to the map's rectangle (Liang–Barsky), or null if it misses it. */
function clipSegment(a: P, b: P, w: number, h: number): [P, P] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const tests: [number, number][] = [
    [-dx, a[0]],
    [dx, w - a[0]],
    [-dz, a[1]],
    [dz, h - a[1]],
  ];
  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return null;
  }
  return [at(a, b, t0), at(a, b, t1)];
}

/** The sea: coastline pieces closed clockwise along the map's edge (water on their right). */
export function seaRings(pieces: P[][], w: number, h: number): P[][] {
  const total = 2 * (w + h);
  const ins = pieces.map((p) => perimeter(p[0] as P, w, h));
  const outs = pieces.map((p) => perimeter(p[p.length - 1] as P, w, h));
  const corners: [number, P][] = [
    [w, [w, 0]],
    [w + h, [w, h]],
    [2 * w + h, [0, h]],
    [0, [0, 0]],
  ];
  const used = new Uint8Array(pieces.length);
  const rings: P[][] = [];
  for (let s = 0; s < pieces.length; s++) {
    if (used[s]) continue;
    const ring: P[] = [];
    let cur = s;
    for (let guard = 0; guard <= pieces.length; guard++) {
      used[cur] = 1;
      ring.push(...(pieces[cur] as P[]));
      const from = outs[cur] as number;
      // The next piece clockwise from where this one leaves.
      let next = -1;
      let gap = Number.POSITIVE_INFINITY;
      pieces.forEach((_, j) => {
        if (used[j] && j !== s) return;
        const d = ((ins[j] as number) - from + total) % total;
        if (d < gap) {
          gap = d;
          next = j;
        }
      });
      if (next < 0) break;
      for (const [c, pt] of corners
        .map(([c, pt]) => [(c - from + total) % total, pt] as [number, P])
        .filter(([d]) => d > 0 && d < gap)
        .sort((x, y) => x[0] - y[0])) {
        void c;
        ring.push(pt);
      }
      if (next === s) break;
      cur = next;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

function inside(x: number, z: number, poly: P[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i] as P;
    const [xj, zj] = poly[j] as P;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/** Turn an Overpass answer for `box` into a land cover on the map frame `extentM`. */
export function buildLand(
  answer: LandAnswer,
  box: GeoBox,
  extentM: readonly [number, number],
): LandCover {
  const [w, h] = extentM;
  const lat0 = ((box.north + box.south) / 2) * (Math.PI / 180);
  const mx = 111_320 * Math.cos(lat0);
  const project = (p: Ll): P => [(p.lon - box.west) * mx, (box.north - p.lat) * 110_574];

  type Poly = { kind: number; outer: P[]; holes: P[][]; area: number; id: number };
  const polys: Poly[] = [];
  const add = (kind: LandKind, id: number, outer: P[], holes: P[][]) => {
    const tidy = (r: P[]) => simplifyRing(clipRing(r, w, h), SIMPLIFY_M);
    const o = tidy(outer);
    const area = o.length >= 3 ? areaOf(o) : 0;
    if (area < MIN_AREA_M2[kind]) return;
    const hs = holes.map(tidy).filter((r) => r.length >= 3 && areaOf(r) >= MIN_AREA_M2[kind]);
    polys.push({ kind: LAND_KINDS.indexOf(kind), outer: o, holes: hs, area, id });
  };

  const elements = [...answer.elements].sort((a, b) =>
    a.type === b.type ? a.id - b.id : a.type < b.type ? -1 : 1,
  );
  const coast: Ll[][] = [];
  for (const e of elements) {
    if (e.type === "way") {
      const pts = points(e.geometry);
      if (e.tags?.["natural"] === "coastline") {
        coast.push(pts);
        continue;
      }
      const kind = kindOf(e.tags);
      if (!kind || pts.length < 4) continue;
      if (key(pts[0] as Ll) !== key(pts[pts.length - 1] as Ll)) continue;
      add(kind, e.id, pts.slice(0, -1).map(project), []);
    } else {
      const kind = kindOf(e.tags);
      if (!kind) continue;
      const ways = e.members.filter((m) => m.type === "way");
      const outers = joinRings(
        ways.filter((m) => m.role !== "inner").map((m) => points(m.geometry)),
      );
      const inners = joinRings(
        ways.filter((m) => m.role === "inner").map((m) => points(m.geometry)),
      );
      const outerPts = outers.map((r) => r.slice(0, -1).map(project));
      const innerPts = inners.map((r) => r.slice(0, -1).map(project));
      for (const o of outerPts) {
        const mine = innerPts.filter((r) => inside((r[0] as P)[0], (r[0] as P)[1], o));
        add(kind, e.id, o, mine);
      }
    }
  }
  for (const chain of joinChains(coast)) {
    const pts = chain.map(project);
    if (key(chain[0] as Ll) === key(chain[chain.length - 1] as Ll)) continue; // an island
    for (const ring of seaRings(coastPieces(pts, w, h), w, h)) add("water", 0, ring, []);
  }

  // Drawing order: by kind; the biggest first within a kind, so if the budget runs out it
  // is the smallest that go. Ties by id: deterministic.
  polys.sort((a, b) => a.kind - b.kind || b.area - a.area || a.id - b.id);
  const kinds: number[] = [];
  const holes: number[] = [];
  const ringAt: number[] = [];
  const flat: number[] = [];
  const push = (ring: P[], kind: number, hole: 0 | 1) => {
    kinds.push(kind);
    holes.push(hole);
    ringAt.push(flat.length / 2);
    for (const [x, z] of ring) {
      flat.push(Math.max(0, Math.min(w, Math.round(x))), Math.max(0, Math.min(h, Math.round(z))));
    }
  };
  for (const p of polys) {
    const size = p.outer.length + p.holes.reduce((s, r) => s + r.length, 0);
    if (flat.length / 2 + size > LAND_BOUNDS.points) continue;
    if (kinds.length + 1 + p.holes.length > LAND_BOUNDS.rings) continue;
    push(p.outer, p.kind, 0);
    for (const hole of p.holes) push(hole, p.kind, 1);
  }
  ringAt.push(flat.length / 2);
  return LandCover.parse({
    format: LAND_COVER_FORMAT,
    version: 1,
    source: "openstreetmap",
    attribution: "© OpenStreetMap contributors (ODbL)",
    origin: { lat: box.north, lon: box.west },
    extentM: [w, h],
    kinds,
    holes,
    ringAt,
    points: flat,
  });
}
