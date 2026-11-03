/**
 * A real place joins a city. Someone films somewhere; this runs what they filmed through the
 * recording pipeline (frames sampled and redacted on our side, SAM 3.1, the understander), has
 * the world harness write how it works, chooses library looks for what's in it, paints its
 * real surfaces and things with Muse Image, has a model decide how it fits this city, pins it
 * in, and adds it to the city's spec.
 *
 * It's a real place, so nothing is invented in it: it gets looks for what was filmed, but no
 * set dressing. Only what's derived from redacted frames ever reaches other players: the scene
 * and the world. The video itself stays linked to its capture alone.
 *
 * The city is swapped in with compare-and-set: the director may change it at the same moment,
 * and neither may lose the other's work.
 *
 * Trusted job: the API has checked who's asking, and that they play here.
 */
import { type ArtifactStore, encodeJson, hashJson } from "@aye/artifacts";
import {
  type Db,
  PgRecipeIndex,
  systemGetCapture,
  systemGetWorld,
  systemLinkWorldArtifacts,
  systemRecordArtifacts,
  systemSetCapturePhase,
  systemSetCaptureStatus,
  systemSwapWorldCity,
} from "@aye/db";
import {
  authorWorld,
  briefFor,
  type CaptureProviders,
  type CityJoiner,
  compilePlace,
  type Describer,
  type Furnisher,
  furnishWorld,
  joinableKinds,
  joinCity,
  type Painter,
  paintPlace,
  readJson,
  type WorldAuthor,
} from "@aye/pipeline";
import {
  type ArtifactHash,
  type ArtifactRef,
  CaptureId,
  CitySpec,
  type Item,
  LIBRARY_CATALOG,
  type PlaceId,
  type PlaceRevision,
  Scene,
  type UserId,
  WorldId,
  WorldSpec,
} from "@aye/schema";
import { evaluateWorld } from "@aye/sim";
import { z } from "zod";
import { directStep, EVAL_SETTINGS, type StepRunner } from "./compile-job.ts";
import { commitAndPin } from "./pin.ts";

export const CaptureJob = z.strictObject({
  worldId: WorldId,
  captureId: CaptureId,
  /** What the person who filmed it said about it. Their words: data, never instructions. */
  note: z.string().max(300),
  /** Where they put it on the city's map, metres. */
  at: z.tuple([z.number(), z.number()]),
});
export type CaptureJob = z.infer<typeof CaptureJob>;

export interface CaptureJobDeps {
  db: Db;
  store: ArtifactStore;
  providers: {
    capture: CaptureProviders;
    describer: Describer;
    author: WorldAuthor;
    joiner: CityJoiner;
    furnisher?: Furnisher;
    painter?: Painter;
  };
  signal: AbortSignal;
  step?: StepRunner;
}

const jsonRef = (hash: string): ArtifactRef => ({
  hash: hash as ArtifactHash,
  mediaType: "application/json",
  bytes: 0,
});

/** What they said about it, if this short, is what it's called; longer is a description. */
const NAME_CHARS = 50;

/** How many times to try adding to the city if someone else changes it at the same moment. */
const SWAP_TRIES = 6;

export async function runCaptureJob(
  raw: unknown,
  deps: CaptureJobDeps,
): Promise<{ placeKey: string } | null> {
  const job = CaptureJob.parse(raw);
  const step = deps.step ?? directStep;
  const index = new PgRecipeIndex(deps.db);
  const phase = (name: string) =>
    step(`phase:${name}`, () => systemSetCapturePhase(deps.db, job.captureId, name));

  const target = await step("load", async () => {
    const capture = await systemGetCapture(deps.db, job.captureId);
    const world = await systemGetWorld(deps.db, job.worldId);
    if (!capture || !world?.city || capture.worldId !== job.worldId) return null;
    return {
      ownerId: capture.ownerId as UserId,
      placeId: capture.placeId as PlaceId,
      city: world.city as ArtifactHash,
      video: {
        hash: capture.video,
        mediaType: capture.mediaType,
        bytes: capture.videoBytes,
      } satisfies ArtifactRef,
    };
  });
  if (!target) return null;

  try {
    await step("start", () => systemSetCaptureStatus(deps.db, job.captureId, "processing"));
    const city = CitySpec.parse(await readJson(deps.store, jsonRef(target.city)));

    await phase("seeing");
    const layout = await step(
      "layout",
      async () => {
        const r = await compilePlace(
          { kind: "recording", captureId: job.captureId, video: target.video },
          {
            store: deps.store,
            index,
            capture: deps.providers.capture,
            describer: deps.providers.describer,
            signal: deps.signal,
          },
        );
        return { sceneRef: r.sceneRef, place: r.place, frames: r.frames };
      },
      { retries: 3 },
    );

    await phase("writing");
    const written = await step(
      "world",
      async () => {
        const scene = Scene.parse(await readJson(deps.store, layout.sceneRef));
        const w = await authorWorld(
          {
            scene,
            sceneHash: layout.sceneRef.hash,
            brief: briefFor({
              scene,
              name: layout.place.name,
              summary: layout.place.summary,
              description: job.note,
              filmed: true,
              currency: city.currency,
              city: {
                line: `${city.name}: ${city.tagline}`,
                needs: city.needs,
                marks: city.marks,
                hourPay: city.economy.hourPay,
              },
            }),
          },
          {
            author: deps.providers.author,
            store: deps.store,
            index,
            signal: deps.signal,
            maxRounds: 3,
            untilNoErrors: true,
            // A whole day: a few hours can't show what people end up doing over and over.
            critique: (s) => evaluateWorld(scene, s, EVAL_SETTINGS, { hours: 24 }).findings,
          },
        );
        if (!w.specRef || w.findings.some((f) => f.severity === "error")) return null;
        return { specRef: w.specRef };
      },
      { retries: 3 },
    );
    if (!written) throw new Error("that place couldn't be made to work");

    await phase("furnishing");
    const specRef = await step(
      "furnish",
      async () => {
        const furnisher = deps.providers.furnisher;
        if (!furnisher) return written.specRef;
        const scene = Scene.parse(await readJson(deps.store, layout.sceneRef));
        const spec = WorldSpec.parse(await readJson(deps.store, written.specRef));
        // Looks are a nicety: without them the place still works.
        const looked = await furnishWorld(spec, scene, {
          furnisher,
          store: deps.store,
          index,
          catalog: LIBRARY_CATALOG,
          panels: city.ui.panels,
          signal: deps.signal,
        }).catch(() => null);
        return looked
          ? await deps.store.put(encodeJson(looked.spec), "application/json")
          : written.specRef;
      },
      { retries: 2 },
    );

    await phase("painting");
    const painted = await step(
      "paint",
      async () => {
        const painter = deps.providers.painter;
        if (!painter || !layout.frames) return { specRef, images: [] as ArtifactRef[] };
        const scene = Scene.parse(await readJson(deps.store, layout.sceneRef));
        const spec = WorldSpec.parse(await readJson(deps.store, specRef));
        // Pictures are a nicety too: without them it's still the place, in library looks.
        const r = await paintPlace(spec, scene, layout.frames, {
          painter,
          store: deps.store,
          index,
          signal: deps.signal,
        }).catch((e: unknown) => {
          // Status and kind only: a model's error never carries anything else.
          console.warn(
            `capture ${job.captureId}: painting failed: ${e instanceof Error ? e.message.slice(0, 160) : "unknown"}`,
          );
          return null;
        });
        if (!r) return { specRef, images: [] as ArtifactRef[] };
        if (r.problems.length > 0) {
          console.warn(`capture ${job.captureId}: painting: ${r.problems.join("; ")}`);
        }
        return {
          specRef: await deps.store.put(encodeJson(r.spec), "application/json"),
          images: r.images,
        };
      },
      { retries: 2 },
    );

    await phase("joining");
    const item = await step(
      "join",
      async (): Promise<Item | null> => {
        const scene = Scene.parse(await readJson(deps.store, layout.sceneRef));
        const xs = scene.levels.flatMap((l) => l.footprint.map((p) => p[0]));
        const zs = scene.levels.flatMap((l) => l.footprint.map((p) => p[1]));
        const joined = await joinCity(
          {
            city: `${city.name}: ${city.tagline}`,
            kinds: joinableKinds(city).map((k) => ({
              name: k.name,
              about: k.about,
              tags: k.traits.place?.tags ?? [],
            })),
            place: {
              name: layout.place.name,
              summary: layout.place.summary,
              things: scene.objects.map((o) => o.label).slice(0, 40),
            },
            note: job.note,
          },
          city,
          {
            captureId: job.captureId,
            ...(job.note.trim() && job.note.length <= NAME_CHARS ? { calledIt: job.note } : {}),
            at: job.at,
            footprintM: [
              (Math.max(...xs) - Math.min(...xs)) / 1000,
              (Math.max(...zs) - Math.min(...zs)) / 1000,
            ],
            build: layout.place.summary,
          },
          { joiner: deps.providers.joiner, store: deps.store, index, signal: deps.signal },
        );
        return joined?.item ?? null;
      },
      { retries: 3 },
    );
    if (!item) throw new Error("this city has nowhere to put it");

    await step("pin", async () => {
      const scene = Scene.parse(await readJson(deps.store, layout.sceneRef));
      await systemRecordArtifacts(deps.db, [layout.sceneRef, painted.specRef, ...painted.images]);
      const rev: PlaceRevision = {
        placeId: target.placeId,
        parent: null,
        base: layout.sceneRef,
        edits: [],
        scene: layout.sceneRef,
        world: { spec: painted.specRef, approved: false },
        authorId: target.ownerId,
        message: `Filmed for ${city.name}`,
        createdAt: new Date().toISOString(),
      };
      const pinned = await commitAndPin(
        deps.db,
        { worldId: job.worldId, key: item.key, ownerId: target.ownerId },
        rev,
        scene,
      );
      if (!pinned) throw new Error("couldn't save the place");
      // What everyone in the city may read: the scene, its world and the pictures made from
      // redacted frames. Never the video.
      await systemLinkWorldArtifacts(deps.db, job.worldId, [
        layout.sceneRef.hash,
        painted.specRef.hash,
        ...painted.images.map((i) => i.hash),
      ]);
    });

    // Into the city's spec, on top of whatever it is now.
    const joined = await step("add-to-city", async () => {
      for (let t = 0; t < SWAP_TRIES; t++) {
        const world = await systemGetWorld(deps.db, job.worldId);
        if (!world?.city) return false;
        const now = CitySpec.parse(await readJson(deps.store, jsonRef(world.city)));
        if (now.items.some((i) => i.key === item.key)) return true;
        const next = CitySpec.parse({ ...now, items: [...now.items, item] });
        const ref = await deps.store.put(encodeJson(next), "application/json");
        await systemRecordArtifacts(deps.db, [ref]);
        await systemLinkWorldArtifacts(deps.db, job.worldId, [ref.hash]);
        if (await systemSwapWorldCity(deps.db, job.worldId, world.city as ArtifactHash, ref.hash)) {
          return true;
        }
      }
      return false;
    });
    if (!joined) throw new Error("the city was too busy to take it");

    await step("finish", async () => {
      await systemSetCapturePhase(deps.db, job.captureId, "ready", item.key);
      await systemSetCaptureStatus(deps.db, job.captureId, "ready");
    });
    return { placeKey: item.key };
  } catch (error) {
    await step("fail", async () => {
      await systemSetCapturePhase(deps.db, job.captureId, "failed");
      await systemSetCaptureStatus(deps.db, job.captureId, "failed");
    });
    throw error;
  }
}

/** The id a capture's job runs under: once per capture. */
export const captureWorkflowId = (captureId: string) => `capture-${hashJson(captureId).slice(-16)}`;
