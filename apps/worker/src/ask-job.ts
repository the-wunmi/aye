/**
 * Asking a thing for something new, in a live world: "can I wash this?". The improvise harness
 * has the model rewrite that thing's kind (new state, steps and looks), the simulation plays
 * the whole place with it, its look is dressed like any other, and the new world is committed
 * as the place's next revision and pinned into the city. Rooms playing the place pick it up.
 *
 * The request is the player's words: data for the model, never instructions to us. The API
 * has already checked the player may play this world and rate-limited them.
 */
import { type ArtifactStore, encodeJson } from "@aye/artifacts";
import {
  type Db,
  PgRecipeIndex,
  systemGetHead,
  systemGetPinnedPlace,
  systemGetWorld,
  systemRecordArtifacts,
} from "@aye/db";
import {
  briefFor,
  dressWorld,
  improvise,
  type LookCritic,
  type LookDesigner,
  readJson,
  type WorldAuthor,
} from "@aye/pipeline";
import {
  CitySpec,
  ObjectId,
  type PlaceRevision,
  Scene,
  SpecKey,
  type UserId,
  WorldId,
  WorldSpec,
} from "@aye/schema";
import { evaluateWorld } from "@aye/sim";
import { z } from "zod";
import { directStep, EVAL_SETTINGS, type StepRunner } from "./compile-job.ts";
import { commitAndPin } from "./pin.ts";

export const AskJob = z.strictObject({
  worldId: WorldId,
  place: SpecKey,
  object: ObjectId,
  request: z.string().trim().min(2).max(300),
  /** A nonce: every ask is its own job. */
  nonce: z.string().regex(/^[0-9a-z]{6,32}$/),
});
export type AskJob = z.infer<typeof AskJob>;

export interface AskProviders {
  author: WorldAuthor;
  critic: LookCritic;
  designer: LookDesigner;
}

export type AskResult =
  | { ok: true; thing: string; added: string[] }
  | { ok: false; reason: string };

export async function runAskJob(
  raw: unknown,
  deps: {
    db: Db;
    store: ArtifactStore;
    providers: AskProviders;
    signal: AbortSignal;
    step?: StepRunner;
  },
): Promise<AskResult> {
  const job = AskJob.parse(raw);
  const step = deps.step ?? directStep;
  const index = new PgRecipeIndex(deps.db);

  return step(
    "improvise",
    async (): Promise<AskResult> => {
      const world = await systemGetWorld(deps.db, job.worldId);
      const pinned = await systemGetPinnedPlace(deps.db, job.worldId, job.place);
      if (!world?.city || !pinned?.spec) return { ok: false, reason: "that place isn't built" };
      const [city, scene, spec] = await Promise.all([
        readJson(deps.store, { hash: world.city, mediaType: "application/json", bytes: 0 }).then(
          (j) => CitySpec.parse(j),
        ),
        readJson(deps.store, { hash: pinned.scene, mediaType: "application/json", bytes: 0 }).then(
          (j) => Scene.parse(j),
        ),
        readJson(deps.store, { hash: pinned.spec, mediaType: "application/json", bytes: 0 }).then(
          (j) => WorldSpec.parse(j),
        ),
      ]);
      const before = spec.kinds.find(
        (k) => k.key === spec.things.find((t) => t.object === job.object)?.kind,
      );
      if (!before)
        return { ok: false, reason: "that one's your own, so ask for it under Make it yours" };
      const critique = (s: WorldSpec) => evaluateWorld(scene, s, EVAL_SETTINGS).findings;
      const result = await improvise(
        {
          scene,
          spec,
          brief: briefFor({
            scene,
            name: spec.name,
            summary: spec.summary,
            description: "",
            currency: spec.currency,
            city: {
              line: `${city.name}: ${city.tagline}`,
              needs: city.needs,
              marks: city.marks,
              hourPay: spec.hourPay,
            },
          }),
          object: job.object,
          request: job.request,
        },
        { author: deps.providers.author, store: deps.store, index, signal: deps.signal, critique },
      );
      if (result.findings.some((f) => f.severity === "error")) {
        return { ok: false, reason: "that would break this place" };
      }
      const added = result.kind.actions
        .filter((a) => !before.actions.some((b) => b.key === a.key))
        .map((a) => a.label);
      // A new way to get around the city counts too (the ride was there; now it goes places).
      if (result.kind.travel && !before.travel) added.push("Gets you around the city");
      if (added.length === 0) return { ok: false, reason: "that isn't something this can do" };
      // Only what changed, and only if its look did: the player is standing there waiting, and
      // everything else in the place was judged when it was built.
      const lookOf = (k: { look: unknown }) => JSON.stringify(k.look);
      const dressed =
        lookOf(result.kind) === lookOf(before)
          ? { spec: result.spec }
          : await dressWorld(result.spec, scene, {
              onlyKinds: [result.kind.key],
              maxRedesigns: 1,
              critic: deps.providers.critic,
              designer: deps.providers.designer,
              store: deps.store,
              index,
              signal: deps.signal,
            });
      const specRef = await deps.store.put(encodeJson(dressed.spec), "application/json");
      await systemRecordArtifacts(deps.db, [specRef]);
      const ownerId = (await systemGetHead(deps.db, pinned.placeId))?.ownerId as UserId;
      if (!ownerId) return { ok: false, reason: "that didn't work" };
      const sceneRef = {
        hash: pinned.scene,
        mediaType: "application/json",
        bytes: encodeJson(scene).byteLength,
      };
      const baseRef =
        pinned.base === pinned.scene
          ? sceneRef
          : { hash: pinned.base, mediaType: "application/json", bytes: 0 };
      const rev: PlaceRevision = {
        placeId: pinned.placeId as PlaceRevision["placeId"],
        parent: pinned.revision,
        base: baseRef,
        edits: pinned.edits,
        scene: sceneRef,
        world: { spec: specRef, approved: false },
        authorId: ownerId,
        message: `Someone asked: ${job.request.slice(0, 120)}`,
        createdAt: new Date().toISOString(),
      };
      // The place's owner, who may not be the city's: whoever filmed it keeps it.
      const saved = await commitAndPin(
        deps.db,
        { worldId: job.worldId, key: job.place, ownerId },
        rev,
        scene,
      );
      if (!saved) return { ok: false, reason: "that didn't work" };
      return { ok: true, thing: result.kind.label, added };
    },
    { retries: 2 },
  ).catch(() => ({ ok: false, reason: "that didn't work" }) as const);
}
