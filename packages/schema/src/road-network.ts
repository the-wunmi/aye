/**
 * A real road network (OpenStreetMap, ODbL): what a city's life plays on when the city is a
 * real place, instead of the handful of roads a model sketches. Kept apart from the city
 * spec (it can be megabytes) as its own content-addressed artifact the city points to.
 *
 * Compact on purpose: nodes as metre pairs, links as rows of integers (a 30 km city has tens
 * of thousands). Coordinates are metres east and south of the network's north-west corner,
 * the same frame as the city map. Every array is bounded; names are display text only.
 *
 * Licence: data © OpenStreetMap contributors, available under the Open Database Licence;
 * a network derived from it is under the ODbL too, and must be shown with `attribution`.
 */
import { z } from "zod";

export const ROAD_NETWORK_FORMAT = "aye.roads";

export const NETWORK_BOUNDS = {
  /** Metres across the largest real map. */
  extentM: 80_000,
  nodes: 200_000,
  links: 250_000,
  names: 20_000,
  /** Shape points per link (curves), beyond its two ends. */
  shapePoints: 400_000,
  lanes: 8,
  speedKmh: { min: 5, max: 130 },
} as const;

/**
 * Link classes: roads, most important first (they set default lanes, speed and drawing),
 * then what isn't a road: lines (ferry routes, railways) and the access walks that join a
 * line's stops to the roads. Nothing drives on a line or an access link.
 */
export const ROAD_CLASSES = [
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "local",
  "ferry",
  "rail",
  "access",
] as const;
export type RoadClass = (typeof ROAD_CLASSES)[number];
/** Classes up to and including this index are roads. */
export const LAST_ROAD_CLASS = ROAD_CLASSES.indexOf("local");

/** Which network a way to get around travels on (absent: the roads). */
export const WAYS = ["road", "water", "rail"] as const;
export type Way = (typeof WAYS)[number];

/** One link: a stretch of road between two junctions. */
export const LINK_FIELDS = 7;
// [a, b, lanes, speedKmh, oneway (0|1), class index, name index or -1]

export const RoadNetwork = z.strictObject({
  format: z.literal(ROAD_NETWORK_FORMAT),
  version: z.literal(1),
  source: z.literal("openstreetmap"),
  /** Shown wherever the network is: the licence requires it. */
  attribution: z.literal("© OpenStreetMap contributors (ODbL)"),
  /** The network's north-west corner, degrees. */
  origin: z.strictObject({
    lat: z.number().min(-85).max(85),
    lon: z.number().min(-180).max(180),
  }),
  /** Width and height covered, metres. */
  extentM: z.tuple([
    z.int().min(100).max(NETWORK_BOUNDS.extentM),
    z.int().min(100).max(NETWORK_BOUNDS.extentM),
  ]),
  /** x, z per node, metres. */
  nodes: z
    .array(z.int().min(0).max(NETWORK_BOUNDS.extentM))
    .max(NETWORK_BOUNDS.nodes * 2)
    .refine((a) => a.length % 2 === 0, "nodes come in x, z pairs"),
  /** LINK_FIELDS integers per link. */
  links: z
    .array(z.int().min(-1).max(NETWORK_BOUNDS.nodes))
    .max(NETWORK_BOUNDS.links * LINK_FIELDS)
    .refine((a) => a.length % LINK_FIELDS === 0, "links come in rows"),
  /** Per link, where its shape points start in `shape` (x, z pairs); one more than links. */
  shapeAt: z.array(z.int().min(0)).max(NETWORK_BOUNDS.links + 1),
  shape: z.array(z.int().min(0).max(NETWORK_BOUNDS.extentM)).max(NETWORK_BOUNDS.shapePoints * 2),
  /** Street names, display only. */
  names: z.array(z.string().max(80)).max(NETWORK_BOUNDS.names),
});
export type RoadNetwork = z.infer<typeof RoadNetwork>;

/** Problems a network's references have (out-of-range nodes, names, shapes). */
export function networkIssues(n: RoadNetwork): string[] {
  const issues: string[] = [];
  const nodes = n.nodes.length / 2;
  const links = n.links.length / LINK_FIELDS;
  for (let l = 0; l < links; l++) {
    const r = l * LINK_FIELDS;
    const a = n.links[r] as number;
    const b = n.links[r + 1] as number;
    const lanes = n.links[r + 2] as number;
    const speed = n.links[r + 3] as number;
    const oneway = n.links[r + 4] as number;
    const cls = n.links[r + 5] as number;
    const name = n.links[r + 6] as number;
    if (a < 0 || b < 0 || a >= nodes || b >= nodes || a === b) {
      issues.push(`link ${l} joins nodes that don't exist`);
    }
    if (lanes < 1 || lanes > NETWORK_BOUNDS.lanes) issues.push(`link ${l} has ${lanes} lanes`);
    if (speed < NETWORK_BOUNDS.speedKmh.min || speed > NETWORK_BOUNDS.speedKmh.max) {
      issues.push(`link ${l} has speed ${speed}`);
    }
    if (oneway !== 0 && oneway !== 1) issues.push(`link ${l} oneway must be 0 or 1`);
    if (cls < 0 || cls >= ROAD_CLASSES.length) issues.push(`link ${l} has an unknown class`);
    if (name < -1 || name >= n.names.length) issues.push(`link ${l} names a name that isn't there`);
    if (issues.length > 20) break;
  }
  if (n.shapeAt.length !== links + 1) issues.push("shapeAt must have one entry per link, plus one");
  for (let l = 0; l < n.shapeAt.length - 1; l++) {
    if ((n.shapeAt[l + 1] as number) < (n.shapeAt[l] as number)) {
      issues.push("shapeAt must not go backwards");
      break;
    }
  }
  if ((n.shapeAt[n.shapeAt.length - 1] ?? 0) * 2 > n.shape.length) {
    issues.push("shapeAt points past the end of shape");
  }
  return issues;
}
