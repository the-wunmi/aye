/**
 * Someone rearranging a place that's theirs. The API has checked it's theirs; this decides
 * whether it all can go there, and saves it as the place's next revision, an edit on top of the
 * last so the place's history stays whole. Rooms playing the place pick it up, as they do any
 * revision.
 *
 * The position is a request: `moveThings` checks it against physics. No model is involved.
 */
import { type ArtifactStore, encodeJson } from "@aye/artifacts";
import { type Db, systemGetHead, systemLinkWorldArtifacts, systemRecordArtifacts } from "@aye/db";
import { readJson } from "@aye/pipeline";
import {
  type ArtifactHash,
  type EditOp,
  ObjectId,
  type PlaceRevision,
  Scene,
  SpecKey,
  type UserId,
  WorldId,
  WorldSpec,
} from "@aye/schema";
import { moveThings } from "@aye/sim";
import { z } from "zod";
import { commitOnLatest } from "./pin.ts";

/** What someone did before saying they were done: a thing can be moved twice. */
export const Moves = z
  .array(
    z.strictObject({
      object: ObjectId,
      xMm: z.int().min(-10_000_000).max(10_000_000),
      zMm: z.int().min(-10_000_000).max(10_000_000),
      yawDeg: z.int().min(0).max(359),
    }),
  )
  .min(1)
  .max(64);

export const MoveJob = z.strictObject({
  worldId: WorldId,
  place: SpecKey,
  moves: Moves,
  /** Who's moving it: a change to a place someone else has since taken over is refused. */
  userId: z.string().max(64),
  nonce: z.string().regex(/^[0-9a-z]{6,32}$/),
});
export type MoveJob = z.infer<typeof MoveJob>;

export type MoveResult =
  | { ok: true; worldId: string; place: string }
  | { ok: false; reason: string };

const ref = (hash: string) => ({
  hash: hash as ArtifactHash,
  mediaType: "application/json",
  bytes: 0,
});

export async function runMoveJob(
  raw: unknown,
  deps: { db: Db; store: ArtifactStore },
): Promise<MoveResult> {
  const job = MoveJob.parse(raw);
  let refused: string | null = null;
  let links: ArtifactHash[] = [];
  const saved = await commitOnLatest(
    deps.db,
    { worldId: job.worldId, key: job.place },
    async (pinned) => {
      if (!pinned.spec) {
        refused = "That place isn't ready.";
        return null;
      }
      const ownerId = (await systemGetHead(deps.db, pinned.placeId))?.ownerId as UserId | undefined;
      if (!ownerId || ownerId !== job.userId) {
        refused = "That isn't yours to move.";
        return null;
      }
      const [scene, spec] = await Promise.all([
        readJson(deps.store, ref(pinned.scene)).then((j) => Scene.parse(j)),
        readJson(deps.store, ref(pinned.spec)).then((j) => WorldSpec.parse(j)),
      ]);
      const moved = moveThings(scene, spec, job.moves);
      if (!moved.ok) {
        refused = moved.reason;
        return null;
      }
      const sceneRef = await deps.store.put(encodeJson(moved.scene), "application/json");
      await systemRecordArtifacts(deps.db, [sceneRef]);
      links = [sceneRef.hash];
      const edits: EditOp[] = moved.moved.map((value) => ({ op: "object.put", value }));
      return {
        scene: moved.scene,
        revision: {
          placeId: pinned.placeId as PlaceRevision["placeId"],
          parent: pinned.revision,
          base: ref(pinned.base),
          edits: [...pinned.edits, ...edits],
          scene: sceneRef,
          world: { spec: ref(pinned.spec), approved: false },
          authorId: ownerId,
          message:
            moved.moved.length === 1
              ? `Moved ${moved.moved[0]?.label ?? "something"}`.slice(0, 200)
              : `Rearranged ${moved.moved.length} things`,
          createdAt: new Date().toISOString(),
        },
      };
    },
  );
  if (refused) return { ok: false, reason: refused };
  if (!saved) return { ok: false, reason: "That didn't save. Try again." };
  await systemLinkWorldArtifacts(deps.db, job.worldId, links);
  return { ok: true, worldId: job.worldId, place: job.place };
}
