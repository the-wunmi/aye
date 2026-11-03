/**
 * Provider ports. Each model sits behind one of these so it can be swapped (new model
 * version, self-hosted vs API, fake for tests) without touching stages.
 *
 * Every provider declares an immutable `model` ref. It goes into each stage's recipe, so a
 * model upgrade produces new artifacts instead of silently changing old ones.
 *
 * Trust boundary: FrameSampler and Redactor run on our infrastructure. The
 * Segmenter is the one call that sees unredacted keyframes (finding faces is its job). The
 * Understander and everything after it accept only redacted frames, or no frames at all.
 */

import type { ArtifactStore } from "@aye/artifacts";
import type { ArtifactRef, ModelRef } from "@aye/schema";
import type { z } from "zod";
import type { ArrangeItem } from "./arrange.ts";
import type {
  CityBrief,
  CityDraft,
  DraftKind,
  FrameSet,
  RedactedFrameSet,
  SceneUnderstanding,
  TrackSet,
  WorldBrief,
  WorldDraft,
} from "./contracts.ts";

export interface ProviderContext {
  store: ArtifactStore;
  /** Derived from the recipe; providers must pass it to any sampler that accepts a seed. */
  seed: number;
  signal: AbortSignal;
}

export interface FrameSampler {
  readonly model: ModelRef;
  sample(video: ArtifactRef, ctx: ProviderContext): Promise<FrameSet>;
}

export interface Segmenter {
  readonly model: ModelRef;
  /** Find every private thing (faces, number plates) on every frame. */
  track(frames: FrameSet, ctx: ProviderContext): Promise<TrackSet>;
}

export interface Redactor {
  readonly model: ModelRef;
  /** Hide every private track on every frame. */
  redact(frames: FrameSet, tracks: TrackSet, ctx: ProviderContext): Promise<FrameSet>;
}

/** Reads a recording (redacted frames) into a layout. */
export interface Understander {
  readonly model: ModelRef;
  /** The prompt template text; its hash is part of the recipe. */
  readonly prompt: string;
  /** Returns the layout; the stage validates it against SceneUnderstanding. */
  understand(frames: RedactedFrameSet, tracks: TrackSet, ctx: ProviderContext): Promise<unknown>;
  /** Hashed into the review's recipe. */
  readonly reviewPrompt?: string;
  /**
   * Looks at the frames again with its first map and what code found wrong with it, and returns
   * the whole corrected map (validated like the first). Absent: the first map stands.
   */
  review?(
    frames: RedactedFrameSet,
    first: SceneUnderstanding,
    findings: readonly string[],
    ctx: ProviderContext,
  ): Promise<unknown>;
}

/** Imagines a layout from someone's description of a place. */
export interface Describer {
  readonly model: ModelRef;
  readonly prompt: string;
  describe(description: string, ctx: ProviderContext): Promise<SceneUnderstanding>;
  /** Hashed into the fix's recipe. */
  readonly revisePrompt?: string;
  /** Given its layout and what's wrong with it, returns the whole corrected layout. */
  revise?(
    description: string,
    previous: SceneUnderstanding,
    findings: readonly string[],
    ctx: ProviderContext,
  ): Promise<unknown>;
}

/** What `improvise` gives the author: one kind of thing and what someone wants to do. */
export interface ImproviseRequest {
  /** Index of the thing in the brief's objects. */
  object: number;
  kind: DraftKind;
  needs: string[];
  resources: string[];
  /** The person's words, e.g. "drive it". Data, not instructions. */
  request: string;
}

/** Writes, fixes and extends a place's world. */
export interface WorldAuthor {
  readonly model: ModelRef;
  readonly prompt: string;
  readonly revisePrompt: string;
  readonly improvisePrompt: string;
  /** How hard the model thinks; part of the recipe because it changes the output. */
  readonly effort: string;
  /**
   * How hard it thinks when someone in a place is waiting on an answer (extending one kind):
   * a player is standing there, so this is usually lower than writing a whole world.
   */
  readonly improviseEffort?: string;
  /** Returns raw output; the harness validates it against WorldDraft. */
  author(brief: WorldBrief, ctx: ProviderContext): Promise<unknown>;
  /** Given its last draft and every finding, returns a full revised draft. */
  revise(
    brief: WorldBrief,
    previous: WorldDraft,
    findings: readonly string[],
    ctx: ProviderContext,
  ): Promise<unknown>;
  /** Returns the thing's kind rewritten to cover the request (validated as DraftKind). */
  improvise(brief: WorldBrief, request: ImproviseRequest, ctx: ProviderContext): Promise<unknown>;
}

/** Everything a capture (recording) needs. Words-only places need just a Describer. */
export interface CaptureProviders {
  sampler: FrameSampler;
  segmenter: Segmenter;
  redactor: Redactor;
  understander: Understander;
}

/** Writes and fixes a whole city: its map, travel, needs, starts and interface. */
export interface CityAuthor {
  readonly model: ModelRef;
  readonly prompt: string;
  readonly revisePrompt: string;
  readonly effort: string;
  /** Returns raw output; the harness validates it against CityDraft. */
  author(brief: CityBrief, ctx: ProviderContext): Promise<unknown>;
  revise(
    brief: CityBrief,
    previous: CityDraft,
    findings: readonly string[],
    ctx: ProviderContext,
  ): Promise<unknown>;
}

/** One tile of a contact sheet the critic is shown: what it should be. */
export interface LookItem {
  index: number;
  /** What it is ("Yellow minibus", "A market trader"). Data, not instructions. */
  label: string;
  /** What kind of thing it is in the game: a thing in a place, a person, a building, scenery. */
  role: string;
}

/** Looks at rendered looks and says what doesn't read (a vision model). */
export interface LookCritic {
  readonly model: ModelRef;
  readonly prompt: string;
  readonly effort: string;
  /** Returns raw output; the harness validates it against LookReview. */
  critique(sheet: Uint8Array, items: readonly LookItem[], ctx: ProviderContext): Promise<unknown>;
}

/** Looks at seats in their surroundings and says which way each should face. */
export interface Arranger {
  readonly model: ModelRef;
  readonly prompt: string;
  readonly effort: string;
  /** Returns raw output; the harness validates it against ArrangeAnswer. */
  arrange(sheet: Uint8Array, items: readonly ArrangeItem[], ctx: ProviderContext): Promise<unknown>;
}

/** What a look designer is asked to improve: one look, a picture of it, and what to fix. */
export interface LookDesignRequest {
  label: string;
  role: string;
  /** How this look's coordinates work. */
  frame: string;
  /** The look as it stands, in the shape it must come back in. */
  current: unknown;
  score: number;
  fixes: readonly string[];
}

/** Redesigns one look from a picture of it and an art director's notes (a vision model). */
export interface LookDesigner {
  readonly model: ModelRef;
  readonly prompt: string;
  readonly effort: string;
  /** Returns raw output; the harness validates it against the look's own schema. */
  redesign(request: LookDesignRequest, image: Uint8Array, ctx: ProviderContext): Promise<unknown>;
}

/**
 * Chooses library models, outfits and surfaces. Given the place (or city) and the
 * catalog, and the answer's schema (choices constrained to catalog ids); the stage re-checks.
 */
export interface Furnisher {
  readonly model: ModelRef;
  readonly prompt: string;
  readonly cityPrompt: string;
  /** Dressing a place with more library things (decorate.ts). */
  readonly decoratePrompt: string;
  /** Writing who lives in a city and their days (populate.ts). */
  readonly populatePrompt: string;
  readonly effort: string;
  furnishWorld(
    request: import("./furnish.ts").WorldFurnishRequest,
    schema: z.ZodType,
    ctx: ProviderContext,
  ): Promise<unknown>;
  furnishCity(
    request: import("./furnish.ts").CityFurnishRequest,
    schema: z.ZodType,
    ctx: ProviderContext,
  ): Promise<unknown>;
  decorate(
    request: import("./decorate.ts").DecorateRequest,
    schema: z.ZodType,
    ctx: ProviderContext,
  ): Promise<unknown>;
  populate(
    request: import("./populate.ts").PopulateRequest,
    schema: z.ZodType,
    ctx: ProviderContext,
  ): Promise<unknown>;
}
