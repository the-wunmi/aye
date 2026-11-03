/**
 * Emits JSON Schema for the model-facing and wire-facing shapes, for providers that take
 * structured-output schemas and for non-TypeScript consumers.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { Character, EditOp, Scene, World, WorldSpec } from "../src/index.ts";

const out = new URL("../dist/json-schema/", import.meta.url);
mkdirSync(out, { recursive: true });
for (const [name, schema] of Object.entries({ Scene, EditOp, World, Character, WorldSpec })) {
  const json = z.toJSONSchema(schema, { unrepresentable: "any" });
  writeFileSync(new URL(`${name}.json`, out), `${JSON.stringify(json, null, 2)}\n`);
}
console.log(`wrote JSON Schema to ${out.pathname}`);
