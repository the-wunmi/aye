/**
 * Tests for arranging seats with a scripted model (`arrangePlace`) and for fitting library meshes
 * into a thing's box.
 */
import { MemoryArtifactStore, MemoryRecipeIndex } from "@aye/artifacts";
import type { LibraryCatalog, Scene, WorldSpec } from "@aye/schema";
import { sampleFlat, sampleSettings, sampleSpec } from "@aye/schema/fixtures";
import { evaluateWorld } from "@aye/sim";
import { Document, WebIO } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";
import {
  type ArrangeItem,
  type Arranger,
  arrangePlace,
  fitMesh,
  readLibraryMesh,
  seatsOf,
} from "../src/index.ts";

const catalog: LibraryCatalog = {
  format: "aye.library",
  version: 1,
  things: [],
  outfits: [],
  surfaces: [],
  animations: null,
};

// The world says people sit ON the sofa and lie on the bed.
const spec: WorldSpec = {
  ...sampleSpec,
  kinds: sampleSpec.kinds.map((k) => ({
    ...k,
    actions: k.actions.map((a) =>
      a.pose === "sit" || a.pose === "lie" ? { ...a, on: k.key === "sofa" || k.key === "bed" } : a,
    ),
  })),
};

function arranger(answer: (items: readonly ArrangeItem[]) => unknown) {
  const calls = { n: 0, items: [] as ArrangeItem[][], sheets: [] as Uint8Array[] };
  const a: Arranger = {
    model: { provider: "test", model: "arranger", version: "1" },
    prompt: "arrange",
    effort: "low",
    async arrange(sheet, items) {
      calls.n++;
      calls.items.push([...items]);
      calls.sheets.push(sheet);
      return answer(items);
    },
  };
  return { a, calls };
}

const deps = (a: Arranger, store = new MemoryArtifactStore(), index = new MemoryRecipeIndex()) => ({
  arranger: a,
  store,
  index,
  catalog,
  readAsset: async () => null,
  critique: (sc: Scene, w: WorldSpec) =>
    evaluateWorld(sc, w, sampleSettings, { hours: 6 }).findings,
  settings: sampleSettings,
});

const yawOf = (s: Scene, label: RegExp) =>
  s.objects.find((o) => label.test(o.label))?.transform.yawDeg;

describe("arrangePlace", () => {
  it("shows the model only what people sit or lie on", () => {
    expect(
      seatsOf(sampleFlat, spec)
        .map((o) => o.label)
        .sort(),
    ).toEqual(["Brown leather three-seater", "Double bed with ankara spread"]);
  });

  it("turns what the model says faces the wrong way, when physics allows", async () => {
    let looks = 0;
    const { a, calls } = arranger((items) => {
      looks++;
      return {
        tiles: items.map((t) => ({
          index: t.index,
          // Once turned, it's right.
          turnDeg: looks === 1 && /three-seater/.test(t.thing) ? 180 : 0,
          why: "its back is to the TV",
        })),
      };
    });
    const { scene, turned } = await arrangePlace(sampleFlat, spec, deps(a));
    expect(yawOf(scene, /three-seater/)).toBe(0);
    expect(yawOf(scene, /Double bed/)).toBe(90);
    expect(turned.map((t) => t.turnDeg)).toEqual([180]);
    // It looks again at what it turned, and the picture shows its surroundings.
    expect(calls.n).toBe(2);
    expect(calls.items[0]?.find((t) => /three-seater/.test(t.thing))?.around).toContain(
      "Wall-mounted TV",
    );
    expect(calls.sheets[0]?.slice(1, 4)).toEqual(new Uint8Array([80, 78, 71]));
  });

  it("refuses a turn that would push it through a wall", async () => {
    const { a } = arranger((items) => ({
      tiles: items.map((t) => ({ index: t.index, turnDeg: 90, why: "turn it" })),
    }));
    const { scene, turned } = await arrangePlace(sampleFlat, spec, deps(a));
    expect(yawOf(scene, /three-seater/)).toBe(180);
    expect(turned.find((t) => /three-seater/.test(t.thing))).toBeUndefined();
  });

  it("replays with no model call", async () => {
    const { a, calls } = arranger((items) => ({
      tiles: items.map((t) => ({ index: t.index, turnDeg: 0, why: "fine" })),
    }));
    const store = new MemoryArtifactStore();
    const index = new MemoryRecipeIndex();
    const first = await arrangePlace(sampleFlat, spec, deps(a, store, index));
    const again = await arrangePlace(sampleFlat, spec, deps(a, store, index));
    expect(calls.n).toBe(1);
    expect(again.cached).toBe(1);
    expect(again.scene).toEqual(first.scene);
  });

  it("refuses an answer that isn't the right shape", async () => {
    const { a } = arranger(() => ({ tiles: [{ index: 0, turnDeg: 45, why: "" }] }));
    await expect(arrangePlace(sampleFlat, spec, deps(a))).rejects.toThrow(/output rejected/);
  });
});

describe("library meshes", () => {
  it("reads a model's triangles and fits them into a thing's box as the game does", async () => {
    const doc = new Document();
    const buffer = doc.createBuffer();
    // A 2 × 1 × 1 wedge, front to +z.
    const pos = doc
      .createAccessor()
      .setType("VEC3")
      .setArray(new Float32Array([0, 0, 0, 2, 0, 0, 0, 1, 1]))
      .setBuffer(buffer);
    const prim = doc.createPrimitive().setAttribute("POSITION", pos);
    doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)));
    const bytes = await new WebIO().writeBinary(doc);
    const mesh = await readLibraryMesh(bytes);
    expect(mesh?.colours).toHaveLength(1);
    // Into a 1 m × 1 m × 2 m deep box: turned a quarter, scaled to fit.
    const fitted = fitMesh(mesh!, 1, 1, 2);
    const xs = [0, 3, 6].map((i) => fitted.positions[i] as number);
    const zs = [2, 5, 8].map((i) => fitted.positions[i] as number);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(2);
  });
});
