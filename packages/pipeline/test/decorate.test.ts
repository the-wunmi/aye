/**
 * Tests for decorating a place with a scripted model: what physics refuses, what people can do
 * with what's added, and that nothing becomes unreachable.
 */
import { MemoryArtifactStore, MemoryRecipeIndex } from "@aye/artifacts";
import type { LibraryCatalog, Scene, WorldSpec } from "@aye/schema";
import { sampleFlat, sampleSettings, sampleSpec } from "@aye/schema/fixtures";
import { evaluateWorld } from "@aye/sim";
import { describe, expect, it } from "vitest";
import { decoratePlace, type Furnisher } from "../src/index.ts";

const src = {
  source: "https://example.org/x",
  author: "Test",
  licence: "CC0-1.0" as const,
  sha256: "0".repeat(64),
  style: "lowpoly" as const,
  category: "thing" as const,
};
const catalog: LibraryCatalog = {
  format: "aye.library",
  version: 1,
  things: [
    {
      ...src,
      id: "drum",
      label: "Water drum",
      tags: ["water"],
      file: "things/drum.glb",
      sizeMm: [600, 900, 600],
    },
    {
      ...src,
      id: "rug",
      label: "Rug",
      tags: ["rug"],
      file: "things/rug.glb",
      sizeMm: [2000, 20, 3000],
    },
    {
      ...src,
      id: "wall",
      label: "Huge crate",
      tags: ["crate"],
      file: "things/wall.glb",
      sizeMm: [7900, 2000, 2900],
    },
    {
      ...src,
      id: "tower",
      label: "Tower",
      tags: ["building"],
      file: "things/tower.glb",
      sizeMm: [5000, 9000, 5000],
    },
    {
      ...src,
      id: "fence",
      label: "Fence",
      tags: ["fence"],
      file: "things/fence.glb",
      sizeMm: [600, 1500, 2900],
    },
  ],
  outfits: [],
  surfaces: [],
  animations: null,
};

function decorator(items: unknown[]) {
  const calls = { n: 0 };
  const furnisher: Furnisher = {
    model: { provider: "test", model: "decorator", version: "1" },
    prompt: "",
    cityPrompt: "",
    decoratePrompt: "decorate",
    populatePrompt: "populate",
    effort: "low",
    furnishWorld: async () => ({}),
    furnishCity: async () => ({}),
    populate: async () => ({ groups: [] }),
    async decorate() {
      calls.n++;
      return { items };
    },
  };
  return { furnisher, calls };
}

const critique = (scene: Scene, spec: WorldSpec) =>
  evaluateWorld(scene, spec, sampleSettings, { hours: 6 }).findings;
const deps = (furnisher: Furnisher, overrides = {}) => ({
  furnisher,
  store: new MemoryArtifactStore(),
  index: new MemoryRecipeIndex(),
  catalog,
  critique,
  settings: sampleSettings,
  ...overrides,
});

// The yard is space 0 (x 0..8 m, z -3..0 m); the gate is at (2.5, -3), the door at (2.5, 0).
describe("decoratePlace", () => {
  it("adds library things where physics allows, as set dressing with code ids", async () => {
    const { furnisher } = decorator([
      { asset: "drum", space: 0, x: 6.0, z: -1.0, yawDeg: 0 }, // fine
      { asset: "drum", space: 0, x: 2.5, z: -2.6, yawDeg: 0 }, // in the gateway: refused
      { asset: "drum", space: 0, x: 7.0, z: -2.0, yawDeg: 0 }, // on the generator: refused
      { asset: "drum", space: 0, x: 20, z: 20, yawDeg: 0 }, // outside the place: refused
      { asset: "tower", space: 0, x: 4, z: -1.5, yawDeg: 0 }, // buildings aren't dressing
      { asset: "rug", space: 1, x: 2.5, z: 1.7, yawDeg: 90 }, // flat: may lie under things
      { asset: "nope", space: 0, x: 1, z: -1, yawDeg: 0 }, // not in the library
    ]);
    const { scene, spec, added } = await decoratePlace(sampleFlat, sampleSpec, deps(furnisher));
    expect(added).toBe(2);
    const fresh = scene.objects.slice(sampleFlat.objects.length);
    expect(fresh.map((o) => o.label)).toEqual(["Water drum", "Rug"]);
    expect(fresh.every((o) => /^obj_/.test(o.id))).toBe(true);
    const kinds = spec.kinds.slice(sampleSpec.kinds.length);
    expect(kinds.map((k) => [k.asset, k.solid, k.actions.length])).toEqual([
      ["drum", true, 0],
      ["rug", false, 0],
    ]);
    // The rules of the place are exactly as they were.
    expect(spec.kinds.slice(0, sampleSpec.kinds.length)).toEqual(sampleSpec.kinds);
  });

  describe("what people do with it", () => {
    const sitting = {
      key: "sit",
      label: "Sit",
      durationMin: 30,
      capacity: 2,
      cost: 0,
      income: 0,
      requires: [],
      needs: [{ need: "energy", perHour: 100 }],
      sets: [],
      leaves: "no" as const,
      pose: "sit" as const,
      on: true,
    };
    const answering = (uses: unknown, items: unknown) =>
      ({
        ...decorator([]).furnisher,
        decorate: async () => ({ items, uses }),
      }) as Furnisher;
    const firstAsset = catalog.things[0]?.id as string;
    const inYard = [{ asset: firstAsset, space: 0, x: 6, z: -1.5, yawDeg: 0 }];

    it("gives the things it chose what the model says people do with them", async () => {
      const uses = [{ asset: firstAsset, actions: [sitting] }];
      const out = await decoratePlace(sampleFlat, sampleSpec, deps(answering(uses, inYard)));
      expect(out.added).toBe(1);
      const kind = out.spec.kinds.find((k) => k.asset === firstAsset);
      expect(kind?.actions.map((a) => a.label)).toEqual(["Sit"]);
    });

    it("leaves what nobody would use as scenery", async () => {
      const out = await decoratePlace(sampleFlat, sampleSpec, deps(answering([], inYard)));
      expect(out.spec.kinds.find((k) => k.asset === firstAsset)?.actions).toEqual([]);
    });

    it("drops the uses, keeps the thing, if the uses would break the place", async () => {
      const uses = [{ asset: firstAsset, actions: [sitting] }];
      const breaks = (_: Scene, spec: WorldSpec) =>
        spec.kinds.some((k) => k.asset === firstAsset && k.actions.length > 0)
          ? [{ severity: "error", message: "no" }]
          : [];
      const out = await decoratePlace(
        sampleFlat,
        sampleSpec,
        deps(answering(uses, inYard), { critique: breaks }),
      );
      expect(out.added).toBe(1);
      expect(out.spec.kinds.find((k) => k.asset === firstAsset)?.actions).toEqual([]);
    });
  });

  it("a seat used 'alone' is still used here: nobody leaves the place on a bench", async () => {
    const asset = catalog.things[0]?.id as string;
    const furnisher = {
      ...decorator([]).furnisher,
      decorate: async () => ({
        items: [{ asset, space: 0, x: 6, z: -1.5, yawDeg: 0 }],
        uses: [
          {
            asset,
            actions: [
              {
                key: "sit",
                label: "Sit",
                durationMin: 30,
                capacity: 1,
                cost: 0,
                income: 0,
                requires: [],
                needs: [{ need: "energy", perHour: 100 }],
                sets: [],
                leaves: "alone" as const,
                pose: "sit" as const,
                on: true,
              },
            ],
          },
        ],
      }),
    } as Furnisher;
    const out = await decoratePlace(sampleFlat, sampleSpec, deps(furnisher));
    const sit = out.spec.kinds.find((k) => k.asset === asset)?.actions[0];
    expect(sit?.label).toBe("Sit");
    expect(sit?.leaves).toBeNull();
  });

  it("one thing's uses breaking the place leave the others' alone", async () => {
    const [good, bad] = catalog.things;
    const sitting = {
      key: "sit",
      label: "Sit",
      durationMin: 30,
      capacity: 2,
      cost: 0,
      income: 0,
      requires: [],
      needs: [{ need: "energy", perHour: 100 }],
      sets: [],
      leaves: "no" as const,
      pose: "sit" as const,
      on: true,
    };
    const furnisher = {
      ...decorator([]).furnisher,
      decorate: async () => ({
        items: [
          { asset: good?.id, space: 0, x: 6, z: -1.5, yawDeg: 0 },
          { asset: bad?.id, space: 0, x: 7.5, z: -1.5, yawDeg: 0 },
        ],
        uses: [
          { asset: good?.id, actions: [sitting] },
          { asset: bad?.id, actions: [sitting] },
        ],
      }),
    } as Furnisher;
    const breaks = (_: Scene, spec: WorldSpec) =>
      spec.kinds.some((k) => k.asset === bad?.id && k.actions.length > 0)
        ? [{ severity: "error", message: "no" }]
        : [];
    const out = await decoratePlace(sampleFlat, sampleSpec, deps(furnisher, { critique: breaks }));
    expect(out.spec.kinds.find((k) => k.asset === good?.id)?.actions.length).toBe(1);
    expect(out.spec.kinds.find((k) => k.asset === bad?.id)?.actions ?? []).toEqual([]);
  });

  it("pares back dressing that would block what people could do", async () => {
    const { furnisher } = decorator([{ asset: "wall", space: 0, x: 4, z: -1.5, yawDeg: 0 }]);
    // Whatever physics allows, the replay decides: pretend the big crate blocks a need.
    const strict = (scene: Scene, spec: WorldSpec) =>
      scene.objects.some((o) => o.label === "Huge crate")
        ? [{ severity: "error", message: "blocked" }]
        : critique(scene, spec);
    const { added, scene } = await decoratePlace(
      sampleFlat,
      sampleSpec,
      deps(furnisher, { critique: strict }),
    );
    expect(added).toBe(0);
    expect(scene).toBe(sampleFlat);
  });

  it("never boxes in something people could reach before", async () => {
    // A fence across the whole yard would cut the generator (east end) off from the gate.
    const { furnisher } = decorator([
      { asset: "drum", space: 0, x: 4.5, z: -0.8, yawDeg: 0 },
      { asset: "fence", space: 0, x: 6.0, z: -1.5, yawDeg: 0 },
    ]);
    // A play-test that notices nothing: reach alone must catch it.
    const { scene, added } = await decoratePlace(
      sampleFlat,
      sampleSpec,
      deps(furnisher, { critique: () => [] }),
    );
    const labels = scene.objects.slice(sampleFlat.objects.length).map((o) => o.label);
    expect(labels).not.toContain("Fence");
    expect(labels).toContain("Water drum");
    expect(added).toBe(1);
  });

  it("decorates once, and replays with no model call", async () => {
    const { furnisher, calls } = decorator([{ asset: "drum", space: 0, x: 6, z: -1, yawDeg: 0 }]);
    const d = deps(furnisher);
    const first = await decoratePlace(sampleFlat, sampleSpec, d);
    const again = await decoratePlace(sampleFlat, sampleSpec, d);
    expect(calls.n).toBe(1);
    expect(again.cached).toBe(1);
    expect(again.scene).toEqual(first.scene);
    // A decorated place is left alone.
    const twice = await decoratePlace(first.scene, first.spec, d);
    expect(twice.added).toBe(0);
    expect(calls.n).toBe(1);
  });

  it("refuses an answer that isn't the right shape", async () => {
    const { furnisher } = decorator([{ asset: 7 }]);
    await expect(decoratePlace(sampleFlat, sampleSpec, deps(furnisher))).rejects.toThrow(
      /output rejected/,
    );
  });
});
