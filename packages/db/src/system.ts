/**
 * System-level data access for trusted background jobs (the compile worker).
 *
 * These functions act without an end-user Actor. They must only be called from job
 * handlers whose input was enqueued by our own API after it authorised the request — never
 * from an HTTP handler. Anything they write on a user's behalf is attributed to the record
 * owner, not to the system.
 */
import type {
  ArtifactHash,
  ArtifactRef,
  CaptureStatus,
  RunStatus,
  StageRecord,
  UserId,
} from "@aye/schema";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import {
  artifactRefs,
  artifacts,
  captures,
  chatMessages,
  pipelineRuns,
  placeRevisions,
  places,
  recipes,
  worldPlaces,
} from "./schema.ts";

export async function systemGetCapture(db: Db, captureId: string) {
  const [row] = await db.select().from(captures).where(eq(captures.id, captureId)).limit(1);
  return row ?? null;
}

/** How far a capture has got, and (once it has joined its city) where it landed. */
export async function systemSetCapturePhase(
  db: Db,
  captureId: string,
  phase: string,
  placeKey?: string,
) {
  await db
    .update(captures)
    .set({ phase, ...(placeKey ? { placeKey } : {}) })
    .where(eq(captures.id, captureId));
}

export async function systemSetCaptureStatus(db: Db, captureId: string, status: CaptureStatus) {
  await db.update(captures).set({ status }).where(eq(captures.id, captureId));
}

/** Who owns a place, for jobs enqueued with only its id; null if it doesn't exist. */
export async function systemGetPlaceOwner(db: Db, placeId: string): Promise<UserId | null> {
  const [row] = await db
    .select({ ownerId: places.ownerId })
    .from(places)
    .where(eq(places.id, placeId))
    .limit(1);
  return (row?.ownerId as UserId | undefined) ?? null;
}

/** Current head revision of a place, with its edits, for rebasing onto a regenerated scene. */
export async function systemGetHead(db: Db, placeId: string) {
  const [row] = await db
    .select({ head: places.head, ownerId: places.ownerId, edits: placeRevisions.edits })
    .from(places)
    .leftJoin(placeRevisions, eq(placeRevisions.hash, places.head))
    .where(eq(places.id, placeId))
    .limit(1);
  return row ?? null;
}

export async function systemRecordArtifacts(db: Db, refs: readonly ArtifactRef[]) {
  if (refs.length === 0) return;
  await db
    .insert(artifacts)
    .values(refs.map((r) => ({ hash: r.hash, mediaType: r.mediaType, bytes: r.bytes })))
    .onConflictDoNothing();
}

export async function systemRecordRun(
  db: Db,
  run: {
    id: string;
    captureId: string;
    pipelineHash: ArtifactRef["hash"];
    status: RunStatus;
    stages: StageRecord[];
    scene: ArtifactRef["hash"] | null;
    error: string | null;
  },
) {
  await db
    .insert(pipelineRuns)
    .values({ ...run, finishedAt: run.status === "running" ? null : new Date() })
    .onConflictDoUpdate({
      target: pipelineRuns.id,
      set: {
        status: run.status,
        stages: run.stages,
        scene: run.scene,
        error: run.error,
        finishedAt: new Date(),
      },
    });
}

/** A filmed place's video and revisions, for removing it. Trusted job code only. */
export async function systemFilmedPlace(db: Db, worldId: string, key: string) {
  const [pin] = await db
    .select({ placeId: worldPlaces.placeId })
    .from(worldPlaces)
    .where(and(eq(worldPlaces.worldId, worldId), eq(worldPlaces.key, key)))
    .limit(1);
  if (!pin) return null;
  const videos = await db
    .select({ video: captures.video })
    .from(captures)
    .where(eq(captures.placeId, pin.placeId));
  const revisions = await db
    .select({ scene: placeRevisions.scene, spec: placeRevisions.worldSpec })
    .from(placeRevisions)
    .where(eq(placeRevisions.placeId, pin.placeId));
  return {
    placeId: pin.placeId,
    videos: [...new Set(videos.map((v) => v.video as string))],
    revisionArtifacts: [
      ...new Set(revisions.flatMap((r) => [r.scene as string, ...(r.spec ? [r.spec] : [])])),
    ],
  };
}

/** Did someone else film the same bytes? Then they aren't this person's to delete. */
export async function systemVideoUsedElsewhere(db: Db, video: string, placeId: string) {
  const [row] = await db
    .select({ id: captures.id })
    .from(captures)
    .where(and(eq(captures.video, video as ArtifactHash), ne(captures.placeId, placeId)))
    .limit(1);
  return Boolean(row);
}

/** The stages that took this artifact in, and what they gave out. */
export async function systemRecipesTaking(db: Db, hash: string) {
  const rows = await db.execute(
    sql`select recipe_hash, record from recipes r where exists (
      select 1 from jsonb_each_text(r.record->'recipe'->'inputs') e where e.value = ${hash})`,
  );
  return (rows as unknown as { recipe_hash: string; record: StageRecord }[]).map((r) => {
    const outputs = Object.values(r.record.outputs);
    return {
      recipeHash: r.recipe_hash,
      outputs: outputs.map((o) => o.hash as string),
      jsonOutputs: outputs
        .filter((o) => o.mediaType === "application/json")
        .map((o) => o.hash as string),
    };
  });
}

/** Does anything other than these recipes, or a place or world that remains, still use this? */
export async function systemArtifactStillUsed(
  db: Db,
  hash: string,
  leaving: ReadonlySet<string>,
): Promise<boolean> {
  const rows = await db.execute(
    sql`select 1 from place_revisions where scene = ${hash} or base = ${hash} or world_spec = ${hash}
      union all
      select 1 from worlds where city = ${hash}
      union all
      select 1 from captures where video = ${hash}
      limit 1`,
  );
  if ((rows as unknown as unknown[]).length > 0) return true;
  const makers = await db.execute(
    sql`select recipe_hash from recipes r where exists (
      select 1 from jsonb_each(r.record->'outputs') o where o.value->>'hash' = ${hash})`,
  );
  return (makers as unknown as { recipe_hash: string }[]).some((m) => !leaving.has(m.recipe_hash));
}

/** The place, its pin, its capture, its revisions and what was said in it. */
export async function systemRemovePlace(db: Db, worldId: string, key: string, placeId: string) {
  await db.transaction(async (tx) => {
    await tx
      .delete(chatMessages)
      .where(and(eq(chatMessages.worldId, worldId), eq(chatMessages.placeKey, key)));
    await tx.delete(places).where(eq(places.id, placeId));
  });
}

/** Forget what's been removed: nothing can link to it or replay it now. */
export async function systemForgetArtifacts(
  db: Db,
  hashes: readonly string[],
  recipeHashes: ReadonlySet<string>,
) {
  await db.transaction(async (tx) => {
    if (recipeHashes.size > 0) {
      await tx
        .delete(recipes)
        .where(inArray(recipes.recipeHash, [...recipeHashes] as ArtifactHash[]));
    }
    if (hashes.length > 0) {
      await tx
        .delete(artifactRefs)
        .where(inArray(artifactRefs.hash, [...hashes] as ArtifactHash[]));
      await tx.delete(artifacts).where(inArray(artifacts.hash, [...hashes] as ArtifactHash[]));
    }
  });
}
