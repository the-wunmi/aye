/**
 * Places and their revision history.
 *
 * A Place is the mutable identity ("Tolu's flat"). Its content is a chain of immutable
 * PlaceRevisions, git-style. A revision = a generated base scene + an ordered list of edits.
 *
 * Keeping edits as ops on top of the generated base (instead of saving the edited scene
 * only) means that when a better model regenerates the base, the user's edits are replayed
 * onto it — a rebase — because generated entity ids are derived from provenance and stable.
 */
import { z } from "zod";
import { ArtifactHash, ArtifactRef } from "./artifact.ts";
import { GeoAnchor } from "./geo.ts";
import {
  LevelChangeId,
  LevelId,
  ObjectId,
  OpeningId,
  PlaceId,
  PortalId,
  SpaceId,
  UserId,
  WallId,
} from "./ids.ts";
import { LIMITS, Timestamp } from "./primitives.ts";
import { Level, LevelChange, Opening, Portal, SceneObject, Space, Wall } from "./scene.ts";

export const Visibility = z.enum(["private", "unlisted", "public"]);
export type Visibility = z.infer<typeof Visibility>;

export const Place = z.object({
  id: PlaceId,
  ownerId: UserId,
  name: z.string().min(1).max(120),
  visibility: Visibility,
  geo: GeoAnchor.nullable(),
  /** Latest revision, or null until the place is first built. */
  head: ArtifactHash.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Place = z.infer<typeof Place>;

function collectionOps<const N extends string, V extends z.ZodType, I extends z.ZodType>(
  name: N,
  value: V,
  id: I,
) {
  return [
    z.object({ op: z.literal(`${name}.put` as `${N}.put`), value }),
    z.object({ op: z.literal(`${name}.remove` as `${N}.remove`), id }),
  ] as const;
}

/**
 * One edit to a scene, addressed by stable entity id. `put` inserts or replaces by id,
 * `remove` deletes; both are idempotent so replaying edits onto a regenerated base is safe.
 */
export const EditOp = z.discriminatedUnion("op", [
  ...collectionOps("level", Level, LevelId),
  ...collectionOps("space", Space, SpaceId),
  ...collectionOps("wall", Wall, WallId),
  ...collectionOps("opening", Opening, OpeningId),
  ...collectionOps("levelChange", LevelChange, LevelChangeId),
  ...collectionOps("object", SceneObject, ObjectId),
  ...collectionOps("portal", Portal, PortalId),
]);
export type EditOp = z.infer<typeof EditOp>;

/**
 * The place's world: the latest world spec a model wrote for it, and whether its owner
 * approved it. A city's places are pinned and played by its members either way.
 */
export const RevisionWorld = z.object({ spec: ArtifactRef, approved: z.boolean() });
export type RevisionWorld = z.infer<typeof RevisionWorld>;

/**
 * Immutable. Its hash (of the canonical JSON) is its identity, so revisions can be shared
 * and pinned across users and worlds the way a lockfile pins a package.
 */
export const PlaceRevision = z.object({
  placeId: PlaceId,
  parent: ArtifactHash.nullable(),
  /** Scene produced by the pipeline. */
  base: ArtifactRef,
  /** Every edit since `base`, in order. */
  edits: z.array(EditOp).max(LIMITS.edits),
  /** `base` with `edits` applied; a cache, re-derivable at any time. */
  scene: ArtifactRef,
  /** The world spec; null when none has been written. Carried unchanged by ordinary edits. */
  world: RevisionWorld.nullable(),
  authorId: UserId,
  message: z.string().max(LIMITS.text),
  createdAt: Timestamp,
});
export type PlaceRevision = z.infer<typeof PlaceRevision>;
