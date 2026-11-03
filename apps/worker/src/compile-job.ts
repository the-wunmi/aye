/**
 * Building a place: lay it out (from a recording or a description), have the world harness
 * write and play-test its world, then commit both as a new revision of the place. The owner's
 * existing edits are replayed onto the fresh layout (a rebase), so better models never
 * discard user work, and the world arrives unapproved until the owner says otherwise.
 *
 * Written against a `step` runner so it runs as a durable DBOS workflow in production (each
 * step checkpointed, retried, resumed after a crash) and as plain async code in tests.
 * Rules for durable workflows: anything non-deterministic (random ids, clocks, I/O) happens
 * inside a step, and steps return small JSON values (refs, not scenes).
 *
 * Model calls are memoised by recipe, so a retried step replays finished stages from cache
 * with zero model calls.
 */
import { type ArtifactStore, encodeJson, hashJson, randomId } from "@aye/artifacts";
import {
  type Db,
  PgRecipeIndex,
  systemCommitRevision,
  systemGetCapture,
  systemGetHead,
  systemGetPlaceOwner,
  systemRecordArtifacts,
  systemRecordRun,
  systemSetCaptureStatus,
} from "@aye/db";
import {
  authorWorld,
  briefFor,
  type CaptureProviders,
  compilePlace,
  type Describer,
  readJson,
  type WorldAuthor,
} from "@aye/pipeline";
import {
  ACTION_MAX_REAL_SEC,
  type ArtifactHash,
  type ArtifactRef,
  applyEdits,
  CaptureId,
  CurrencyCode,
  PlaceId,
  type PlaceRevision,
  Scene,
  type StageRecord,
  TRIP_MAX_REAL_SEC,
  type UserId,
  type WorldSettings,
} from "@aye/schema";
import { evaluateWorld } from "@aye/sim";
import { z } from "zod";

/** Job payloads are re-validated on every invocation: the queue is a trust boundary too. */
export const CompileJob = z.strictObject({
  source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("recording"), captureId: CaptureId }),
    z.strictObject({
      kind: z.literal("description"),
      placeId: PlaceId,
      text: z.string().min(1).max(4_000),
    }),
  ]),
  /** The money people there use; by default, what the model judged from the source. */
  currency: CurrencyCode.optional(),
});
export type CompileJob = z.infer<typeof CompileJob>;

/** How worlds are play-tested before they are offered: the defaults new worlds get. */
export const EVAL_SETTINGS: WorldSettings = {
  seed: 1,
  gridCellMm: 100,
  startMinuteOfDay: 6 * 60,
  ticksPerRealSecond: 30,
  tripMaxRealSec: TRIP_MAX_REAL_SEC,
  actionMaxRealSec: ACTION_MAX_REAL_SEC,
};

export interface StepOptions {
  retries?: number;
}
/** Runs `fn` as a named, checkpointed step. The default runs it directly. */
export type StepRunner = <T>(name: string, fn: () => Promise<T>, opts?: StepOptions) => Promise<T>;
export const directStep: StepRunner = (_name, fn) => fn();

export interface Providers {
  capture: CaptureProviders;
  describer: Describer;
  author: WorldAuthor;
}

export interface CompileJobDeps {
  db: Db;
  store: ArtifactStore;
  providers: Providers;
  signal: AbortSignal;
  step?: StepRunner;
}

export async function runCompileJob(
  raw: unknown,
  deps: CompileJobDeps,
): Promise<{ revision: ArtifactHash } | null> {
  const job = CompileJob.parse(raw);
  const step = deps.step ?? directStep;
  const index = new PgRecipeIndex(deps.db);

  // Whose place this is, and where the layout comes from.
  const target = await step("load", async () => {
    if (job.source.kind === "description") {
      const owner = await systemGetPlaceOwner(deps.db, job.source.placeId);
      return owner && { placeId: job.source.placeId, ownerId: owner, capture: null };
    }
    const row = await systemGetCapture(deps.db, job.source.captureId);
    return (
      row && {
        placeId: row.placeId as PlaceId,
        ownerId: row.ownerId as UserId,
        capture: {
          id: row.id as CaptureId,
          video: {
            hash: row.video,
            mediaType: row.mediaType,
            bytes: row.videoBytes,
          } satisfies ArtifactRef,
        },
      }
    );
  });
  if (!target) return null;
  const capture = target.capture;

  const pipelineHash = hashJson({ pipeline: "place.build", version: 2 });
  const runId = capture
    ? await step("start-run", async () => {
        const id = randomId("run");
        await systemSetCaptureStatus(deps.db, capture.id, "processing");
        await systemRecordRun(deps.db, {
          id,
          captureId: capture.id,
          pipelineHash,
          status: "running",
          stages: [],
          scene: null,
          error: null,
        });
        return id;
      })
    : null;

  try {
    const compiled = await step(
      "layout",
      async () => {
        const result = await compilePlace(
          capture
            ? { kind: "recording", captureId: capture.id, video: capture.video }
            : {
                kind: "description",
                text: job.source.kind === "description" ? job.source.text : "",
              },
          {
            store: deps.store,
            index,
            capture: deps.providers.capture,
            describer: deps.providers.describer,
            signal: deps.signal,
          },
        );
        return {
          sceneRef: result.sceneRef,
          place: result.place,
          stages: result.stages as StageRecord[],
        };
      },
      { retries: 3 },
    );

    // The world for the generated layout, written for the base scene so owner edits never
    // trigger a new model call. Offered only if play-testing finds nothing broken.
    const world = await step(
      "world",
      async () => {
        const base = Scene.parse(await readJson(deps.store, compiled.sceneRef));
        const result = await authorWorld(
          {
            scene: base,
            sceneHash: compiled.sceneRef.hash,
            brief: briefFor({
              scene: base,
              name: compiled.place.name,
              summary: compiled.place.summary,
              description: job.source.kind === "description" ? job.source.text : "",
              currency: job.currency ?? compiled.place.currency,
            }),
          },
          {
            author: deps.providers.author,
            store: deps.store,
            index,
            signal: deps.signal,
            critique: (spec) => evaluateWorld(base, spec, EVAL_SETTINGS).findings,
          },
        );
        const broken = result.findings.some((f) => f.severity === "error");
        return {
          specRef: broken ? null : result.specRef,
          findings: result.findings,
          stages: result.stages as StageRecord[],
        };
      },
      { retries: 3 },
    );

    const revision = await step("rebase-and-commit", async () => {
      const base = Scene.parse(await readJson(deps.store, compiled.sceneRef));
      const head = await systemGetHead(deps.db, target.placeId);
      const edits = head?.edits ?? [];
      const { scene } = applyEdits(base, edits);
      const sceneRef =
        edits.length === 0
          ? compiled.sceneRef
          : await deps.store.put(encodeJson(scene), "application/json");
      const spec = world.specRef ? [world.specRef] : [];
      await systemRecordArtifacts(deps.db, [compiled.sceneRef, sceneRef, ...spec]);

      const rev: PlaceRevision = {
        placeId: target.placeId,
        parent: head?.head ?? null,
        base: compiled.sceneRef,
        edits,
        scene: sceneRef,
        world: world.specRef ? { spec: world.specRef, approved: false } : null,
        authorId: target.ownerId,
        message: capture ? `Built from capture ${capture.id}` : "Built from a description",
        createdAt: new Date().toISOString(),
      };
      const hash = hashJson(rev);
      await systemCommitRevision(deps.db, target.ownerId, hash, rev, scene);
      return { hash, sceneHash: sceneRef.hash };
    });

    if (capture && runId) {
      await step("finish", async () => {
        await systemRecordRun(deps.db, {
          id: runId,
          captureId: capture.id,
          pipelineHash,
          status: "succeeded",
          stages: [...compiled.stages, ...world.stages],
          scene: revision.sceneHash,
          error: null,
        });
        await systemSetCaptureStatus(deps.db, capture.id, "ready");
      });
    }
    return { revision: revision.hash };
  } catch (error) {
    if (capture && runId) {
      // Store a bounded, non-sensitive message; full detail goes to logs.
      const message = error instanceof Error ? error.message.slice(0, 2000) : "unknown error";
      await step("fail", async () => {
        await systemRecordRun(deps.db, {
          id: runId,
          captureId: capture.id,
          pipelineHash,
          status: "failed",
          stages: [],
          scene: null,
          error: message,
        });
        await systemSetCaptureStatus(deps.db, capture.id, "failed");
      });
    }
    throw error;
  }
}
