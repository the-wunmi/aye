/**
 * Someone asks the world about a place ("could my mum get around here in a wheelchair?"): this
 * reads the place as it is now and hands it to the agent, which tests it and answers. Trusted
 * job: the API has checked the asker can see this place. The answer is for them alone: the job's
 * id names them.
 */
import type { ArtifactStore, RecipeIndex } from "@aye/artifacts";
import { type Db, systemGetPinnedPlace, systemGetWorld } from "@aye/db";
import { askWorld, readJson, type WorldAgent, type WorldAnswer } from "@aye/pipeline";
import {
  type ArtifactHash,
  Scene,
  SpecKey,
  WorldId,
  type WorldSettings,
  WorldSpec,
} from "@aye/schema";
import { z } from "zod";

export const QuestionJob = z.strictObject({
  worldId: WorldId,
  placeKey: SpecKey,
  /** Their words: data, never instructions. */
  question: z.string().min(1).max(500),
  nonce: z.string().regex(/^[0-9a-z]{6,32}$/),
});
export type QuestionJob = z.infer<typeof QuestionJob>;

export type QuestionResult = { ok: true; answer: WorldAnswer } | { ok: false };

export interface QuestionJobDeps {
  db: Db;
  store: ArtifactStore;
  index: RecipeIndex;
  agent: WorldAgent;
  signal?: AbortSignal;
}

const ref = (hash: string) => ({
  hash: hash as ArtifactHash,
  mediaType: "application/json",
  bytes: 0,
});

export async function runQuestionJob(
  job: QuestionJob,
  deps: QuestionJobDeps,
): Promise<QuestionResult> {
  const world = await systemGetWorld(deps.db, job.worldId);
  const pinned = await systemGetPinnedPlace(deps.db, job.worldId, job.placeKey);
  if (!world || !pinned?.spec) return { ok: false };
  const scene = Scene.parse(await readJson(deps.store, ref(pinned.scene)));
  const spec = WorldSpec.parse(await readJson(deps.store, ref(pinned.spec)));
  const { answer } = await askWorld(
    {
      scene,
      spec,
      settings: world.settings as WorldSettings,
      question: job.question,
      sceneHash: pinned.scene,
      specHash: pinned.spec,
    },
    {
      agent: deps.agent,
      store: deps.store,
      index: deps.index,
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
  );
  return { ok: true, answer };
}
