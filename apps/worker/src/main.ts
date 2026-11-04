/**
 * Worker process: hosts the durable workflows (DBOS on Postgres) for cities, places, filmed
 * places, asks, moves, homes, questions, conversations and each world's director. The only
 * infrastructure is Postgres plus the artifact store on disk.
 */

import { fileURLToPath } from "node:url";
import { FsArtifactStore } from "@aye/artifacts/node";
import { connect, PgRecipeIndex } from "@aye/db";
import {
  metaDescriber,
  metaSegmenter,
  metaUnderstander,
  museArranger,
  museCityAuthor,
  museCityJoiner,
  museConfigFrom,
  museConversationalist,
  museDirector,
  museFurnisher,
  museHomeChanger,
  museLocator,
  museLookCritic,
  museLookDesigner,
  musePainter,
  museReconstructPlanner,
  museWorldAgent,
  museWorldAuthor,
  overpassSource,
  pixelRedactor,
  reconstructorFrom,
} from "@aye/pipeline";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { z } from "zod";
import type { Providers } from "./compile-job.ts";
import { libraryFiles } from "./library-files.ts";
import { ModelTraffic } from "./traffic.ts";
import {
  registerAskQueue,
  registerAskWorkflow,
  registerCaptureQueue,
  registerCaptureWorkflow,
  registerCityQueue,
  registerCityWorkflow,
  registerCompileQueue,
  registerCompileWorkflow,
  registerConverseQueue,
  registerConverseWorkflow,
  registerDirectorQueue,
  registerDirectorWorkflow,
  registerHomeWorkflow,
  registerMoveWorkflow,
  registerQuestionQueue,
  registerQuestionWorkflow,
  registerRemoveWorkflow,
  scheduleDirectors,
} from "./workflows.ts";

const env = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    /** Shared with the API. Defaults to the repo's .aye/ in development. */
    AYE_ARTIFACT_DIR: z
      .string()
      .min(1)
      .default(fileURLToPath(new URL("../../../.aye/artifacts", import.meta.url))),
    /** The world director: on unless "off". */
    DIRECTOR: z.enum(["on", "off"]).default("on"),
    /** City minutes between a world's director turns. */
    DIRECTOR_EVERY_CITY_MIN: z.coerce.number().int().min(15).max(1440).default(180),
    /** Model calls a world's director may make a day; unset, empty or 0: no limit. */
    DIRECTOR_CALLS_PER_DAY: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .parse(process.env);

/** Hosted Meta models plus CPU work. Muse is required: there is no fallback. */
async function loadProviders(): Promise<Providers> {
  const { ffmpegSampler } = await import("@aye/pipeline/node");
  const muse = museConfigFrom(process.env);
  return {
    capture: {
      sampler: ffmpegSampler({ frames: 16, width: 768 }),
      segmenter: metaSegmenter(muse),
      redactor: pixelRedactor(),
      understander: metaUnderstander(muse),
    },
    describer: metaDescriber(muse),
    author: museWorldAuthor(muse),
  };
}

const { db, close } = connect(env.DATABASE_URL, { max: 4 });
const controller = new AbortController();

DBOS.setConfig({
  name: "aye",
  systemDatabaseUrl: env.DATABASE_URL,
  systemDatabaseSchemaName: "dbos",
  // DBOS resumes only workflows started by the same application version, which it derives
  // from the code. In development the worker reloads on every edit, so a derived version
  // would orphan every build in flight; there, one fixed version. Elsewhere, the code's own.
  ...(env.NODE_ENV === "development" ? { applicationVersion: "development" } : {}),
});
const store = new FsArtifactStore(env.AYE_ARTIFACT_DIR);
const providers = await loadProviders();
registerCompileWorkflow({ db, store, providers, signal: controller.signal });
const traffic = new ModelTraffic();
/** The providers of a city's slow passes, whose calls give way to anyone who's waiting. */
const finishing = { ...museConfigFrom(process.env), fetch: traffic.fetch };
registerCityWorkflow({
  db,
  store,
  traffic,
  readAsset: libraryFiles(),
  finishProviders: {
    city: museCityAuthor(finishing),
    critic: museLookCritic(finishing),
    designer: museLookDesigner(finishing),
    describer: metaDescriber(finishing),
    author: museWorldAuthor(finishing),
    furnisher: museFurnisher({ ...finishing, effort: "low" }),
    arranger: museArranger(finishing),
    locator: museLocator(finishing),
    maps: overpassSource(),
    quick: {
      city: museCityAuthor({ ...finishing, effort: "low" }, { sketch: true }),
      describer: metaDescriber({ ...finishing, effort: "low" }, { sketch: true }),
      author: museWorldAuthor({ ...finishing, effort: "low" }, { sketch: true }),
    },
  },
  providers: {
    city: museCityAuthor(museConfigFrom(process.env)),
    critic: museLookCritic(museConfigFrom(process.env)),
    designer: museLookDesigner(museConfigFrom(process.env)),
    describer: providers.describer,
    author: providers.author,
    // Choosing from a list needs little thought.
    furnisher: museFurnisher({ ...museConfigFrom(process.env), effort: "low" }),
    arranger: museArranger(museConfigFrom(process.env)),
    locator: museLocator(museConfigFrom(process.env)),
    maps: overpassSource(),
    quick: (() => {
      // The first pass thinks less, so people can start playing in minutes.
      const cfg = { ...museConfigFrom(process.env), effort: "low" as const };
      return {
        city: museCityAuthor(cfg, { sketch: true }),
        describer: metaDescriber(cfg, { sketch: true }),
        author: museWorldAuthor(cfg, { sketch: true }),
      };
    })(),
  },
  signal: controller.signal,
});
registerHomeWorkflow({
  db,
  store,
  changer: museHomeChanger({ ...museConfigFrom(process.env), effort: "low" }),
  signal: controller.signal,
});
registerMoveWorkflow({ db, store });
registerRemoveWorkflow({ db, store });
registerAskWorkflow({
  db,
  store,
  providers: {
    author: providers.author,
    critic: museLookCritic(museConfigFrom(process.env)),
    designer: museLookDesigner(museConfigFrom(process.env)),
  },
  signal: controller.signal,
});
const director =
  env.DIRECTOR === "on"
    ? registerDirectorWorkflow({
        db,
        store,
        index: new PgRecipeIndex(db),
        director: museDirector(museConfigFrom(process.env)),
        config: {
          everyMin: env.DIRECTOR_EVERY_CITY_MIN,
          callsPerDay: env.DIRECTOR_CALLS_PER_DAY > 0 ? env.DIRECTOR_CALLS_PER_DAY : null,
        },
        now: () => Date.now(),
        signal: controller.signal,
      })
    : null;
const reconstructor = reconstructorFrom(process.env);
registerCaptureWorkflow({
  db,
  store,
  traffic,
  providers: {
    // Someone's waiting to walk in, and what's filmed already says most of what's there.
    capture: {
      ...providers.capture,
      understander: metaUnderstander({ ...museConfigFrom(process.env), effort: "low" }),
    },
    describer: providers.describer,
    author: museWorldAuthor({ ...museConfigFrom(process.env), effort: "low" }),
    joiner: museCityJoiner({ ...museConfigFrom(process.env), effort: "low" }),
    furnisher: museFurnisher({ ...museConfigFrom(process.env), effort: "low" }),
    painter: musePainter({ ...museConfigFrom(process.env), effort: "low" }),
    ...(reconstructor
      ? {
          rebuilder: {
            reconstructor,
            planner: museReconstructPlanner({ ...museConfigFrom(process.env), effort: "low" }),
          },
        }
      : {}),
  },
  signal: controller.signal,
});
registerQuestionWorkflow({
  db,
  store,
  index: new PgRecipeIndex(db),
  agent: museWorldAgent(museConfigFrom(process.env)),
  signal: controller.signal,
});
registerConverseWorkflow({
  db,
  store,
  index: new PgRecipeIndex(db),
  voice: museConversationalist({ ...museConfigFrom(process.env), effort: "low" }),
  signal: controller.signal,
});
await DBOS.launch();
await registerCompileQueue();
await registerCityQueue();
await registerAskQueue();
await registerDirectorQueue();
await registerConverseQueue();
await registerCaptureQueue();
await registerQuestionQueue();
const stopDirectors = director
  ? scheduleDirectors(
      {
        db,
        now: () => Date.now(),
        config: { everyMin: env.DIRECTOR_EVERY_CITY_MIN, callsPerDay: null },
      },
      director,
      60_000,
    )
  : () => {};
console.log("worker ready");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    stopDirectors();
    controller.abort();
    await DBOS.shutdown();
    await close();
    process.exit(0);
  });
}
