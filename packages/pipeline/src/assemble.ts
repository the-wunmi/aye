/**
 * Assembler: turns a model's SceneUnderstanding into a canonical, validated Scene.
 *
 * Pure and deterministic. This is where "the model proposes, code disposes" happens:
 * - metres → integer millimetres, clamped to schema limits, normalised to a min-corner origin
 * - ids derived from provenance (capture + track / model key), so re-runs keep ids stable
 * - an object carrying a private track's number is dropped, whatever the model called it
 * - every collection sorted by id, then validated by the Scene schema with referential checks
 */

import { deriveId } from "@aye/artifacts";
import {
  type CaptureId,
  LIMITS,
  type Polygon,
  SCENE_FORMAT,
  SCENE_SCHEMA_VERSION,
  Scene,
  type Vec2,
} from "@aye/schema";
import { bringInside, clearWays, makeWayThrough, openSealedSpaces } from "./clear-ways.ts";
import type { SceneUnderstanding, TrackSet } from "./contracts.ts";

/** Bump when assembly behaviour changes; it is part of the assemble stage's recipe. */
export const ASSEMBLER_VERSION = 9;

const clampMm = (mm: number) => Math.max(-LIMITS.coordMm, Math.min(LIMITS.coordMm, mm));
const toMm = (m: number) => clampMm(Math.round(m * 1000));
const toYaw = (deg: number) => ((Math.round(deg) % 360) + 360) % 360;
const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Code point ranges stripped from model text: C0/C1 controls, zero-width characters and
 * bidirectional overrides/isolates (the "Trojan Source" set). Built from numbers so the
 * source itself never contains invisible characters.
 */
const UNSAFE_TEXT = new RegExp(
  [
    [0x00, 0x1f],
    [0x7f, 0x9f],
    [0x200b, 0x200f],
    [0x202a, 0x202e],
    [0x2066, 0x2069],
  ]
    .map(([a, b]) => `\\u{${(a as number).toString(16)}}-\\u{${(b as number).toString(16)}}`)
    .join("")
    .replace(/^/, "[")
    .concat("]"),
  "gu",
);

/** Strip unsafe characters and collapse whitespace; text is display-only but stays tidy. */
export function cleanText(text: string, max: number = LIMITS.label): string {
  return text.replace(UNSAFE_TEXT, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export interface AssembleInput {
  captureId: CaptureId;
  understanding: SceneUnderstanding;
  tracks: TrackSet;
}

/**
 * Is this the name of someone, or of something that identifies them? People in a place are the
 * world's to write, not furniture from a video. A child's bed is still a bed, so what belongs to
 * someone isn't caught: only the person. A list of privacy's own words, not what a world contains.
 */
const PRIVATE_THING =
  /\b(person|people|man|men|woman|women|boy|girl|child|children|baby|toddler|kid|kids|pedestrian|passenger|license plate|licence plate|number plate|passport|id card|bank card|credit card|bank statement)\b(?!['\u2019]s)/i;
export const isPrivateThing = (label: string) => PRIVATE_THING.test(label);

export function assembleScene({ captureId, understanding: u, tracks }: AssembleInput): Scene {
  // Normalise to a min-corner origin so scenes from different captures line up predictably.
  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  for (const s of u.spaces) {
    for (const [x, z] of s.polygon) {
      minX = Math.min(minX, x);
      minZ = Math.min(minZ, z);
    }
  }
  const pt = ([x, z]: readonly [number, number]): Vec2 => [toMm(x - minX), toMm(z - minZ)];

  const levelId = deriveId("level", [captureId, "ground"]);
  const spaceIds = new Map<string, string>();
  const spaces = u.spaces.flatMap((s) => {
    const polygon = dedupe(s.polygon.map(pt));
    if (polygon.length < 3) return [];
    const id = deriveId("space", [captureId, s.key]);
    spaceIds.set(s.key, id);
    return [
      {
        id,
        levelId,
        name: cleanText(s.name),
        polygon,
        floorOffsetMm: toMm(s.floorOffsetM),
        ceilingMm: s.outdoor ? null : 2700,
      },
    ];
  });

  const walls = u.walls.flatMap((w) => {
    const a = pt(w.a);
    const b = pt(w.b);
    if (a[0] === b[0] && a[1] === b[1]) return [];
    // Id from endpoints rounded to 10 cm, order-independent: stable under tiny re-estimates.
    const ends = [a, b].map(([x, z]) => [Math.round(x / 100), Math.round(z / 100)]).sort();
    return [
      {
        id: deriveId("wall", [captureId, ends]),
        levelId,
        a,
        b,
        thicknessMm: 150,
        heightMm: Math.max(1, toMm(w.heightM)),
      },
    ];
  });
  const uniqueWalls = uniqueById(walls);

  const openings = u.openings.map((o) => {
    const at = pt(o.at);
    return {
      id: deriveId("opening", [captureId, o.key]),
      levelId,
      kind: o.kind,
      wallId: nearestWall(uniqueWalls, at, 300),
      at,
      yawDeg: toYaw(o.alongDeg),
      clearWidthMm: Math.max(1, toMm(o.clearWidthM)),
      heightMm: o.kind === "window" ? 1200 : 2100,
      sillMm: o.kind === "window" ? 900 : 0,
      thresholdMm: toMm(o.thresholdM),
      connects: o.between.map((k) => (k === null ? null : (spaceIds.get(k) ?? null))) as [
        string | null,
        string | null,
      ],
    };
  });

  const levelChanges = u.levelChanges.map((c) => ({
    id: deriveId("levelChange", [captureId, c.key]),
    kind: c.kind,
    fromLevelId: levelId,
    toLevelId: levelId,
    from: pt(c.from),
    to: pt(c.to),
    widthMm: Math.max(1, toMm(c.widthM)),
    riseMm: toMm(c.riseM),
    stepCount: c.steps,
    hasHandrail: c.handrail,
  }));

  const trackById = new Map(tracks.tracks.map((t) => [t.trackId, t]));
  const objects = u.objects.flatMap((o) => {
    const track = trackById.get(o.trackId);
    // Privacy: an object tied to a private track never becomes a scene object, whatever its label.
    if (track?.private) return [];
    // A model's objects aren't tied to what the segmenter found (it numbers them itself, and a
    // spot in a room can't be matched to pixels in a frame), so what it calls them is checked too.
    if (isPrivateThing(o.label)) return [];
    const [x, z] = pt(o.at);
    return [
      {
        id: deriveId("object", [captureId, o.trackId]),
        label: cleanText(o.label),
        levelId,
        spaceId: o.spaceKey === null ? null : (spaceIds.get(o.spaceKey) ?? null),
        transform: {
          position: [x, toMm(o.aboveFloorM ?? 0), z] as [number, number, number],
          yawDeg: toYaw(o.yawDeg),
        },
        size: {
          w: Math.max(10, toMm(o.sizeM[0])),
          d: Math.max(10, toMm(o.sizeM[1])),
          h: Math.max(10, toMm(o.sizeM[2])),
        },
        evidence: track
          ? {
              captureId,
              trackId: track.trackId,
              frameStart: track.frameStart,
              frameEnd: Math.max(track.frameStart, track.frameEnd),
              confidence: Math.round(track.confidence * 1000),
              mask: track.masks,
            }
          : null,
      },
    ];
  });

  const portals = u.exits.map((e) => ({
    id: deriveId("portal", [captureId, e.key]),
    levelId,
    at: pt(e.at),
    yawDeg: toYaw(e.alongDeg),
    widthMm: Math.max(1, toMm(e.widthM)),
    label: cleanText(e.label),
  }));
  // Everyone needs a way in. With no exits described, arrive in the middle of the largest
  // open space (by bounding box), so a place is never unplayable for want of a door.
  if (portals.length === 0 && spaces.length > 0) {
    const area = (p: Vec2[]) => {
      const xs = p.map((v) => v[0]);
      const zs = p.map((v) => v[1]);
      return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...zs) - Math.min(...zs));
    };
    const open = spaces.filter((s) => s.ceilingMm === null);
    const largest = (open.length > 0 ? open : spaces).reduce((a, b) =>
      area(b.polygon) > area(a.polygon) ? b : a,
    );
    const n = largest.polygon.length;
    const cx = Math.round(largest.polygon.reduce((t, v) => t + v[0], 0) / n);
    const cz = Math.round(largest.polygon.reduce((t, v) => t + v[1], 0) / n);
    portals.push({
      id: deriveId("portal", [captureId, "arrival"]),
      levelId,
      at: [cx, cz],
      yawDeg: 0,
      widthMm: 2000,
      label: "Arrival",
    });
  }
  // A single way in is the entrance; with several, every exit is a way in and the simulation
  // picks, per body, the one that opens onto the most reachable ground.
  const entry = portals.length === 1 ? (portals[0] as (typeof portals)[number]).id : null;

  const assembled = Scene.parse({
    format: SCENE_FORMAT,
    schemaVersion: SCENE_SCHEMA_VERSION,
    levels: [
      {
        id: levelId,
        name: "Ground",
        elevationMm: 0,
        footprint: boundsOf(spaces.map((s) => s.polygon)),
      },
    ],
    spaces: spaces.sort(byId),
    walls: uniqueWalls.sort(byId),
    openings: uniqueById(openings).sort(byId),
    levelChanges: uniqueById(levelChanges).sort(byId),
    objects: uniqueById(objects).sort(byId).slice(0, LIMITS.objects),
    portals: uniqueById(portals).sort(byId).slice(0, LIMITS.portals),
    entry,
  });
  // Every space can be walked into, everything stands inside the place, nothing stands in a
  // doorway's approach, and furniture doesn't seal off a floor the building leaves open.
  return makeWayThrough(clearWays(bringInside(openSealedSpaces(assembled).scene).scene).scene)
    .scene;
}

function dedupe(points: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first && last && first[0] === last[0] && first[1] === last[1]) out.pop();
  return out;
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => !seen.has(i.id) && seen.add(i.id));
}

function boundsOf(polygons: Polygon[]): Polygon {
  let x0 = 0;
  let z0 = 0;
  let x1 = 1;
  let z1 = 1;
  for (const poly of polygons) {
    for (const [x, z] of poly) {
      x0 = Math.min(x0, x);
      z0 = Math.min(z0, z);
      x1 = Math.max(x1, x);
      z1 = Math.max(z1, z);
    }
  }
  return [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
  ];
}

function nearestWall(
  walls: { id: string; a: Vec2; b: Vec2 }[],
  [px, pz]: Vec2,
  maxMm: number,
): string | null {
  let best: string | null = null;
  let bestD = maxMm * maxMm;
  for (const w of walls) {
    const [ax, az] = w.a;
    const [bx, bz] = w.b;
    const lx = bx - ax;
    const lz = bz - az;
    const t = Math.max(0, Math.min(1, ((px - ax) * lx + (pz - az) * lz) / (lx * lx + lz * lz)));
    const dx = px - (ax + t * lx);
    const dz = pz - (az + t * lz);
    const d = dx * dx + dz * dz;
    if (d < bestD || (d === bestD && best !== null && w.id < best)) {
      bestD = d;
      best = w.id;
    }
  }
  return best;
}
