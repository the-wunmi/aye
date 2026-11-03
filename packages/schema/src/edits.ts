/**
 * Applying edits to a scene. Pure, idempotent, order-preserving.
 *
 * `put` replaces an entity by id or appends it; `remove` deletes by id (no-op if absent).
 * Because generated ids are derived from provenance, the same edit list can be replayed on
 * a regenerated base scene: edits to entities that still exist apply, edits to entities
 * that vanished are reported as orphaned rather than silently resurrecting them.
 */
import type { EditOp } from "./place.ts";
import { Scene } from "./scene.ts";

type Collection =
  | "levels"
  | "spaces"
  | "walls"
  | "openings"
  | "levelChanges"
  | "objects"
  | "portals";

const COLLECTION: Record<string, Collection> = {
  level: "levels",
  space: "spaces",
  wall: "walls",
  opening: "openings",
  levelChange: "levelChanges",
  object: "objects",
  portal: "portals",
};

export interface ApplyResult {
  scene: Scene;
  /** Indices of `put` edits that targeted ids missing from the base (new entities are fine). */
  orphaned: number[];
}

export function applyEdits(base: Scene, edits: readonly EditOp[]): ApplyResult {
  const baseIds = new Set<string>();
  const work: Record<Collection, { id: string }[]> = {
    levels: [...base.levels],
    spaces: [...base.spaces],
    walls: [...base.walls],
    openings: [...base.openings],
    levelChanges: [...base.levelChanges],
    objects: [...base.objects],
    portals: [...base.portals],
  };
  for (const items of Object.values(work)) for (const item of items) baseIds.add(item.id);

  const orphaned: number[] = [];
  edits.forEach((edit, index) => {
    const [entity, action] = edit.op.split(".") as [string, "put" | "remove"];
    const name = COLLECTION[entity];
    if (!name) throw new Error(`unknown edit target ${entity}`);
    const items = work[name];
    if (action === "remove") {
      const id = (edit as { id: string }).id;
      work[name] = items.filter((i) => i.id !== id);
      return;
    }
    const value = (edit as { value: { id: string } }).value;
    const at = items.findIndex((i) => i.id === value.id);
    if (at >= 0) items[at] = value;
    else items.push(value);
    if (at < 0 && baseIds.has(value.id)) orphaned.push(index);
  });

  // Re-validate: edits are user input, and must not break referential integrity.
  return { scene: Scene.parse({ ...base, ...work }), orphaned };
}
