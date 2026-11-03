/**
 * Content-addressed artifacts and the recipes that produce them.
 *
 * Every blob Ayé stores (videos, masks, sprites, scene JSON, model responses) is addressed
 * by the BLAKE3 hash of its bytes. Every *generated* artifact also records the Recipe that
 * produced it, and the recipe's own hash is the cache key: identical recipe ⇒ identical
 * artifact, without calling the model again. This is what makes AI output reproducible.
 */
import { z } from "zod";
import { Json } from "./primitives.ts";

export const ArtifactHash = z
  .string()
  .regex(/^b3:[0-9a-f]{64}$/, "expected b3:<64 hex chars>")
  .brand<"ArtifactHash">();
export type ArtifactHash = z.infer<typeof ArtifactHash>;

export const MediaType = z
  .string()
  .max(128)
  .regex(/^[a-z]+\/[a-z0-9.+-]+$/, "IANA media type");

export const ArtifactRef = z.object({
  hash: ArtifactHash,
  mediaType: MediaType,
  bytes: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

/** Identifies an exact model build. `version` must be immutable (a dated snapshot, not "latest"). */
export const ModelRef = z.object({
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
});
export type ModelRef = z.infer<typeof ModelRef>;

/**
 * Everything that determines a stage's output. If any field changes, the output is a new
 * artifact; if none change, the cached artifact is reused byte-for-byte.
 */
export const Recipe = z.object({
  /** Pipeline stage name, e.g. `understand`. */
  stage: z
    .string()
    .max(64)
    .regex(/^[a-z][a-z0-9-]*$/),
  /** Bumped whenever the stage's code or prompt changes behaviour. */
  stageVersion: z.int().positive(),
  model: ModelRef.nullable(),
  /** Hash of the exact prompt template text, if any. */
  promptHash: ArtifactHash.nullable(),
  /** Named input artifacts, e.g. `{ video: "b3:…" }`. */
  inputs: z.record(z.string().max(64), ArtifactHash),
  /** Canonicalised parameters (temperature, resolution, …). */
  params: z.record(z.string().max(64), Json),
  /** Seed for any stochastic step, derived from the recipe's inputs rather than chosen randomly. */
  seed: z.int().nonnegative(),
});
export type Recipe = z.infer<typeof Recipe>;

/** A recorded stage execution: the recipe, its hash, and the artifacts it produced. */
export const StageRecord = z.object({
  recipeHash: ArtifactHash,
  recipe: Recipe,
  outputs: z.record(z.string().max(64), ArtifactRef),
});
export type StageRecord = z.infer<typeof StageRecord>;
