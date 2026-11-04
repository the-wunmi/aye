/**
 * Moving a thing in a place by hand. The client only proposes where; this decides. A thing goes
 * where physics lets it stand, and nowhere that would shut off a room or something people use
 * that could be reached before. What rests on it goes with it, so the TV stays on its unit.
 *
 * Pure and deterministic: the same scene, spec and move give the same scene, on the server that
 * saves it and on the client showing where it could go.
 */
import type { ObjectId, Scene, SceneObject, WorldSpec } from "@aye/schema";
import { PlacementField } from "./placement.ts";
import { solidity } from "./sim.ts";
import { cosQ16, Q16, sinQ16 } from "./trig.ts";
import { cutOff } from "./walkable.ts";

export interface MoveTo {
  xMm: number;
  zMm: number;
  yawDeg: number;
}

export type MoveResult =
  | { ok: true; scene: Scene; moved: SceneObject[] }
  | { ok: false; reason: string };

/** Further than any place is wide: a number past this isn't a position. */
const MAX_COORD_MM = 10_000_000;

const onFloor = (o: SceneObject) => (o.transform.position[1] ?? 0) === 0;

function insideXZ(x: number, z: number, polygon: readonly (readonly number[])[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi = 0, zi = 0] = polygon[i] as readonly number[];
    const [xj = 0, zj = 0] = polygon[j] as readonly number[];
    // Where this edge crosses z, compared without dividing: which way round depends on the edge's
    // direction, so an outline drawn either way round gives the same answer.
    if (zi > z === zj > z) continue;
    const left = (x - xi) * (zj - zi) < (xj - xi) * (z - zi);
    if (zj > zi ? left : !left) hit = !hit;
  }
  return hit;
}

/** Can someone pick this up? Things on a wall or on something else stay with what holds them. */
export const canBeMoved = (o: SceneObject) => onFloor(o);

/** What's resting on a thing: off the floor, on the same level, its middle over this footprint. */
export function carriedBy(scene: Scene, object: ObjectId): SceneObject[] {
  const base = scene.objects.find((o) => o.id === object);
  if (!base) return [];
  const [bx = 0, , bz = 0] = base.transform.position;
  const cos = cosQ16(Math.round(base.transform.yawDeg));
  const sin = sinQ16(Math.round(base.transform.yawDeg));
  return scene.objects.filter((o) => {
    if (o.id === object || o.levelId !== base.levelId || onFloor(o)) return false;
    // Hung on a wall above something isn't resting on it: it has to start at the thing's top.
    const [x = 0, y = 0, z = 0] = o.transform.position;
    if (Math.abs(y - base.size.h) > 150) return false;
    const dx = x - bx;
    const dz = z - bz;
    const along = Math.abs(Math.floor((dx * cos + dz * sin) / Q16));
    const across = Math.abs(Math.floor((dz * cos - dx * sin) / Q16));
    return along <= base.size.w / 2 && across <= base.size.d / 2;
  });
}

/**
 * Whether a thing can stand somewhere, and why not: quick enough to ask on every step of a drag,
 * and the same answer the move itself is held to. By hand, nothing goes through a wall, even
 * what's allowed to be built against one; and its middle has to be on some room's floor.
 */
export function standingCheck(
  scene: Scene,
  spec: WorldSpec,
  object: ObjectId,
): ((to: MoveTo) => string | null) | null {
  const was = scene.objects.find((o) => o.id === object);
  if (!was) return null;
  const field = PlacementField.for(scene, solidity(spec), object, undefined, { walls: true });
  const y = was.transform.position[1] ?? 0;
  return (to) => {
    const onAFloor = scene.spaces.some(
      (s) => s.levelId === was.levelId && insideXZ(to.xMm, to.zMm, s.polygon),
    );
    if (!onAFloor) return "That's outside the place.";
    return field.problem({ position: [to.xMm, y, to.zMm], yawDeg: to.yawDeg });
  };
}

export function moveThing(scene: Scene, spec: WorldSpec, object: ObjectId, to: MoveTo): MoveResult {
  const was = scene.objects.find((o) => o.id === object);
  if (!was) return { ok: false, reason: "That isn't here any more." };
  if (!canBeMoved(was)) return { ok: false, reason: "That's fixed where it is." };
  const inBounds = (n: number) => Number.isInteger(n) && Math.abs(n) <= MAX_COORD_MM;
  if (!inBounds(to.xMm) || !inBounds(to.zMm) || !Number.isInteger(to.yawDeg)) {
    return { ok: false, reason: "That's outside the place." };
  }
  const space = scene.spaces.find(
    (s) => s.levelId === was.levelId && insideXZ(to.xMm, to.zMm, s.polygon),
  );
  if (!space) return { ok: false, reason: "That's outside the place." };

  const yawDeg = ((to.yawDeg % 360) + 360) % 360;
  const position: [number, number, number] = [to.xMm, was.transform.position[1] ?? 0, to.zMm];
  const isSolid = solidity(spec);
  const problem = standingCheck(scene, spec, object)?.({ ...to, yawDeg });
  if (problem) return { ok: false, reason: problem };

  // Round the thing's own middle, by as much as it turned.
  const [fromX = 0, , fromZ = 0] = was.transform.position;
  const turn = Math.round(yawDeg - was.transform.yawDeg);
  const cos = cosQ16(turn);
  const sin = sinQ16(turn);
  const riders = carriedBy(scene, object).map((o): SceneObject => {
    const [x = 0, y = 0, z = 0] = o.transform.position;
    const dx = x - fromX;
    const dz = z - fromZ;
    return {
      ...o,
      spaceId: space.id,
      transform: {
        ...o.transform,
        position: [
          to.xMm + Math.round((dx * cos - dz * sin) / Q16),
          y,
          to.zMm + Math.round((dx * sin + dz * cos) / Q16),
        ],
        yawDeg: (((Math.round(o.transform.yawDeg) + turn) % 360) + 360) % 360,
      },
    };
  });
  const moved: SceneObject[] = [
    { ...was, spaceId: space.id, transform: { ...was.transform, position, yawDeg } },
    ...riders,
  ];
  const byId = new Map(moved.map((o) => [o.id, o]));
  const next: Scene = { ...scene, objects: scene.objects.map((o) => byId.get(o.id) ?? o) };

  // Nothing that could be reached before may end up shut off by this.
  const before = cutOff(scene, isSolid);
  const after = cutOff(next, isSolid);
  const roomGone = after.spaces.find((s) => !before.spaces.includes(s));
  if (roomGone) {
    const name = scene.spaces.find((s) => s.id === roomGone)?.name ?? "a room";
    return { ok: false, reason: `That would block the way to ${name}.` };
  }
  const thingGone = after.things.find((t) => !before.things.includes(t));
  if (thingGone) {
    const label = scene.objects.find((o) => o.id === thingGone)?.label ?? "something";
    return { ok: false, reason: `Nobody could reach ${label} with it there.` };
  }
  return { ok: true, scene: next, moved };
}

/** One move of a rearrangement: each is checked against the room the last one left. */
export interface MoveOf extends MoveTo {
  object: ObjectId;
}

/**
 * Everything someone did before saying they were done. It stands or falls together, so nobody ever
 * sees half of a rearrangement. `moved` has each thing once, where it ended up.
 */
export function moveThings(scene: Scene, spec: WorldSpec, moves: readonly MoveOf[]): MoveResult {
  let now = scene;
  const moved = new Map<string, SceneObject>();
  for (const { object, ...to } of moves) {
    const step = moveThing(now, spec, object, to);
    if (!step.ok) return step;
    now = step.scene;
    for (const o of step.moved) moved.set(o.id, o);
  }
  return { ok: true, scene: now, moved: [...moved.values()] };
}
