/**
 * Real roads from OpenStreetMap: an Overpass query for a box of the Earth, and
 * code that turns its answer into a compact `RoadNetwork` on the city map's metre frame.
 *
 * The answer is untrusted input: it is validated with a bounded schema, every tag is read
 * defensively, and nothing in it is ever interpreted beyond numbers and display names.
 * Conversion is pure and deterministic (ways and nodes in id order), so the same answer
 * always gives the same network.
 *
 * What a link is: a stretch of road between junctions (where ways meet or end). Lanes per
 * direction, speed and one-way come from the way's tags (`lanes`, `maxspeed`, `oneway`,
 * roundabouts), or its class's defaults. Only the largest strongly connected part is kept,
 * so every junction on it can reach every other the legal way round.
 */
import {
  LINK_FIELDS,
  NETWORK_BOUNDS,
  ROAD_CLASSES,
  ROAD_NETWORK_FORMAT,
  type RoadClass,
  RoadNetwork,
} from "@aye/schema";
import { z } from "zod";

/** A box of the Earth, degrees. */
export interface GeoBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** The strategic network: the roads city traffic moves on (residential streets aren't). */
const HIGHWAYS: Record<string, RoadClass> = {
  motorway: "motorway",
  motorway_link: "motorway",
  trunk: "trunk",
  trunk_link: "trunk",
  primary: "primary",
  primary_link: "primary",
  secondary: "secondary",
  secondary_link: "secondary",
  tertiary: "tertiary",
  tertiary_link: "tertiary",
};

/** Lanes each way and free speed when a road doesn't say. */
const DEFAULTS: Record<RoadClass, { lanes: number; speedKmh: number }> = {
  motorway: { lanes: 3, speedKmh: 100 },
  trunk: { lanes: 2, speedKmh: 80 },
  primary: { lanes: 2, speedKmh: 60 },
  secondary: { lanes: 1, speedKmh: 50 },
  tertiary: { lanes: 1, speedKmh: 40 },
  local: { lanes: 1, speedKmh: 30 },
  ferry: { lanes: 1, speedKmh: 25 },
  rail: { lanes: 1, speedKmh: 60 },
  // Getting to a stop from the road: on foot or by motorbike, a little faster than walking.
  access: { lanes: 1, speedKmh: 12 },
};

/** The Overpass QL for a box: ways with their tags, then their nodes' positions. */
export function overpassQuery(box: GeoBox): string {
  const b = [box.south, box.west, box.north, box.east].map((v) => v.toFixed(5)).join(",");
  const pattern = Object.keys(HIGHWAYS).join("|");
  return `[out:json][timeout:120];way["highway"~"^(${pattern})$"](${b})->.w;.w out body qt;node(w.w);out skel qt;`;
}

const Id = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const OverpassAnswer = z.object({
  elements: z
    .array(
      z.union([
        z.object({
          type: z.literal("way"),
          id: Id,
          nodes: z.array(Id).min(2).max(4000),
          tags: z.record(z.string().max(64), z.string().max(255)).optional(),
        }),
        z.object({
          type: z.literal("node"),
          id: Id,
          lat: z.number().min(-90).max(90),
          lon: z.number().min(-180).max(180),
          tags: z.record(z.string().max(64), z.string().max(255)).optional(),
        }),
      ]),
    )
    .max(3_000_000),
});
export type OverpassAnswer = z.infer<typeof OverpassAnswer>;

/** Metres per degree, near the network's latitude (equirectangular: fine across a city). */
function projector(box: GeoBox) {
  const lat0 = ((box.north + box.south) / 2) * (Math.PI / 180);
  const mx = 111_320 * Math.cos(lat0);
  const mz = 110_574;
  return (lat: number, lon: number): [number, number] => [
    Math.round((lon - box.west) * mx),
    Math.round((box.north - lat) * mz),
  ];
}

function int(text: string | undefined): number | null {
  const m = text ? /^\s*(\d{1,4})/.exec(text) : null;
  return m ? Number(m[1]) : null;
}

/** A way's speed limit in km/h (tags like "50", "30 mph"), or null. */
function speedOf(tag: string | undefined): number | null {
  const n = int(tag);
  if (n === null) return null;
  return /mph/i.test(tag ?? "") ? Math.round(n * 1.609) : n;
}

/** Keep every point that bends the line more than `tol` metres (Douglas–Peucker). */
function simplify(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [i, j] = stack.pop() as [number, number];
    const [ax, az] = pts[i] as [number, number];
    const [bx, bz] = pts[j] as [number, number];
    const len = Math.hypot(bx - ax, bz - az) || 1;
    let far = -1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const [px, pz] = pts[k] as [number, number];
      const d = Math.abs((bx - ax) * (az - pz) - (ax - px) * (bz - az)) / len;
      if (d > far) {
        far = d;
        at = k;
      }
    }
    if (far > tol && at > 0) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

/** Turn an Overpass answer for `box` into a road network, or null if it holds no roads. */
export function buildNetwork(answer: OverpassAnswer, box: GeoBox): RoadNetwork | null {
  const project = projector(box);
  const [extentX, extentZ] = project(box.south, box.east);
  const where = new Map<number, [number, number]>();
  for (const e of answer.elements) {
    if (e.type === "node") where.set(e.id, project(e.lat, e.lon));
  }
  const ways = answer.elements
    .filter((e): e is Extract<typeof e, { type: "way" }> => e.type === "way")
    .filter((w) => HIGHWAYS[w.tags?.["highway"] ?? ""] !== undefined)
    .sort((a, b) => a.id - b.id);
  // Junctions: every way's ends, and every node more than one way (or one way twice) uses.
  const uses = new Map<number, number>();
  for (const w of ways) for (const n of w.nodes) uses.set(n, (uses.get(n) ?? 0) + 1);
  const junction = (n: number, k: number, w: (typeof ways)[number]) =>
    k === 0 || k === w.nodes.length - 1 || (uses.get(n) ?? 0) > 1;

  type Raw = {
    a: number;
    b: number;
    lanes: number;
    speedKmh: number;
    oneway: 0 | 1;
    cls: number;
    name: string;
    shape: [number, number][];
    length: number;
  };
  const raws: Raw[] = [];
  for (const w of ways) {
    const tags = w.tags ?? {};
    const cls = HIGHWAYS[tags["highway"] ?? ""] as RoadClass;
    const d = DEFAULTS[cls];
    const ow = tags["oneway"];
    const roundabout = tags["junction"] === "roundabout";
    const oneway =
      ow === "yes" ||
      ow === "1" ||
      ow === "true" ||
      ow === "-1" ||
      roundabout ||
      cls === "motorway";
    const reverse = ow === "-1";
    const total = int(tags["lanes"]);
    const lanes = Math.max(
      1,
      Math.min(
        NETWORK_BOUNDS.lanes,
        total === null ? d.lanes : oneway ? total : Math.ceil(total / 2),
      ),
    );
    const speedKmh = Math.max(
      NETWORK_BOUNDS.speedKmh.min,
      Math.min(NETWORK_BOUNDS.speedKmh.max, speedOf(tags["maxspeed"]) ?? d.speedKmh),
    );
    const name = (tags["name"] ?? tags["ref"] ?? "").replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 80);
    let start = 0;
    for (let k = 1; k < w.nodes.length; k++) {
      if (!junction(w.nodes[k] as number, k, w)) continue;
      const ids = w.nodes.slice(start, k + 1);
      const pts = ids.map((n) => where.get(n)).filter((p): p is [number, number] => !!p);
      start = k;
      if (pts.length < 2 || ids.length !== pts.length) continue;
      let length = 0;
      for (let i = 1; i < pts.length; i++) {
        length += Math.hypot(
          (pts[i] as [number, number])[0] - (pts[i - 1] as [number, number])[0],
          (pts[i] as [number, number])[1] - (pts[i - 1] as [number, number])[1],
        );
      }
      const [a, b] = reverse
        ? [ids[ids.length - 1] as number, ids[0] as number]
        : [ids[0] as number, ids[ids.length - 1] as number];
      if (a === b || length < 1) continue;
      const shape = simplify(reverse ? [...pts].reverse() : pts, 5).slice(1, -1);
      raws.push({
        a,
        b,
        lanes,
        speedKmh,
        oneway: oneway ? 1 : 0,
        cls: ROAD_CLASSES.indexOf(cls),
        name,
        shape,
        length,
      });
    }
  }
  if (raws.length === 0) return null;

  // Keep the largest strongly connected part: every junction in it can reach every other
  // going the right way down one-way streets, so no trip starts or ends in a pocket it
  // can't leave.
  const biggest = largestStrongPart(raws);
  // The most important roads first, so a city too big to hold whole keeps its arteries.
  const kept = raws
    .filter((r) => biggest.has(r.a) && biggest.has(r.b))
    .sort((x, y) => x.cls - y.cls || x.a - y.a || x.b - y.b)
    .slice(0, NETWORK_BOUNDS.links);

  const nodeIndex = new Map<number, number>();
  const nodes: number[] = [];
  const nodeOf = (id: number) => {
    let i = nodeIndex.get(id);
    if (i === undefined) {
      i = nodes.length / 2;
      nodeIndex.set(id, i);
      const [x, z] = where.get(id) as [number, number];
      nodes.push(Math.max(0, x), Math.max(0, z));
    }
    return i;
  };
  const names: string[] = [];
  const nameIndex = new Map<string, number>();
  const links: number[] = [];
  const shapeAt: number[] = [];
  const shape: number[] = [];
  for (const r of kept) {
    let name = -1;
    if (r.name) {
      const known = nameIndex.get(r.name);
      if (known !== undefined) name = known;
      else if (names.length < NETWORK_BOUNDS.names) {
        name = names.length;
        nameIndex.set(r.name, name);
        names.push(r.name);
      }
    }
    links.push(nodeOf(r.a), nodeOf(r.b), r.lanes, r.speedKmh, r.oneway, r.cls, name);
    shapeAt.push(shape.length / 2);
    if (shape.length / 2 + r.shape.length <= NETWORK_BOUNDS.shapePoints) {
      for (const [x, z] of r.shape) shape.push(Math.max(0, x), Math.max(0, z));
    }
  }
  shapeAt.push(shape.length / 2);
  void LINK_FIELDS;
  return RoadNetwork.parse({
    format: ROAD_NETWORK_FORMAT,
    version: 1,
    source: "openstreetmap",
    attribution: "© OpenStreetMap contributors (ODbL)",
    origin: { lat: box.north, lon: box.west },
    extentM: [
      Math.max(100, Math.min(NETWORK_BOUNDS.extentM, extentX)),
      Math.max(100, Math.min(NETWORK_BOUNDS.extentM, extentZ)),
    ],
    nodes: nodes.map((v) => Math.min(NETWORK_BOUNDS.extentM, v)),
    links,
    shapeAt,
    shape: shape.map((v) => Math.min(NETWORK_BOUNDS.extentM, v)),
    names,
  });
}

/**
 * The junctions of the largest strongly connected part of the roads (Kosaraju, iterative;
 * ties to the part holding the smallest junction id: deterministic).
 */
function largestStrongPart(raws: readonly { a: number; b: number; oneway: 0 | 1 }[]): Set<number> {
  const ids = [...new Set(raws.flatMap((r) => [r.a, r.b]))].sort((x, y) => x - y);
  const index = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const out: number[][] = Array.from({ length: n }, () => []);
  const into: number[][] = Array.from({ length: n }, () => []);
  for (const r of raws) {
    const a = index.get(r.a) as number;
    const b = index.get(r.b) as number;
    out[a]?.push(b);
    into[b]?.push(a);
    if (!r.oneway) {
      out[b]?.push(a);
      into[a]?.push(b);
    }
  }
  // Finish order by a depth-first walk forwards.
  const seen = new Uint8Array(n);
  const order: number[] = [];
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    seen[s] = 1;
    const stack: [number, number][] = [[s, 0]];
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as [number, number];
      const next = out[top[0]]?.[top[1]];
      if (next === undefined) {
        order.push(top[0]);
        stack.pop();
        continue;
      }
      top[1]++;
      if (!seen[next]) {
        seen[next] = 1;
        stack.push([next, 0]);
      }
    }
  }
  // Then parts, walking backwards in reverse finish order.
  const part = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  for (let k = order.length - 1; k >= 0; k--) {
    const s = order[k] as number;
    if (part[s] !== -1) continue;
    const p = sizes.length;
    let size = 0;
    const stack = [s];
    part[s] = p;
    while (stack.length > 0) {
      const v = stack.pop() as number;
      size++;
      for (const u of into[v] ?? []) {
        if (part[u] === -1) {
          part[u] = p;
          stack.push(u);
        }
      }
    }
    sizes.push(size);
  }
  let best = -1;
  let bestSize = -1;
  let bestMin = Number.POSITIVE_INFINITY;
  const minOf = new Array<number>(sizes.length).fill(Number.POSITIVE_INFINITY);
  for (let v = 0; v < n; v++)
    minOf[part[v] as number] = Math.min(minOf[part[v] as number] as number, v);
  sizes.forEach((size, p) => {
    if (size > bestSize || (size === bestSize && (minOf[p] as number) < bestMin)) {
      best = p;
      bestSize = size;
      bestMin = minOf[p] as number;
    }
  });
  const keep = new Set<number>();
  for (let v = 0; v < n; v++) if (part[v] === best) keep.add(ids[v] as number);
  return keep;
}

// ── Lines: ferries and railways ───────────────────────────────────────────────────────────

/** How far a stop may be from the road it is reached from, metres. */
const ACCESS_MAX_M = 2_000;
/** How far a station may stand from its track (stations are often mapped beside it). */
const STATION_SNAP_M = 300;

/** The Overpass QL for a box's ferry routes, passenger railways and their stops. */
export function linesQuery(box: GeoBox): string {
  const b = [box.south, box.west, box.north, box.east].map((v) => v.toFixed(5)).join(",");
  return (
    `[out:json][timeout:180];(` +
    `way["route"="ferry"](${b});` +
    `way["railway"~"^(rail|light_rail|subway)$"]["service"!~"."]["usage"!~"^(freight|industrial|military|tourism)$"](${b});` +
    `node["railway"~"^(station|halt)$"](${b});` +
    `);out body qt;>;out skel qt;`
  );
}

/**
 * A network with its lines added: each ferry route a link between its terminals, each
 * railway split into links between its stations and junctions, and every terminal and
 * station joined by an access link to the nearest road junction (within ACCESS_MAX_M). A
 * line that reaches no road is left out. Pure and deterministic, like `buildNetwork`.
 */
export function addLines(net: RoadNetwork, answer: OverpassAnswer, box: GeoBox): RoadNetwork {
  const project = projector(box);
  const where = new Map<number, [number, number]>();
  const stationTag = new Set<number>();
  for (const e of answer.elements) {
    if (e.type !== "node") continue;
    where.set(e.id, project(e.lat, e.lon));
    const r = e.tags?.["railway"];
    if (r === "station" || r === "halt") stationTag.add(e.id);
  }
  const ways = answer.elements
    .filter((e): e is Extract<typeof e, { type: "way" }> => e.type === "way")
    .sort((a, b) => a.id - b.id);
  const ferries = ways.filter((w) => w.tags?.["route"] === "ferry");
  const rails = ways.filter((w) => w.tags?.["railway"] !== undefined);

  const nodes = [...net.nodes];
  const links = [...net.links];
  const shapeAt = net.shapeAt.slice(0, -1);
  const shape = [...net.shape];
  const roadNodes = net.nodes.length / 2;
  const nearestRoad = ([x, z]: [number, number]): number | null => {
    let best: number | null = null;
    let bestD = ACCESS_MAX_M * ACCESS_MAX_M;
    for (let v = 0; v < roadNodes; v++) {
      const d =
        ((net.nodes[v * 2] as number) - x) ** 2 + ((net.nodes[v * 2 + 1] as number) - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  };
  const added = new Map<number, number>();
  const nodeOf = (id: number): number => {
    let i = added.get(id);
    if (i === undefined) {
      i = nodes.length / 2;
      added.set(id, i);
      const [x, z] = where.get(id) as [number, number];
      nodes.push(clampTo(x, net.extentM[0]), clampTo(z, net.extentM[1]));
    }
    return i;
  };
  const cls = (c: RoadClass) => ROAD_CLASSES.indexOf(c);
  const pushLink = (
    a: number,
    b: number,
    c: RoadClass,
    speedKmh: number,
    pts: [number, number][],
  ) => {
    if (links.length / LINK_FIELDS >= NETWORK_BOUNDS.links) return;
    links.push(a, b, 1, speedKmh, 0, cls(c), -1);
    shapeAt.push(shape.length / 2);
    if (shape.length / 2 + pts.length <= NETWORK_BOUNDS.shapePoints) {
      for (const [x, z] of pts) shape.push(clampTo(x, net.extentM[0]), clampTo(z, net.extentM[1]));
    }
  };
  const access = (stop: number, id: number) => {
    const road = nearestRoad(where.get(id) as [number, number]);
    if (road === null) return false;
    pushLink(road, stop, "access", DEFAULTS.access.speedKmh, []);
    return true;
  };
  const speed = (tags: Record<string, string> | undefined, c: RoadClass) =>
    Math.max(
      NETWORK_BOUNDS.speedKmh.min,
      Math.min(NETWORK_BOUNDS.speedKmh.max, speedOf(tags?.["maxspeed"]) ?? DEFAULTS[c].speedKmh),
    );
  const ptsOf = (ids: number[]) =>
    ids.map((n) => where.get(n)).filter((p): p is [number, number] => p !== undefined);

  // Ferries: terminal to terminal, both reached from the road, or not at all.
  const accessed = new Set<number>();
  for (const w of ferries) {
    const a = w.nodes[0] as number;
    const b = w.nodes[w.nodes.length - 1] as number;
    const pts = ptsOf(w.nodes);
    if (a === b || pts.length !== w.nodes.length) continue;
    const ends = [a, b].map((id) => where.get(id) as [number, number]);
    if (ends.some((p) => nearestRoad(p) === null)) continue;
    const ia = nodeOf(a);
    const ib = nodeOf(b);
    for (const [id, i] of [
      [a, ia],
      [b, ib],
    ] as const) {
      if (!accessed.has(id) && access(i, id)) accessed.add(id);
    }
    pushLink(ia, ib, "ferry", speed(w.tags, "ferry"), simplify(pts, 10).slice(1, -1));
  }

  // Railways: stops are stations on the track, or snapped onto it.
  const onTrack = new Set<number>();
  const uses = new Map<number, number>();
  for (const w of rails) {
    for (const n of w.nodes) {
      onTrack.add(n);
      uses.set(n, (uses.get(n) ?? 0) + 1);
    }
  }
  const stops = new Set<number>();
  const trackIds = [...onTrack].filter((n) => where.has(n)).sort((x, y) => x - y);
  for (const st of [...stationTag].sort((x, y) => x - y)) {
    if (onTrack.has(st)) {
      stops.add(st);
      continue;
    }
    const [sx, sz] = where.get(st) as [number, number];
    let best = -1;
    let bestD = STATION_SNAP_M * STATION_SNAP_M;
    for (const n of trackIds) {
      const [x, z] = where.get(n) as [number, number];
      const d = (x - sx) ** 2 + (z - sz) ** 2;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    if (best >= 0) stops.add(best);
  }
  type Piece = { a: number; b: number; pts: [number, number][]; speedKmh: number };
  const pieces: Piece[] = [];
  for (const w of rails) {
    let start = 0;
    for (let k = 1; k < w.nodes.length; k++) {
      const n = w.nodes[k] as number;
      if (!(k === w.nodes.length - 1 || stops.has(n) || (uses.get(n) ?? 0) > 1)) continue;
      const ids = w.nodes.slice(start, k + 1);
      start = k;
      const pts = ptsOf(ids);
      if (pts.length !== ids.length || ids[0] === n) continue;
      pieces.push({ a: ids[0] as number, b: n, pts, speedKmh: speed(w.tags, "rail") });
    }
  }
  // Only track that reaches a stop someone can get to from the road.
  const reached = new Set<number>();
  const queue = [...stops]
    .sort((x, y) => x - y)
    .filter((s) => nearestRoad(where.get(s) as [number, number]) !== null);
  for (const s of queue) reached.add(s);
  for (let q = 0; q < queue.length; q++) {
    const v = queue[q] as number;
    for (const p of pieces) {
      const u = p.a === v ? p.b : p.b === v ? p.a : -1;
      if (u >= 0 && !reached.has(u)) {
        reached.add(u);
        queue.push(u);
      }
    }
  }
  for (const s of [...stops].sort((x, y) => x - y)) {
    if (reached.has(s)) access(nodeOf(s), s);
  }
  for (const p of pieces) {
    if (!reached.has(p.a)) continue;
    pushLink(nodeOf(p.a), nodeOf(p.b), "rail", p.speedKmh, simplify(p.pts, 10).slice(1, -1));
  }
  shapeAt.push(shape.length / 2);
  return RoadNetwork.parse({ ...net, nodes, links, shapeAt, shape });
}

const clampTo = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));

/** Project a point onto a network's frame (metres from its north-west corner). */
export function projectOnto(
  network: Pick<RoadNetwork, "origin" | "extentM">,
  lat: number,
  lon: number,
): [number, number] {
  const south = network.origin.lat - network.extentM[1] / 110_574;
  const box: GeoBox = {
    north: network.origin.lat,
    west: network.origin.lon,
    south,
    east: network.origin.lon,
  };
  const [x, z] = projector(box)(lat, lon);
  return [
    Math.max(0, Math.min(network.extentM[0], x)),
    Math.max(0, Math.min(network.extentM[1], z)),
  ];
}
