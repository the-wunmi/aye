/**
 * Rebuild a filmed place's things in 3D, on a place that already exists: for judging what a
 * reconstructor makes before filming anything new. The frames come from the capture's memoised
 * stages, so only the rebuilding costs anything, and a rerun costs nothing. It writes each model
 * to a folder for looking at, and with `pin` puts them in the place for everyone to see.
 *
 * Usage: pnpm --filter @aye/worker rebuild-place <captureId> <outDir> [pin]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { encodeJson } from "@aye/artifacts";
import { FsArtifactStore } from "@aye/artifacts/node";
import {
  connect,
  PgRecipeIndex,
  systemGetCapture,
  systemGetPinnedPlace,
  systemLinkWorldArtifacts,
  systemRecordArtifacts,
} from "@aye/db";
import {
  compilePlace,
  metaDescriber,
  metaSegmenter,
  metaUnderstander,
  museConfigFrom,
  museReconstructPlanner,
  pixelRedactor,
  readJson,
  reconstructorFrom,
  reconstructPlace,
} from "@aye/pipeline";
import { ffmpegSampler } from "@aye/pipeline/node";
import {
  type ArtifactHash,
  type ArtifactRef,
  CaptureId,
  type PlaceRevision,
  Scene,
  type UserId,
  WorldSpec,
} from "@aye/schema";
import { z } from "zod";
import { commitAndPin } from "../src/pin.ts";

const [captureId, outDir, pinIt] = z
  .tuple([CaptureId, z.string().min(1), z.literal("pin").optional()])
  .parse(process.argv.slice(2));
const { DATABASE_URL } = z
  .object({ DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }) })
  .parse(process.env);
const reconstructor = reconstructorFrom(process.env);
if (!reconstructor) throw new Error("set RECONSTRUCT_PROVIDER first");

const jsonRef = (hash: string): ArtifactRef => ({
  hash: hash as ArtifactHash,
  mediaType: "application/json",
  bytes: 0,
});

const { db, close } = connect(DATABASE_URL, { max: 2 });
try {
  const capture = await systemGetCapture(db, captureId);
  if (!capture?.placeKey || !capture.worldId) throw new Error("that capture never joined a city");
  const store = new FsArtifactStore(
    process.env["AYE_ARTIFACT_DIR"] ?? resolve(import.meta.dirname, "../../../.aye/artifacts"),
  );
  const index = new PgRecipeIndex(db);
  const signal = new AbortController().signal;
  const muse = museConfigFrom(process.env);
  // The same settings as the worker, so the frames replay from its recipes.
  const compiled = await compilePlace(
    {
      kind: "recording",
      captureId,
      video: { hash: capture.video, mediaType: capture.mediaType, bytes: capture.videoBytes },
    },
    {
      store,
      index,
      signal,
      capture: {
        sampler: ffmpegSampler({ frames: 16, width: 768 }),
        segmenter: metaSegmenter(muse),
        redactor: pixelRedactor(),
        understander: metaUnderstander(muse),
      },
      describer: metaDescriber(muse),
    },
  );
  if (!compiled.frames) throw new Error("no frames");
  const owner = capture.ownerId as UserId;
  const pinned = await systemGetPinnedPlace(db, capture.worldId, capture.placeKey);
  if (!pinned?.spec) throw new Error("that place isn't standing");
  const scene = Scene.parse(await readJson(store, jsonRef(pinned.scene)));
  const spec = WorldSpec.parse(await readJson(store, jsonRef(pinned.spec)));

  const started = Date.now();
  const made = await reconstructPlace(spec, scene, compiled.frames, {
    planner: museReconstructPlanner({ ...muse, effort: "low" }),
    reconstructor,
    store,
    index,
    signal,
  });
  console.log(`${made.meshes.length} models in ${Math.round((Date.now() - started) / 1000)} s`);
  for (const problem of made.problems) console.log(`problem: ${problem}`);

  mkdirSync(outDir, { recursive: true });
  for (const t of made.spec.things) {
    if (!t.mesh) continue;
    const bytes = await store.get(t.mesh);
    const label = scene.objects.find((o) => o.id === t.object)?.label ?? t.object;
    const name = `${label.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}-${t.mesh.slice(-6)}.glb`;
    if (bytes) writeFileSync(join(outDir, name), bytes);
    console.log(`${label}: ${Math.round((bytes?.byteLength ?? 0) / 1024)} KB -> ${name}`);
  }

  if (pinIt) {
    const specRef = await store.put(encodeJson(made.spec), "application/json");
    await systemRecordArtifacts(db, [specRef, ...made.meshes]);
    const revision: PlaceRevision = {
      placeId: pinned.placeId as PlaceRevision["placeId"],
      parent: pinned.revision,
      base: jsonRef(pinned.base),
      edits: pinned.edits,
      scene: jsonRef(pinned.scene),
      world: { spec: specRef, approved: false },
      authorId: owner,
      message: "Rebuilt its things in 3D",
      createdAt: new Date().toISOString(),
    };
    const saved = await commitAndPin(
      db,
      { worldId: capture.worldId, key: capture.placeKey, ownerId: owner },
      revision,
      scene,
    );
    if (!saved) throw new Error("couldn't save the place");
    await systemLinkWorldArtifacts(db, capture.worldId, [
      specRef.hash,
      ...made.meshes.map((m) => m.hash),
    ]);
    console.log(`pinned into ${capture.placeKey}`);
  }
} finally {
  await close();
}
