/**
 * Captures: a phone video of a real place, and the compile run that turns it into a scene.
 */
import { z } from "zod";
import { ArtifactHash, ArtifactRef, StageRecord } from "./artifact.ts";
import { CaptureId, PlaceId, RunId, UserId } from "./ids.ts";
import { Timestamp } from "./primitives.ts";

export const CaptureStatus = z.enum(["uploaded", "queued", "processing", "ready", "failed"]);
export type CaptureStatus = z.infer<typeof CaptureStatus>;

export const Capture = z.object({
  id: CaptureId,
  placeId: PlaceId,
  ownerId: UserId,
  /** The original upload. Never shared; only redacted derivatives leave the owner's scope. */
  video: ArtifactRef,
  durationMs: z.int().positive(),
  recordedAt: Timestamp.nullable(),
  status: CaptureStatus,
  createdAt: Timestamp,
});
export type Capture = z.infer<typeof Capture>;

export const RunStatus = z.enum(["running", "succeeded", "failed"]);
export type RunStatus = z.infer<typeof RunStatus>;

/** One execution of the capture → scene pipeline. Every stage is recorded for provenance. */
export const PipelineRun = z.object({
  id: RunId,
  captureId: CaptureId,
  /** Hash of the pipeline definition (stages + versions), so runs are comparable. */
  pipelineHash: ArtifactHash,
  status: RunStatus,
  stages: z.array(StageRecord).max(64),
  /** The resulting scene, once succeeded. */
  scene: ArtifactRef.nullable(),
  error: z.string().max(2_000).nullable(),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});
export type PipelineRun = z.infer<typeof PipelineRun>;
