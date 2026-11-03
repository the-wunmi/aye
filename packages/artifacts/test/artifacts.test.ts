import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ArtifactHash, ObjectId } from "@aye/schema";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  deriveId,
  hashJson,
  MemoryArtifactStore,
  randomId,
  recipeHash,
} from "../src/index.ts";
import { FsArtifactStore } from "../src/node.ts";

describe("canonicalJson", () => {
  it("is independent of key order and normalises -0", () => {
    expect(canonicalJson({ b: 1, a: [true, null, -0] })).toBe('{"a":[true,null,0],"b":1}');
    expect(hashJson({ x: 1, y: 2 })).toBe(hashJson({ y: 2, x: 1 }));
  });

  it("rejects values that have no canonical form", () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
    expect(() => canonicalJson(new Date())).toThrow();
    expect(() => canonicalJson({ f: () => 1 })).toThrow();
  });
});

describe("ids", () => {
  it("derives stable, schema-valid ids from provenance", () => {
    const a = deriveId("object", ["cap_abc", 7]);
    expect(a).toBe(deriveId("object", ["cap_abc", 7]));
    expect(a).not.toBe(deriveId("object", ["cap_abc", 8]));
    expect(ObjectId.safeParse(a).success).toBe(true);
  });

  it("random ids carry 128 bits and match the grammar", () => {
    const id = randomId("object");
    expect(id).toMatch(/^obj_[0-9a-z]{26}$/);
    expect(id).not.toBe(randomId("object"));
  });
});

describe("recipeHash", () => {
  const recipe = {
    stage: "understand",
    stageVersion: 1,
    model: { provider: "fake", model: "vision", version: "2026-01-01" },
    promptHash: null,
    inputs: { video: hashJson("v") },
    params: { temperature: 0 },
    seed: 1,
  };
  it("changes when any input changes", () => {
    expect(recipeHash(recipe)).toBe(recipeHash({ ...recipe }));
    expect(recipeHash(recipe)).not.toBe(recipeHash({ ...recipe, stageVersion: 2 }));
    expect(recipeHash(recipe)).not.toBe(recipeHash({ ...recipe, params: { temperature: 0.1 } }));
  });
});

describe.each([
  ["memory", async () => new MemoryArtifactStore()],
  ["fs", async () => new FsArtifactStore(await mkdtemp(join(tmpdir(), "aye-cas-")))],
])("%s artifact store", (_name, make) => {
  it("round-trips and dedupes by content", async () => {
    const store = await make();
    const bytes = new TextEncoder().encode("hello");
    const a = await store.put(bytes, "text/plain");
    const b = await store.put(bytes, "text/plain");
    expect(a).toEqual(b);
    expect(new TextDecoder().decode((await store.get(a.hash)) ?? new Uint8Array())).toBe("hello");
  });

  it("refuses malformed hashes instead of building paths from them", async () => {
    const store = await make();
    await expect(store.get("b3:../../etc/passwd" as ArtifactHash)).rejects.toThrow();
  });
});
