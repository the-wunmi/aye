/**
 * Re-run a city's finishing pass: build any place still missing, dress, and furnish.
 * Finished stages replay from the recipe cache, so after a library change this only asks for
 * what's new. Each run needs a fresh attempt number (workflow ids are idempotent).
 *
 * A pass left behind by an older worker (DBOS resumes only its own version's workflows) is
 * cancelled first: it can never finish, and anything waiting for the city to be built (the
 * director) would wait on it forever.
 *
 * Usage: node --env-file=../../.env scripts/refinish.ts <worldId> <attempt>
 */

import { WorldId } from "@aye/schema";
import { DBOSClient } from "@dbos-inc/dbos-sdk";
import { z } from "zod";
import { enqueueCityBuild } from "../src/workflows.ts";

const [worldId, attempt] = z
  .tuple([WorldId, z.coerce.number().int().min(1).max(10_000)])
  .parse(process.argv.slice(2));
const { DATABASE_URL } = z
  .object({ DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }) })
  .parse(process.env);
const client = await DBOSClient.create({
  systemDatabaseUrl: DATABASE_URL,
  systemDatabaseSchemaName: "dbos",
});
const stuck = await client.listWorkflows({
  workflow_id_prefix: `city-${worldId}-`,
  status: ["PENDING", "ENQUEUED"],
});
if (stuck.length > 0) {
  await client.cancelWorkflows(stuck.map((w) => w.workflowID));
  console.log(`cancelled ${stuck.map((w) => w.workflowID).join(", ")}`);
}
await enqueueCityBuild(client, { worldId, phase: "finish" }, attempt);
await client.destroy();
console.log(`queued the finishing pass for ${worldId} (attempt ${attempt})`);
