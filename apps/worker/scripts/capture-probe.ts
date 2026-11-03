/**
 * Try the recording pipeline on a video file, outside any city: sample and redact its frames,
 * have SAM 3.1 find what's in them, have the understander lay the place out, then have the
 * world harness write how it works. Prints what each stage produced and how long it took, so
 * a capture can be judged before it's wired into the game. Stages are memoised: a re-run with
 * the same video costs nothing.
 *
 * A trusted dev tool (the only database writes are the recipe cache).
 * Usage: node --env-file=../../.env scripts/capture-probe.ts <video.mp4> [what it is]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FsArtifactStore } from "@aye/artifacts/node";
import { connect, PgRecipeIndex } from "@aye/db";
import {
  askWorld,
  authorWorld,
  briefFor,
  compilePlace,
  metaDescriber,
  metaSegmenter,
  metaUnderstander,
  museConfigFrom,
  musePainter,
  museWorldAgent,
  museWorldAuthor,
  paintPlace,
  pixelRedactor,
  readJson,
  walkFindings,
} from "@aye/pipeline";
import { ffmpegSampler } from "@aye/pipeline/node";
import { type CaptureId, Scene } from "@aye/schema";
import { evaluateWorld } from "@aye/sim";
import { EVAL_SETTINGS } from "../src/compile-job.ts";

const [path, note = ""] = process.argv.slice(2);
if (!path) throw new Error("usage: capture-probe.ts <video> [what it is]");
const store = new FsArtifactStore(
  fileURLToPath(new URL("../../../.aye/artifacts", import.meta.url)),
);
const { db, close } = connect(process.env["DATABASE_URL"] as string, { max: 2 });
const index = new PgRecipeIndex(db);
const muse = museConfigFrom(process.env);
const started = Date.now();
const t = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

const bytes = await readFile(path);
const video = await store.put(bytes, "video/mp4");
console.log(`[${t()}] video ${(bytes.byteLength / 1e6).toFixed(1)} MB`);
const layout = await compilePlace(
  { kind: "recording", captureId: "cap_probe0000000000000000000" as CaptureId, video },
  {
    store,
    index,
    capture: {
      sampler: ffmpegSampler({ frames: 16, width: 768 }),
      segmenter: metaSegmenter(muse),
      redactor: pixelRedactor(),
      understander: metaUnderstander(muse),
    },
    describer: metaDescriber(muse),
    onStage: (r, cached) => console.log(`[${t()}] stage ${r.stage} ${cached ? "(cached)" : ""}`),
  },
);
if (process.env["FRAMES_OUT"] && layout.frames) {
  mkdirSync(process.env["FRAMES_OUT"], { recursive: true });
  for (const f of layout.frames.frames) {
    const b = await store.get(f.image.hash);
    if (b) writeFileSync(`${process.env["FRAMES_OUT"]}/${String(f.index).padStart(6, "0")}.jpg`, b);
  }
  console.log(`[${t()}] redacted frames written`);
  if (process.env["FRAMES_ONLY"]) {
    await close();
    process.exit(0);
  }
}
const scene = Scene.parse(await readJson(store, layout.sceneRef));
console.log(`[${t()}] place: ${layout.place.name} — ${layout.place.summary}`);
console.log(
  `  spaces: ${scene.spaces.map((s) => s.name).join(", ")}\n  objects (${scene.objects.length}): ${scene.objects
    .map((o) => o.label)
    .join(", ")}`,
);
const world = await authorWorld(
  {
    scene,
    sceneHash: layout.sceneRef.hash,
    brief: briefFor({
      scene,
      name: layout.place.name,
      summary: layout.place.summary,
      description: note,
      filmed: true,
      currency: layout.place.currency,
    }),
  },
  {
    author: museWorldAuthor(muse),
    store,
    index,
    maxRounds: 3,
    untilNoErrors: true,
    critique: (s) => evaluateWorld(scene, s, EVAL_SETTINGS, { hours: 24 }).findings,
  },
);
console.log(`[${t()}] world: ${world.spec ? "written" : "none"}`);
for (const k of world.spec?.kinds ?? []) {
  console.log(`  ${k.label}: ${k.actions.map((a) => a.label).join(", ")}`);
}
for (const f of world.findings.slice(0, 8)) console.log(`  ${f.severity}: ${f.message}`);
let paintedSpec: unknown = null;
for (const f of walkFindings(scene)) console.log(`  walk: ${f.slice(0, 160)}`);
if (world.spec && layout.frames) {
  const painted = await paintPlace(world.spec, scene, layout.frames, {
    painter: musePainter({ ...muse, effort: "low" }),
    store,
    index,
  });
  console.log(`[${t()}] painted ${painted.painted}, failed ${painted.failed}`);
  paintedSpec = painted.spec;
  console.log(`  chosen: ${painted.chosen.join("; ")}`);
  for (const p of painted.problems) console.log(`  problem: ${p}`);
}
if (world.spec && world.specRef && process.env["ASK"]) {
  const r = await askWorld(
    {
      scene,
      spec: world.spec,
      settings: EVAL_SETTINGS,
      question: process.env["ASK"],
      sceneHash: layout.sceneRef.hash,
      specHash: world.specRef.hash,
    },
    { agent: museWorldAgent({ ...muse, effort: "medium" }), store, index },
  );
  console.log(`[${t()}] asked: ${r.answer.tests} tests, tested ${r.answer.tested}`);
  console.log(`  ${r.answer.answer}`);
  for (const f of r.answer.findings)
    console.log(`  - ${f.text} [${f.thing ?? f.crossing ?? f.opening ?? ""}]`);
}
if (process.env["SCENE_OUT"]) {
  writeFileSync(
    process.env["SCENE_OUT"],
    JSON.stringify({ scene, spec: paintedSpec ?? world.spec }, null, 1),
  );
}
await close();
