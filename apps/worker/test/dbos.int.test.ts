/**
 * The compile workflow running for real under DBOS on a throwaway Postgres database.
 */
import { fileURLToPath } from "node:url";
import { MemoryArtifactStore } from "@aye/artifacts";
import { connect, type Db, getPlace, tables } from "@aye/db";
import {
  fakeCapture,
  fakeDescriber,
  fakeWorldAuthor,
  understandingFromScene,
} from "@aye/pipeline/fake";
import type { UserId } from "@aye/schema";
import { sampleFlat } from "@aye/schema/fixtures";
import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CompileJob } from "../src/compile-job.ts";
import {
  COMPILE_WORKFLOW,
  enqueueCompile,
  registerCompileQueue,
  registerCompileWorkflow,
} from "../src/workflows.ts";

const url = process.env["DATABASE_URL"];

describe.skipIf(!url)("compile workflow on DBOS", () => {
  const dbName = `aye_dbos_test_${process.pid}_${Date.now()}`;
  let admin: ReturnType<typeof postgres>;
  let conn: ReturnType<typeof connect>;
  let db: Db;
  let client: DBOSClient;
  let testUrl: string;
  const store = new MemoryArtifactStore();
  let job: CompileJob;

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${dbName}`);
    const u = new URL(url as string);
    u.pathname = `/${dbName}`;
    testUrl = u.toString();
    conn = connect(testUrl, { max: 2 });
    db = conn.db;
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url)),
    });
    const video = await store.put(new TextEncoder().encode("mp4"), "video/mp4");
    await db.insert(tables.users).values({ id: "usr_alice", handle: "alice" });
    await db.insert(tables.places).values({ id: "plc_flat02", ownerId: "usr_alice", name: "Flat" });
    await db.insert(tables.captures).values({
      id: "cap_flat02",
      placeId: "plc_flat02",
      ownerId: "usr_alice",
      video: video.hash,
      videoBytes: video.bytes,
      mediaType: video.mediaType,
      durationMs: 1000,
    });
    job = CompileJob.parse({
      source: { kind: "recording", captureId: "cap_flat02" },
      currency: "NGN",
    });

    DBOS.setConfig({
      name: "aye-test",
      systemDatabaseUrl: testUrl,
      systemDatabaseSchemaName: "dbos",
      logLevel: "error",
    });
    registerCompileWorkflow({
      db,
      store,
      providers: {
        capture: fakeCapture({ understanding: understandingFromScene(sampleFlat) }),
        describer: fakeDescriber(understandingFromScene(sampleFlat)),
        author: fakeWorldAuthor(),
      },
      signal: new AbortController().signal,
    });
    await DBOS.launch();
    await registerCompileQueue();
    client = await DBOSClient.create({
      systemDatabaseUrl: testUrl,
      systemDatabaseSchemaName: "dbos",
    });
  }, 60_000);

  afterAll(async () => {
    await client?.destroy();
    await DBOS.shutdown();
    await conn?.close();
    await admin?.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
  });

  it("enqueues from a client, runs durably, and commits the revision", async () => {
    const handle = await enqueueCompile(client, job);
    const result = (await handle.getResult()) as { revision: string };
    const place = await getPlace(db, { kind: "user", userId: "usr_alice" as UserId }, "plc_flat02");
    expect(place?.head).toBe(result.revision);
    const steps = await DBOS.listWorkflowSteps(handle.workflowID);
    expect(steps?.map((s) => s.name)).toEqual([
      "load",
      "start-run",
      "layout",
      "world",
      "rebase-and-commit",
      "finish",
    ]);
  }, 30_000);

  it("is idempotent: enqueueing the same compile again returns the same workflow", async () => {
    const a = await enqueueCompile(client, job);
    const b = await enqueueCompile(client, job);
    expect(a.workflowID).toBe(b.workflowID);
    expect(await b.getResult()).toEqual(await a.getResult());
  }, 30_000);

  it("validates input on every invocation, including direct ones", async () => {
    await expect(
      client
        .enqueue(
          { queueName: "capture-compile", workflowName: COMPILE_WORKFLOW },
          { captureId: "../x" },
        )
        .then((h) => h.getResult()),
    ).rejects.toThrow();
  }, 30_000);
});
