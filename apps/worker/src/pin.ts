/**
 * Committing a place's next revision and pinning it into a world, safely. A pin must only
 * ever point at a revision that was saved: a pin to a missing revision is a place nobody can
 * enter. Two jobs may move a place's head at once (a build's dressing and a furnishing run),
 * so a conflict is expected, not exceptional: this revision goes on top of the current head
 * and is tried again. (Keeping the old head instead would let a rebuild silently lose.)
 * Trusted job code only (system* functions).
 */
import { hashJson } from "@aye/artifacts";
import {
  ConflictError,
  type Db,
  systemCommitRevision,
  systemGetHead,
  systemPinPlace,
} from "@aye/db";
import type { ArtifactHash, PlaceId, PlaceRevision, Scene, UserId } from "@aye/schema";

export async function commitAndPin(
  db: Db,
  target: { worldId: string; key: string; ownerId: UserId },
  revision: PlaceRevision,
  scene: Scene,
): Promise<ArtifactHash | null> {
  let rev = revision;
  for (let attempt = 0; attempt < 4; attempt++) {
    const hash = hashJson(rev) as ArtifactHash;
    let saved = false;
    try {
      saved = await systemCommitRevision(db, target.ownerId, hash, rev, scene);
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      const head = (await systemGetHead(db, rev.placeId))?.head as ArtifactHash | null;
      if (!head) throw err;
      rev = { ...rev, parent: head };
      continue;
    }
    if (!saved) return null;
    await pin(db, target, rev.placeId, hash);
    return hash;
  }
  return null;
}

const pin = (
  db: Db,
  target: { worldId: string; key: string },
  placeId: PlaceId,
  revision: ArtifactHash,
) => systemPinPlace(db, target.worldId, { key: target.key, placeId, revision });
