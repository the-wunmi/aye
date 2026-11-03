/**
 * What code can say about a layout a model wrote: physical things, in words the model can act on.
 * Two things can't be in the same place at the same height; what stands on something else is
 * fine. This knows nothing about what anything is, only where it is and how big. The model looks
 * again with these in hand (`Understander.review`).
 */
import type { Scene } from "@aye/schema";
import { cutOff } from "@aye/sim";
import type { SceneUnderstanding } from "./contracts.ts";

type Thing = SceneUnderstanding["objects"][number];

/** Share of the smaller footprint two things must share to count as in each other's way. */
const OVERLAP_SHARE = 0.25;

/** The square a thing covers on the map (rotation allowed for by turning its footprint). */
function footprint(o: Thing) {
  const turned = Math.abs((((o.yawDeg % 180) + 180) % 180) - 90) < 45;
  const halfX = (turned ? o.sizeM[1] : o.sizeM[0]) / 2;
  const halfZ = (turned ? o.sizeM[0] : o.sizeM[1]) / 2;
  return { x0: o.at[0] - halfX, x1: o.at[0] + halfX, z0: o.at[1] - halfZ, z1: o.at[1] + halfZ };
}

export function layoutFindings(u: Pick<SceneUnderstanding, "objects">): string[] {
  const findings: string[] = [];
  const things = u.objects;
  for (let i = 0; i < things.length; i++) {
    for (let j = i + 1; j < things.length; j++) {
      const a = things[i] as Thing;
      const b = things[j] as Thing;
      const aBottom = a.aboveFloorM ?? 0;
      const bBottom = b.aboveFloorM ?? 0;
      // One above the other: standing on it, or hung over it.
      if (aBottom >= bBottom + b.sizeM[2] - 0.05 || bBottom >= aBottom + a.sizeM[2] - 0.05) {
        continue;
      }
      const fa = footprint(a);
      const fb = footprint(b);
      const overlapX = Math.min(fa.x1, fb.x1) - Math.max(fa.x0, fb.x0);
      const overlapZ = Math.min(fa.z1, fb.z1) - Math.max(fa.z0, fb.z0);
      if (overlapX <= 0 || overlapZ <= 0) continue;
      const smaller = Math.min(a.sizeM[0] * a.sizeM[1], b.sizeM[0] * b.sizeM[1]);
      if (overlapX * overlapZ < OVERLAP_SHARE * smaller) continue;
      findings.push(
        `"${a.label}" and "${b.label}" are in the same place at the same height. If one stands on the other, give it that height; otherwise move them apart.`,
      );
    }
  }
  return findings;
}

/**
 * What can't be walked to, in words the model can act on: every space people could be in has to
 * connect to where they arrive. It says what's wrong and leaves how to fix it to the model.
 */
export function walkFindings(scene: Scene): string[] {
  const cut = cutOff(scene);
  const nameOf = new Map(scene.spaces.map((s) => [s.id as string, s.name]));
  const labelOf = new Map(scene.objects.map((o) => [o.id as string, o.label]));
  return [
    ...cut.spaces.map(
      (id) =>
        `Nobody can walk from where people arrive to "${nameOf.get(id)}". Something has to connect them: the opening (doorway, door, gate), stairs or ramp that really does, with its width and height; or whatever's standing in the way has to be where it really is, leaving room to pass. Every space has to be reachable.`,
    ),
    ...cut.things.map(
      (id) =>
        `"${labelOf.get(id)}" has no floor anyone can reach beside it: it isn't where it really is, or something's missing between it and the rest.`,
    ),
  ];
}

/** The spaces still cut off, as the model named them. */
export function cutOffSpaceNames(scene: Scene): string[] {
  const nameOf = new Map(scene.spaces.map((s) => [s.id as string, s.name]));
  return cutOff(scene).spaces.flatMap((id) => {
    const name = nameOf.get(id);
    return name ? [name] : [];
  });
}

/**
 * The last word, if the model never connected a space: it isn't part of the place. A floor
 * nobody can stand on is worse than a smaller place, and everything in it goes with it.
 */
export function withoutSpaces(u: SceneUnderstanding, names: readonly string[]): SceneUnderstanding {
  const gone = new Set(names);
  const removed = u.spaces.filter((s) => gone.has(s.name));
  const kept = u.spaces.filter((s) => !gone.has(s.name));
  if (removed.length === 0 || kept.length === 0) return u;
  const keys = new Set(removed.map((s) => s.key));
  const within = (p: readonly [number, number], list: typeof u.spaces) =>
    list.some((s) => inside(p, s.polygon));
  const nearKept = ([x, z]: readonly [number, number]) =>
    [
      [x, z],
      [x + 0.3, z],
      [x - 0.3, z],
      [x, z + 0.3],
      [x, z - 0.3],
    ].some((p) => within(p as [number, number], kept));
  return {
    ...u,
    spaces: kept,
    walls: u.walls.filter((w) => nearKept([(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2])),
    objects: u.objects.filter(
      (o) => !(o.spaceKey !== null && keys.has(o.spaceKey)) && !within(o.at, removed),
    ),
    openings: u.openings.filter((o) => !o.between.some((k) => k !== null && keys.has(k))),
    levelChanges: u.levelChanges.filter((l) => !within(l.from, removed) && !within(l.to, removed)),
  };
}

function inside(
  [x, z]: readonly [number, number],
  polygon: readonly (readonly [number, number])[],
) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i] as readonly [number, number];
    const b = polygon[j] as readonly [number, number];
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0])
      hit = !hit;
  }
  return hit;
}
