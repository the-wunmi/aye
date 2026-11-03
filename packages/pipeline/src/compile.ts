/**
 * compilePlace: a description or a recording → a place's layout, as memoised stages.
 *
 *   words ─ describe ──────────────────────────────────────────────┐
 *                                                                  ├─ assemble ─ scene
 *   video ─ sample ─ frames ─ track ─ redact ─ redacted ─ understand ┘
 *
 * Either source is first-class. A recording's raw frames reach only the sampler, the
 * segmenter and the redactor; `understand` takes redacted frames only. What the
 * place's things are and do comes after, from the world harness (world.ts).
 *
 * Each stage is keyed by its recipe: compiling the same description or recording again makes
 * zero model calls and yields identical bytes.
 */
import { type ArtifactStore, deriveId, hashBytes, type RecipeIndex } from "@aye/artifacts";
import { type ArtifactRef, type CaptureId, Scene, type StageRecord } from "@aye/schema";
import { ASSEMBLER_VERSION, assembleScene, cleanText } from "./assemble.ts";
import { FrameSet, type RedactedFrameSet, SceneUnderstanding, TrackSet } from "./contracts.ts";
import { cutOffSpaceNames, layoutFindings, walkFindings, withoutSpaces } from "./layout-check.ts";
import type { CaptureProviders, Describer } from "./providers.ts";
import { json, readJson, runStage, type StageDeps, type StageOutput } from "./stage.ts";

export class PipelineError extends Error {
  readonly stage: string;

  constructor(stage: string, message: string) {
    super(`${stage}: ${message}`);
    this.name = "PipelineError";
    this.stage = stage;
  }
}

export type PlaceSource =
  | { kind: "description"; text: string }
  | { kind: "recording"; captureId: CaptureId; video: ArtifactRef };

export interface CompileDeps {
  store: ArtifactStore;
  index: RecipeIndex;
  /** Needed for descriptions. */
  describer?: Describer;
  /** Needed for recordings. */
  capture?: CaptureProviders;
  signal?: AbortSignal;
  onStage?: StageDeps["onStage"];
}

export interface CompileResult {
  scene: Scene;
  sceneRef: ArtifactRef;
  /** The place's name, summary and local currency, as the model judged them. */
  place: { name: string; summary: string; currency: string };
  /** Redacted keyframes of a recording, safe to show anyone; null for descriptions. */
  frames: RedactedFrameSet | null;
  stages: StageRecord[];
  /** How many stages were served from cache; equals stages.length on an unchanged re-run. */
  cached: number;
}

const STAGE_VERSION = {
  describe: 2,
  sample: 1,
  track: 1,
  redact: 1,
  understand: 3,
  review: 2,
  connect: 1,
} as const;

/** How many times the model gets to connect what can't be walked to. */
const CONNECT_ROUNDS = 3;

export async function compilePlace(source: PlaceSource, deps: CompileDeps): Promise<CompileResult> {
  const signal = deps.signal ?? new AbortController().signal;
  const { store } = deps;
  const stageDeps: StageDeps = {
    store,
    index: deps.index,
    signal,
    ...(deps.onStage ? { onStage: deps.onStage } : {}),
  };
  const ctx = (seed: number) => ({ store, seed, signal });
  const stages: StageRecord[] = [];
  let cached = 0;
  const run = async <K extends string>(
    spec: Parameters<typeof runStage>[0],
    exec: (seed: number) => Promise<Record<K, StageOutput>>,
  ) => {
    const result = await runStage(spec, stageDeps, exec);
    stages.push(result.record);
    if (result.cached) cached++;
    return result;
  };
  const parsed = async <T>(
    stage: string,
    schema: {
      safeParse(
        v: unknown,
      ):
        | { success: true; data: T }
        | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
    },
    value: unknown,
  ): Promise<T> => {
    const result = schema.safeParse(value);
    if (!result.success) {
      const first = result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.map(String).join(".")}: ${i.message}`);
      throw new PipelineError(stage, `invalid output — ${first.join("; ")}`);
    }
    return result.data;
  };

  let understandingRef: ArtifactRef;
  let tracks: TrackSet = { tracks: [] };
  let tracksHash: ArtifactRef["hash"] | null = null;
  let frames: RedactedFrameSet | null = null;
  let captureId: CaptureId;

  if (source.kind === "description") {
    const describer = deps.describer;
    if (!describer) throw new PipelineError("describe", "no describer configured");
    const text = cleanText(source.text, 4_000);
    if (!text) throw new PipelineError("describe", "the description is empty");
    const textRef = await store.put(new TextEncoder().encode(text), "text/plain");
    captureId = deriveId("capture", [
      "description",
      hashBytes(new TextEncoder().encode(text)),
    ]) as CaptureId;
    const described = await run<"understanding">(
      {
        stage: "describe",
        version: STAGE_VERSION.describe,
        model: describer.model,
        prompt: describer.prompt,
        inputs: { description: textRef.hash },
        params: {},
      },
      async (seed) => ({
        understanding: json(
          await parsed("describe", SceneUnderstanding, await describer.describe(text, ctx(seed))),
        ),
      }),
    );
    understandingRef = described.outputs.understanding;
  } else {
    const p = deps.capture;
    if (!p) throw new PipelineError("sample", "no capture providers configured");
    captureId = source.captureId;
    // 1. Keyframes (our infrastructure).
    const sample = await run<"frames">(
      {
        stage: "sample",
        version: STAGE_VERSION.sample,
        model: p.sampler.model,
        prompt: null,
        inputs: { video: source.video.hash },
        params: {},
      },
      async (seed) => ({
        frames: json(FrameSet.parse(await p.sampler.sample(source.video, ctx(seed)))),
      }),
    );
    const framesRef = sample.outputs.frames;
    const raw = await parsed("sample", FrameSet, await readJson(store, framesRef));
    // 2. Find what must be hidden (the one call that sees unredacted frames).
    const track = await run<"tracks">(
      {
        stage: "track",
        version: STAGE_VERSION.track,
        model: p.segmenter.model,
        prompt: null,
        inputs: { frames: framesRef.hash },
        params: {},
      },
      async (seed) => ({ tracks: json(TrackSet.parse(await p.segmenter.track(raw, ctx(seed)))) }),
    );
    tracksHash = track.outputs.tracks.hash;
    tracks = await parsed("track", TrackSet, await readJson(store, track.outputs.tracks));
    // 3. Hide it (our infrastructure).
    const redact = await run<"frames">(
      {
        stage: "redact",
        version: STAGE_VERSION.redact,
        model: p.redactor.model,
        prompt: null,
        inputs: { frames: framesRef.hash, tracks: tracksHash },
        params: {},
      },
      async (seed) => ({
        frames: json(FrameSet.parse(await p.redactor.redact(raw, tracks, ctx(seed)))),
      }),
    );
    frames = (await parsed(
      "redact",
      FrameSet,
      await readJson(store, redact.outputs.frames),
    )) as RedactedFrameSet;
    const redacted = frames;
    const publicTracks: TrackSet = { tracks: tracks.tracks.filter((t) => !t.private) };
    // 4. Read the place from redacted frames only.
    const understand = await run<"understanding">(
      {
        stage: "understand",
        version: STAGE_VERSION.understand,
        model: p.understander.model,
        prompt: p.understander.prompt,
        inputs: { frames: redact.outputs.frames.hash, tracks: tracksHash },
        params: {},
      },
      async (seed) => ({
        understanding: json(
          await parsed(
            "understand",
            SceneUnderstanding,
            await p.understander.understand(redacted, publicTracks, ctx(seed)),
          ),
        ),
      }),
    );
    understandingRef = understand.outputs.understanding;
    // 5. Look again, with the first map and what code found in it: what's really in the video?
    const review = p.understander.review;
    if (review) {
      const first = await parsed(
        "understand",
        SceneUnderstanding,
        await readJson(store, understand.outputs.understanding),
      );
      const reviewed = await run<"understanding">(
        {
          stage: "review",
          version: STAGE_VERSION.review,
          model: p.understander.model,
          prompt: p.understander.reviewPrompt ?? null,
          inputs: {
            frames: redact.outputs.frames.hash,
            understanding: understand.outputs.understanding.hash,
          },
          params: {},
        },
        async (seed) => ({
          understanding: json(
            await parsed(
              "review",
              SceneUnderstanding,
              await review.call(p.understander, redacted, first, layoutFindings(first), ctx(seed)),
            ),
          ),
        }),
      );
      understandingRef = reviewed.outputs.understanding;
    }
  }

  // 6. Code walks the place: every space has to be reachable, and the model fixes what isn't
  // until it is. What it says goes back as findings; how to connect things is the model's.
  let understanding = await parsed(
    "understand",
    SceneUnderstanding,
    await readJson(store, understandingRef),
  );
  const assembled = (u: SceneUnderstanding) =>
    Scene.parse(assembleScene({ captureId, understanding: u, tracks }));
  const fixer = frames
    ? (() => {
        const review = (deps.capture as CaptureProviders).understander.review;
        const redactedFrames = frames;
        return review
          ? {
              model: (deps.capture as CaptureProviders).understander.model,
              prompt: (deps.capture as CaptureProviders).understander.reviewPrompt ?? null,
              fix: (u: SceneUnderstanding, found: readonly string[], seed: number) =>
                review.call(
                  (deps.capture as CaptureProviders).understander,
                  redactedFrames,
                  u,
                  found,
                  ctx(seed),
                ),
            }
          : null;
      })()
    : (() => {
        const d = deps.describer;
        const revise = d?.revise;
        const text = source.kind === "description" ? cleanText(source.text, 4_000) : "";
        return d && revise
          ? {
              model: d.model,
              prompt: d.revisePrompt ?? null,
              fix: (u: SceneUnderstanding, found: readonly string[], seed: number) =>
                revise.call(d, text, u, found, ctx(seed)),
            }
          : null;
      })();
  for (let round = 0; fixer && round < CONNECT_ROUNDS; round++) {
    const found = walkFindings(assembled(understanding));
    if (found.length === 0) break;
    const before = understanding;
    const fixed = await run<"understanding">(
      {
        stage: "connect",
        version: STAGE_VERSION.connect,
        model: fixer.model,
        prompt: fixer.prompt,
        inputs: { understanding: understandingRef.hash },
        params: { round },
      },
      async (seed) => ({
        understanding: json(
          await parsed("connect", SceneUnderstanding, await fixer.fix(before, found, seed)),
        ),
      }),
    );
    understandingRef = fixed.outputs.understanding;
    understanding = await parsed(
      "connect",
      SceneUnderstanding,
      await readJson(store, understandingRef),
    );
  }
  // The last word: a space it never connected isn't part of the place.
  const stranded = cutOffSpaceNames(assembled(understanding));
  if (stranded.length > 0) {
    understanding = withoutSpaces(understanding, stranded);
    understandingRef = await store.put(json(understanding).bytes, "application/json");
  }
  // 5. Assemble a canonical Scene (pure code).
  const assemble = await run<"scene">(
    {
      stage: "assemble",
      version: ASSEMBLER_VERSION,
      model: null,
      prompt: null,
      inputs: {
        understanding: understandingRef.hash,
        ...(tracksHash ? { tracks: tracksHash } : {}),
      },
      params: { captureId },
    },
    async () => ({ scene: json(assembleScene({ captureId, understanding, tracks })) }),
  );
  const sceneRef = assemble.outputs.scene;
  const scene = await parsed("assemble", Scene, await readJson(store, sceneRef));
  return {
    scene,
    sceneRef,
    place: {
      name: cleanText(understanding.place.name, 120),
      summary: cleanText(understanding.place.summary, 500),
      currency: understanding.place.currency,
    },
    frames,
    stages,
    cached,
  };
}
