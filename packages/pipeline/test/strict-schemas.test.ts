/**
 * Muse's strict structured output refuses a whole request if any object leaves a key out of
 * `required`, so one `.optional()` in a draft silently stops that stage in production while fake
 * models in tests carry on. Every schema a stage sends is checked here. `.default()` is the way
 * to make a field skippable: it stays required in what's sent and still has a value when read.
 */
import { LIBRARY_CATALOG } from "@aye/schema";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { ArrangeAnswer } from "../src/arrange.ts";
import {
  CityDraft,
  DraftKind,
  LookReview,
  PersonRedesign,
  SceneUnderstanding,
  SolidsRedesign,
  ThingRedesign,
  WorldDraft,
} from "../src/contracts.ts";
import { ConverseDraft } from "../src/converse.ts";
import { decorateSchema } from "../src/decorate.ts";
import { DirectorDraft } from "../src/director.ts";
import { cityFurnishSchema, worldFurnishSchema } from "../src/furnish.ts";
import { Located } from "../src/ground.ts";
import { makeYoursSchema } from "../src/make-yours.ts";
import { jsonSchemaFor, MuseError, museJson } from "../src/muse.ts";
import { PaintPlan } from "../src/paint.ts";
import { PopulationDraft } from "../src/populate.ts";
import { RebuildVerdict, ReconstructPlan } from "../src/reconstruct.ts";

const SENT: Record<string, z.ZodType> = {
  ArrangeAnswer,
  CityDraft,
  ConverseDraft,
  DirectorDraft,
  DraftKind,
  Located,
  LookReview,
  PaintPlan,
  PersonRedesign,
  RebuildVerdict,
  ReconstructPlan,
  PopulationDraft,
  SceneUnderstanding,
  SolidsRedesign,
  ThingRedesign,
  WorldDraft,
  cityFurnish: cityFurnishSchema(LIBRARY_CATALOG),
  decorate: decorateSchema(LIBRARY_CATALOG),
  makeYours: makeYoursSchema(LIBRARY_CATALOG),
  worldFurnish: worldFurnishSchema(LIBRARY_CATALOG),
};

/** Paths of every object whose keys aren't all required, or that allows extra keys. */
function strictProblems(node: unknown, path = "$"): string[] {
  if (Array.isArray(node)) return node.flatMap((n, i) => strictProblems(n, `${path}[${i}]`));
  if (node === null || typeof node !== "object") return [];
  const o = node as Record<string, unknown>;
  const problems: string[] = [];
  if (o["properties"] && typeof o["properties"] === "object") {
    const required = new Set((o["required"] as string[] | undefined) ?? []);
    for (const key of Object.keys(o["properties"])) {
      if (!required.has(key)) problems.push(`${path}.${key} is not required`);
    }
    if (o["additionalProperties"] !== false) problems.push(`${path} allows extra keys`);
  }
  for (const [k, v] of Object.entries(o)) problems.push(...strictProblems(v, `${path}.${k}`));
  return problems;
}

describe("schemas sent to the model", () => {
  it("catches a field left out of required", async () => {
    const { z } = await import("zod");
    const bad = z.strictObject({ a: z.int(), b: z.array(z.int()).optional() });
    expect(strictProblems(jsonSchemaFor(bad))).toEqual(["$.b is not required"]);
  });

  for (const [name, schema] of Object.entries(SENT)) {
    it(`${name} is one strict mode accepts`, () => {
      expect(strictProblems(jsonSchemaFor(schema))).toEqual([]);
    });
  }
});

const apiKey = process.env["MUSE_API_KEY"];

describe.skipIf(!apiKey)("schemas sent to the model (live)", () => {
  for (const [name, schema] of Object.entries(SENT)) {
    it(`Muse takes ${name}`, { timeout: 120_000 }, async () => {
      // Only the request's validity is on trial: a tiny budget gets refused or cut off after that.
      const failure = await museJson(
        { apiKey: apiKey as string, textModel: "muse-spark-1.3", effort: "low" },
        {
          system: "Answer as briefly as you can.",
          user: "Hello.",
          maxTokens: 16,
          name,
          schema,
          signal: AbortSignal.timeout(100_000),
        },
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect(failure instanceof MuseError ? failure.status : 0).not.toBe(400);
    });
  }
});
