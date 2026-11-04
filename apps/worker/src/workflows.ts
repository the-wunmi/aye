/**
 * DBOS registration: durable workflows on Postgres. DBOS checkpoints every step in its
 * system schema, so a crashed or redeployed worker resumes jobs where they stopped, and
 * every run is inspectable with DBOS tooling.
 *
 * Workflow ids are derived from the job, so enqueueing the same compile twice is a no-op
 * rather than a second run.
 */
import { hashJson } from "@aye/artifacts";
import { systemReadyWorlds } from "@aye/db";
import { cityMinuteNow } from "@aye/schema";
import { DBOS, type DBOSClient } from "@dbos-inc/dbos-sdk";
import { z } from "zod";
import { AskJob, type AskResult, runAskJob } from "./ask-job.ts";
import {
  CaptureJob,
  type CaptureJobDeps,
  captureWorkflowId,
  runCaptureJob,
} from "./capture-job.ts";
import { CityJob, type CityJobDeps, runCityJob } from "./city-job.ts";
import { CompileJob, type CompileJobDeps, runCompileJob, type StepRunner } from "./compile-job.ts";
import { ConverseJob, type ConverseJobDeps, runConverseJob } from "./converse-job.ts";
import { DirectorJob, type DirectorJobDeps, runDirectorTurn } from "./director-job.ts";
import { HomeJob, type HomeResult, runHomeJob } from "./home-job.ts";
import { MoveJob, type MoveResult, runMoveJob } from "./move-job.ts";
import {
  QuestionJob,
  type QuestionJobDeps,
  type QuestionResult,
  runQuestionJob,
} from "./question-job.ts";
import { RemoveJob, type RemoveResult, runRemoveJob } from "./remove-job.ts";

export const COMPILE_QUEUE = "capture-compile";
export const COMPILE_WORKFLOW = "captureCompile";

/**
 * How many times a workflow may be resumed after its worker stops. A real crash loop should
 * give up; in development the worker restarts on every edit, which isn't a crash, so there a
 * build in flight keeps going.
 */
const attempts = (n: number) => (process.env["NODE_ENV"] === "production" ? n : Math.max(n, 100));

const dbosStep: StepRunner = (name, fn, opts) =>
  DBOS.runStep(fn, {
    name,
    ...(opts?.retries
      ? { retriesAllowed: true, maxAttempts: opts.retries, intervalSeconds: 5, backoffRate: 2 }
      : {}),
  });

/** Register before DBOS.launch(). Returns the durable workflow function. */
export function registerCompileWorkflow(deps: Omit<CompileJobDeps, "step">) {
  return DBOS.registerWorkflow(
    async (job: CompileJob) => runCompileJob(job, { ...deps, step: dbosStep }),
    {
      name: COMPILE_WORKFLOW,
      inputSchema: z.tuple([CompileJob]),
      maxRecoveryAttempts: attempts(5),
    },
  );
}

export async function registerCompileQueue() {
  // Model calls are the bottleneck and cost money: bound concurrency per worker and globally.
  return DBOS.registerQueue(COMPILE_QUEUE, { workerConcurrency: 2, globalConcurrency: 8 });
}

/** Stable id: the same source built with the same settings is the same workflow. */
export const compileWorkflowId = (job: CompileJob) => `build-${hashJson(job).slice(3, 35)}`;

/** Enqueue from another process (e.g. the API, after it has authorised the request). */
export async function enqueueCompile(client: DBOSClient, job: CompileJob) {
  const valid = CompileJob.parse(job);
  return client.enqueue<(job: CompileJob) => Promise<unknown>>(
    {
      queueName: COMPILE_QUEUE,
      workflowName: COMPILE_WORKFLOW,
      workflowID: compileWorkflowId(valid),
    },
    valid,
  );
}

// ── Cities ──────────────────────────────────────────────────────────────────────────

export const CITY_QUEUE = "city-build";
export const CITY_WORKFLOW = "buildCity";

export const CITY_FINISH_QUEUE = "city-finish";

export function registerCityWorkflow(deps: Omit<CityJobDeps, "step" | "finishLater">) {
  const workflow = DBOS.registerWorkflow(
    async (job: CityJob) =>
      runCityJob(job, {
        ...deps,
        step: dbosStep,
        // The slow passes run as their own workflow on their own queue.
        // A city nobody can enter yet must not wait behind another city's polish.
        finishLater: async (next, { playable }) => {
          await DBOS.startWorkflow(workflow, {
            queueName: playable ? CITY_FINISH_QUEUE : CITY_QUEUE,
            workflowID: `city-${next.worldId}-finish`,
          })(next);
        },
      }),
    { name: CITY_WORKFLOW, inputSchema: z.tuple([CityJob]), maxRecoveryAttempts: attempts(5) },
  );
  return workflow;
}

export async function registerCityQueue() {
  // First passes are quick and should never wait: several at once.
  await DBOS.registerQueue(CITY_QUEUE, { workerConcurrency: 4, globalConcurrency: 16 });
  // Filling and dressing are slow and costly, but one city's hour of polish shouldn't hold up
  // every other city's remaining places: a couple at a time.
  await DBOS.registerQueue(CITY_FINISH_QUEUE, { workerConcurrency: 2, globalConcurrency: 4 });
}

/** One build per world at a time: the id is the world (plus an attempt, to allow rebuilds). */
export const cityWorkflowId = (job: CityJob, attempt = 0) => `city-${job.worldId}-${attempt}`;

export async function enqueueCityBuild(
  client: DBOSClient,
  job: z.input<typeof CityJob>,
  attempt = 0,
) {
  const valid = CityJob.parse(job);
  return client.enqueue<(job: CityJob) => Promise<unknown>>(
    {
      queueName: CITY_QUEUE,
      workflowName: CITY_WORKFLOW,
      workflowID: cityWorkflowId(valid, attempt),
    },
    valid,
  );
}

// ── Questions, filmed places, and asking things for new abilities ───────────────────

export const ASK_QUEUE = "ask";
const QUESTION_QUEUE = "questions";
export const QUESTION_WORKFLOW = "askAboutPlace";

export function registerQuestionWorkflow(deps: QuestionJobDeps) {
  return DBOS.registerWorkflow(
    async (job: QuestionJob) => dbosStep("ask", () => runQuestionJob(job, deps)),
    {
      name: QUESTION_WORKFLOW,
      inputSchema: z.tuple([QuestionJob]),
      maxRecoveryAttempts: attempts(3),
    },
  );
}

export async function registerQuestionQueue() {
  return DBOS.registerQueue(QUESTION_QUEUE, { workerConcurrency: 4, globalConcurrency: 8 });
}

/** The job id names who asked, so only they can look it up. */
export async function enqueueQuestion(
  client: DBOSClient,
  userId: string,
  job: z.input<typeof QuestionJob>,
) {
  const valid = QuestionJob.parse(job);
  const id = `question-${userId}-${valid.nonce}`;
  await client.enqueue<(job: QuestionJob) => Promise<QuestionResult>>(
    { queueName: QUESTION_QUEUE, workflowName: QUESTION_WORKFLOW, workflowID: id },
    valid,
  );
  return id;
}

/** Where a question stands: still being tested, or its answer. */
export async function questionStatus(
  client: DBOSClient,
  id: string,
): Promise<{ status: "working" } | { status: "done"; result: QuestionResult } | null> {
  const handle = client.retrieveWorkflow<QuestionResult>(id);
  const status = await handle.getStatus();
  if (!status) return null;
  if (status.status === "SUCCESS") return { status: "done", result: await handle.getResult() };
  if (
    status.status === "ERROR" ||
    status.status === "CANCELLED" ||
    status.status === "MAX_RECOVERY_ATTEMPTS_EXCEEDED"
  ) {
    return { status: "done", result: { ok: false } };
  }
  return { status: "working" };
}

const CAPTURE_QUEUE = "captures";
export const CAPTURE_WORKFLOW = "captureIntoCity";

export function registerCaptureWorkflow(deps: Omit<CaptureJobDeps, "step">) {
  return DBOS.registerWorkflow(
    async (job: CaptureJob) => runCaptureJob(job, { ...deps, step: dbosStep }),
    {
      name: CAPTURE_WORKFLOW,
      inputSchema: z.tuple([CaptureJob]),
      maxRecoveryAttempts: attempts(3),
    },
  );
}

export async function registerCaptureQueue() {
  return DBOS.registerQueue(CAPTURE_QUEUE, { workerConcurrency: 2, globalConcurrency: 4 });
}

export async function enqueueCapture(client: DBOSClient, job: z.input<typeof CaptureJob>) {
  const valid = CaptureJob.parse(job);
  await client.enqueue<(job: CaptureJob) => Promise<unknown>>(
    {
      queueName: CAPTURE_QUEUE,
      workflowName: CAPTURE_WORKFLOW,
      workflowID: captureWorkflowId(valid.captureId),
    },
    valid,
  );
}

export const ASK_WORKFLOW = "askThing";

export function registerAskWorkflow(deps: Omit<Parameters<typeof runAskJob>[1], "step">) {
  return DBOS.registerWorkflow(async (job: AskJob) => runAskJob(job, { ...deps, step: dbosStep }), {
    name: ASK_WORKFLOW,
    inputSchema: z.tuple([AskJob]),
    maxRecoveryAttempts: attempts(3),
  });
}

export async function registerAskQueue() {
  return DBOS.registerQueue(ASK_QUEUE, { workerConcurrency: 2, globalConcurrency: 6 });
}

/** The job id names who asked, so only they can look it up. */
export const askWorkflowId = (userId: string, job: AskJob) => `ask-${userId}-${job.nonce}`;

export async function enqueueAsk(client: DBOSClient, userId: string, job: AskJob) {
  const valid = AskJob.parse(job);
  const id = askWorkflowId(userId, valid);
  await client.enqueue<(job: AskJob) => Promise<AskResult>>(
    { queueName: ASK_QUEUE, workflowName: ASK_WORKFLOW, workflowID: id },
    valid,
  );
  return id;
}

/** Where an ask stands: still working, or its result. */
export async function askStatus(
  client: DBOSClient,
  id: string,
): Promise<{ status: "working" } | { status: "done"; result: AskResult } | null> {
  const handle = client.retrieveWorkflow<AskResult>(id);
  const status = await handle.getStatus();
  if (!status) return null;
  if (status.status === "SUCCESS") return { status: "done", result: await handle.getResult() };
  if (
    status.status === "ERROR" ||
    status.status === "CANCELLED" ||
    status.status === "MAX_RECOVERY_ATTEMPTS_EXCEEDED"
  ) {
    return { status: "done", result: { ok: false, reason: "that didn't work" } };
  }
  return { status: "working" };
}

// ── Someone taking a filmed place away ────────────────────────────────────────────────

export const REMOVE_WORKFLOW = "removePlace";

export function registerRemoveWorkflow(deps: Parameters<typeof runRemoveJob>[1]) {
  return DBOS.registerWorkflow(
    async (job: RemoveJob) => dbosStep("remove", () => runRemoveJob(job, deps)),
    { name: REMOVE_WORKFLOW, inputSchema: z.tuple([RemoveJob]) },
  );
}

export const removeWorkflowId = (userId: string, job: RemoveJob) => `remove-${userId}-${job.nonce}`;

export async function enqueueRemove(client: DBOSClient, userId: string, job: RemoveJob) {
  const valid = RemoveJob.parse({ ...job, userId });
  const id = removeWorkflowId(userId, valid);
  await client.enqueue<(job: RemoveJob) => Promise<RemoveResult>>(
    { queueName: ASK_QUEUE, workflowName: REMOVE_WORKFLOW, workflowID: id },
    valid,
  );
  return id;
}

export async function removeStatus(
  client: DBOSClient,
  id: string,
): Promise<{ status: "working" } | { status: "done"; result: RemoveResult } | null> {
  const handle = client.retrieveWorkflow<RemoveResult>(id);
  const status = await handle.getStatus();
  if (!status) return null;
  if (status.status === "SUCCESS") return { status: "done", result: await handle.getResult() };
  if (
    status.status === "ERROR" ||
    status.status === "CANCELLED" ||
    status.status === "MAX_RECOVERY_ATTEMPTS_EXCEEDED"
  ) {
    return { status: "done", result: { ok: false, reason: "That didn't work. Try again." } };
  }
  return { status: "working" };
}

// ── Someone moving a thing in a place of theirs ────────────────────────────────────────

export const MOVE_WORKFLOW = "moveThing";

export function registerMoveWorkflow(deps: Parameters<typeof runMoveJob>[1]) {
  const run = DBOS.registerWorkflow(
    async (job: MoveJob) => dbosStep("move", () => runMoveJob(job, deps)),
    { name: MOVE_WORKFLOW, inputSchema: z.tuple([MoveJob]) },
  );
  return run;
}

/** The job id names who moved it, so only they can look it up. */
export const moveWorkflowId = (userId: string, job: MoveJob) => `move-${userId}-${job.nonce}`;

export async function enqueueMove(client: DBOSClient, userId: string, job: MoveJob) {
  const valid = MoveJob.parse({ ...job, userId });
  const id = moveWorkflowId(userId, valid);
  await client.enqueue<(job: MoveJob) => Promise<MoveResult>>(
    { queueName: ASK_QUEUE, workflowName: MOVE_WORKFLOW, workflowID: id },
    valid,
  );
  return id;
}

export async function moveStatus(
  client: DBOSClient,
  id: string,
): Promise<{ status: "working" } | { status: "done"; result: MoveResult } | null> {
  const handle = client.retrieveWorkflow<MoveResult>(id);
  const status = await handle.getStatus();
  if (!status) return null;
  if (status.status === "SUCCESS") return { status: "done", result: await handle.getResult() };
  if (
    status.status === "ERROR" ||
    status.status === "CANCELLED" ||
    status.status === "MAX_RECOVERY_ATTEMPTS_EXCEEDED"
  ) {
    return { status: "done", result: { ok: false, reason: "That didn't save. Try again." } };
  }
  return { status: "working" };
}

// ── Someone changing their own home ────────────────────────────────────────────────────

export const HOME_WORKFLOW = "changeHome";

export function registerHomeWorkflow(deps: Omit<Parameters<typeof runHomeJob>[1], "step">) {
  return DBOS.registerWorkflow(
    async (job: HomeJob) => dbosStep("change", () => runHomeJob(job, deps)),
    {
      name: HOME_WORKFLOW,
      inputSchema: z.tuple([HomeJob]),
      maxRecoveryAttempts: attempts(3),
    },
  );
}

/** The job id names who asked, so only they can look it up. */
export const homeWorkflowId = (userId: string, job: HomeJob) => `home-${userId}-${job.nonce}`;

export async function enqueueHome(client: DBOSClient, userId: string, job: HomeJob) {
  const valid = HomeJob.parse({ ...job, userId });
  const id = homeWorkflowId(userId, valid);
  await client.enqueue<(job: HomeJob) => Promise<HomeResult>>(
    { queueName: ASK_QUEUE, workflowName: HOME_WORKFLOW, workflowID: id },
    valid,
  );
  return id;
}

export async function homeStatus(
  client: DBOSClient,
  id: string,
): Promise<{ status: "working" } | { status: "done"; result: HomeResult } | null> {
  const handle = client.retrieveWorkflow<HomeResult>(id);
  const status = await handle.getStatus();
  if (!status) return null;
  if (status.status === "SUCCESS") return { status: "done", result: await handle.getResult() };
  if (
    status.status === "ERROR" ||
    status.status === "CANCELLED" ||
    status.status === "MAX_RECOVERY_ATTEMPTS_EXCEEDED"
  ) {
    return { status: "done", result: { ok: false, reason: "that didn't work" } };
  }
  return { status: "working" };
}

// ── The director: each world's slow loop ─────────────────────────────────────────────

export const DIRECTOR_QUEUE = "director";
export const DIRECTOR_WORKFLOW = "directCity";

/** Whether a world's city build or finishing pass is queued or running. */
async function cityBuilding(worldId: string): Promise<boolean> {
  const running = await DBOS.listWorkflows({
    workflow_id_prefix: `city-${worldId}-`,
    status: ["PENDING", "ENQUEUED"],
  });
  return running.length > 0;
}

export function registerDirectorWorkflow(deps: Omit<DirectorJobDeps, "building">) {
  return DBOS.registerWorkflow(
    async (job: DirectorJob) =>
      dbosStep("turn", () => runDirectorTurn(job, { ...deps, building: cityBuilding })),
    {
      name: DIRECTOR_WORKFLOW,
      inputSchema: z.tuple([DirectorJob]),
      maxRecoveryAttempts: attempts(3),
    },
  );
}

export async function registerDirectorQueue() {
  return DBOS.registerQueue(DIRECTOR_QUEUE, { workerConcurrency: 2, globalConcurrency: 4 });
}

/** A player with nothing to do: their world's director gives them something now. */
export async function enqueueWelcome(
  client: DBOSClient,
  worldId: string,
  userId: string,
  /** Once per key (a city day, or the thread they just ended). */
  key: string,
) {
  const job = DirectorJob.parse({ worldId, welcome: userId });
  await client.enqueue<(job: DirectorJob) => Promise<unknown>>(
    {
      queueName: DIRECTOR_QUEUE,
      workflowName: DIRECTOR_WORKFLOW,
      workflowID: `director-welcome-${worldId}-${userId}-${key}`,
    },
    job,
  );
}

/**
 * Hand every ready world to its director once per turn: the workflow id names the world and
 * the turn (its city minute over the interval), so a turn is queued at most once however
 * often this runs, on however many workers.
 */
export function scheduleDirectors(
  deps: Pick<DirectorJobDeps, "db" | "config" | "now">,
  workflow: ReturnType<typeof registerDirectorWorkflow>,
  everyMs: number,
): () => void {
  const tick = async () => {
    for (const w of await systemReadyWorlds(deps.db)) {
      const minute = cityMinuteNow(w.createdAt.toISOString(), w.settings, deps.now());
      const turn = Math.floor(minute / deps.config.everyMin);
      await DBOS.startWorkflow(workflow, {
        queueName: DIRECTOR_QUEUE,
        workflowID: `director-${w.id}-${turn}`,
      })({ worldId: w.id as DirectorJob["worldId"] });
    }
  };
  const handle = setInterval(() => void tick().catch(() => {}), everyMs);
  void tick().catch(() => {});
  return () => clearInterval(handle);
}

// ── People answering players ─────────────────────────────────────────────────────────

export const CONVERSE_QUEUE = "converse";
export const CONVERSE_WORKFLOW = "converse";

export function registerConverseWorkflow(deps: ConverseJobDeps) {
  return DBOS.registerWorkflow(
    async (job: ConverseJob) => dbosStep("reply", () => runConverseJob(job, deps), { retries: 2 }),
    {
      name: CONVERSE_WORKFLOW,
      inputSchema: z.tuple([ConverseJob]),
      maxRecoveryAttempts: attempts(2),
    },
  );
}

export async function registerConverseQueue() {
  return DBOS.registerQueue(CONVERSE_QUEUE, { workerConcurrency: 4, globalConcurrency: 16 });
}

/**
 * Ask the place's people to answer, and wait (briefly) for what they say. Null if nobody does,
 * or they take too long: a conversation that comes back late is a conversation that's over.
 */
export async function askToReply(
  client: DBOSClient,
  id: string,
  job: z.input<typeof ConverseJob>,
  timeoutMs = 45_000,
): Promise<Awaited<ReturnType<typeof runConverseJob>>> {
  const valid = ConverseJob.parse(job);
  const handle = await client.enqueue<(job: ConverseJob) => ReturnType<typeof runConverseJob>>(
    { queueName: CONVERSE_QUEUE, workflowName: CONVERSE_WORKFLOW, workflowID: id },
    valid,
  );
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  return Promise.race([handle.getResult(), timeout]).catch(() => null);
}
