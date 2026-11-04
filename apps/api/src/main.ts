/**
 * The API process: connects config, the database, the artifact store and the worker's queue to
 * the HTTP app and the realm, and stops them in order on a signal. Jobs are only enqueued from
 * here; the worker runs them and holds the model keys, voice transcription aside.
 */
import type { Server } from "node:http";
import { FsArtifactStore } from "@aye/artifacts/node";
import { connect } from "@aye/db";
import {
  askStatus,
  askToReply,
  enqueueAsk,
  enqueueCapture,
  enqueueCityBuild,
  enqueueHome,
  enqueueMove,
  enqueueQuestion,
  enqueueRemove,
  enqueueWelcome,
  homeStatus,
  moveStatus,
  questionStatus,
  removeStatus,
} from "@aye/worker/jobs";
import { DBOSClient } from "@dbos-inc/dbos-sdk";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { contentLoader } from "./content.ts";
import { loadEnv } from "./env.ts";
import { Realm } from "./realm.ts";
import { attachRealm } from "./realm-server.ts";
import { museTranscribe } from "./voice.ts";

const env = loadEnv();
const { db, close } = connect(env.DATABASE_URL);
const store = new FsArtifactStore(env.AYE_ARTIFACT_DIR);
const content = contentLoader(store);
const queue = await DBOSClient.create({
  systemDatabaseUrl: env.DATABASE_URL,
  systemDatabaseSchemaName: "dbos",
});
const app = createApp({
  env,
  db,
  onSignOut: (userId) => realm.signedOut(userId),
  onPlaceChanged: (worldId, placeKey) => realm.placeChanged(worldId, placeKey),
  store,
  content,
  enqueueCity: async (worldId) => {
    await enqueueCityBuild(queue, { worldId });
  },
  enqueueCapture: (job) => enqueueCapture(queue, job),
  ...(env.MUSE_API_KEY ? { transcribe: museTranscribe(env.MUSE_API_KEY) } : {}),
  questions: {
    enqueue: (userId, job) => enqueueQuestion(queue, userId, job),
    status: (id) => questionStatus(queue, id),
  },
  asks: {
    enqueue: (userId, job) => enqueueAsk(queue, userId, job as never),
    status: (id) => askStatus(queue, id),
  },
  removals: {
    enqueue: (userId, job) => enqueueRemove(queue, userId, job as never),
    status: (id) => removeStatus(queue, id),
  },
  moves: {
    enqueue: (userId, job) => enqueueMove(queue, userId, job as never),
    status: (id) => moveStatus(queue, id),
  },
  homes: {
    enqueue: (userId, job) => enqueueHome(queue, userId, job as never),
    status: (id) => homeStatus(queue, id),
  },
});
let replies = 0;
const realm = new Realm({
  db,
  homeProposal: async (job) => {
    const s = await homeStatus(queue, job);
    return s?.status === "done" && s.result.ok ? s.result : null;
  },
  content,
  // Someone in a place answers through the worker (it holds the model key, not the API).
  replies: (request) =>
    askToReply(queue, `reply-${process.pid}-${Date.now()}-${replies++}`, request),
  welcome: (worldId, userId, key) => enqueueWelcome(queue, worldId, userId, key),
});

// A live game: one failed background job is logged, and everyone else's day goes on.
process.on("unhandledRejection", (reason) => {
  console.error("unhandled:", reason instanceof Error ? reason.message : "unknown error");
});

const server = serve(
  { fetch: app.fetch, port: env.API_PORT, hostname: process.env["API_HOST"] ?? "127.0.0.1" },
  (info) => {
    console.log(
      `api listening on http://127.0.0.1:${info.port}${env.AYE_DEV_AUTH === "1" ? " (dev auth header enabled)" : ""}`,
    );
  },
);
attachRealm(server as Server, { db, content, realm, origins: env.WEB_ORIGIN });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close();
    void realm
      .stop()
      .then(() => queue.destroy())
      .finally(() => void close().finally(() => process.exit(0)));
  });
}
