/**
 * Memoised stage execution — the heart of reproducible generation.
 *
 * A stage run is identified by its Recipe (stage name + version, model ref, prompt hash,
 * input artifact hashes, params, derived seed). If the recipe index already holds that
 * recipe and the outputs are still in the store, they are returned as-is: no model call,
 * byte-identical result. Otherwise the stage runs once and its outputs are recorded.
 *
 * This is what makes AI output "deterministic" in practice: not by hoping a model returns
 * the same tokens twice, but by never asking it the same question twice.
 */
import {
  type ArtifactStore,
  encodeJson,
  hashBytes,
  type RecipeIndex,
  recipeHash,
  seedFrom,
} from "@aye/artifacts";
import type { ArtifactHash, ArtifactRef, Json, ModelRef, Recipe, StageRecord } from "@aye/schema";

export interface StageOutput {
  bytes: Uint8Array;
  mediaType: string;
}

export interface StageSpec {
  stage: string;
  version: number;
  model: ModelRef | null;
  prompt: string | null;
  inputs: Record<string, ArtifactHash>;
  params: Record<string, Json>;
}

export interface StageDeps {
  store: ArtifactStore;
  index: RecipeIndex;
  signal: AbortSignal;
  /** Called for observability; never affects results. */
  onStage?: (record: StageRecord, cached: boolean) => void;
}

export interface StageResult<K extends string = string> {
  record: StageRecord;
  outputs: Record<K, ArtifactRef>;
  cached: boolean;
}

export function recipeFor(spec: StageSpec): Recipe {
  const promptHash = spec.prompt === null ? null : hashBytes(new TextEncoder().encode(spec.prompt));
  const base = {
    stage: spec.stage,
    stageVersion: spec.version,
    model: spec.model,
    promptHash,
    inputs: spec.inputs,
    params: spec.params,
  };
  return { ...base, seed: seedFrom(base) };
}

export async function runStage<K extends string>(
  spec: StageSpec,
  deps: StageDeps,
  execute: (seed: number) => Promise<Record<K, StageOutput>>,
): Promise<StageResult<K>> {
  deps.signal.throwIfAborted();
  const recipe = recipeFor(spec);
  const key = recipeHash(recipe);

  const hit = await deps.index.lookup(key);
  if (hit && (await allPresent(deps.store, hit.outputs))) {
    deps.onStage?.(hit, true);
    return { record: hit, outputs: hit.outputs as Record<K, ArtifactRef>, cached: true };
  }

  const produced = await execute(recipe.seed);
  deps.signal.throwIfAborted();
  const outputs = {} as Record<K, ArtifactRef>;
  for (const name of (Object.keys(produced) as K[]).sort()) {
    const out = produced[name];
    outputs[name] = await deps.store.put(out.bytes, out.mediaType);
  }
  const record: StageRecord = { recipeHash: key, recipe, outputs };
  await deps.index.record(record);
  deps.onStage?.(record, false);
  return { record, outputs, cached: false };
}

async function allPresent(
  store: ArtifactStore,
  outputs: Record<string, ArtifactRef>,
): Promise<boolean> {
  for (const ref of Object.values(outputs)) if (!(await store.has(ref.hash))) return false;
  return true;
}

export const json = (value: unknown): StageOutput => ({
  bytes: encodeJson(value),
  mediaType: "application/json",
});

export async function readJson(store: ArtifactStore, ref: ArtifactRef): Promise<unknown> {
  const bytes = await store.get(ref.hash);
  if (!bytes) throw new Error(`missing artifact ${ref.hash}`);
  return JSON.parse(new TextDecoder().decode(bytes));
}
