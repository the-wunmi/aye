/**
 * System-level data access for trusted background jobs (the compile worker).
 *
 * These functions act without an end-user Actor. They must only be called from job
 * handlers whose input was enqueued by our own API after it authorised the request — never
 * from an HTTP handler. Anything they write on a user's behalf is attributed to the record
 * owner, not to the system.
 */
import type { ArtifactRef, CaptureStatus, RunStatus, StageRecord, UserId } from "@aye/schema";
import { eq } from "drizzle-orm";
import type { Db } from "./client.ts";
import { artifacts, captures, pipelineRuns, placeRevisions, places } from "./schema.ts";

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
