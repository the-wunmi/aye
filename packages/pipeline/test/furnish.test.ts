import { MemoryArtifactStore, MemoryRecipeIndex } from "@aye/artifacts";
import { type LibraryCatalog, WorldSpec } from "@aye/schema";
import { sampleFlat, sampleSpec } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import {
  type CityFurnishRequest,
  type Furnisher,
  furnishWorld,
  NONE,
  type WorldFurnishRequest,
  worldFurnishSchema,
} from "../src/index.ts";

const src = {
  source: "https://example.org/x",
  author: "Test",
  licence: "CC0-1.0" as const,
  sha256: "0".repeat(64),
};
const catalog: LibraryCatalog = {
  format: "aye.library",
  version: 1,
  things: [
    {
      ...src,
      id: "bed_double",
      category: "thing",
      label: "Double bed",
      tags: ["bed"],
      file: "things/bed_double.glb",
      sizeMm: [1600, 600, 2000],
      style: "lowpoly",
    },
    {
      ...src,
      id: "fridge",
      category: "thing",
      label: "Fridge",
      tags: ["kitchen"],
      file: "things/fridge.glb",
      sizeMm: [600, 1800, 600],
      style: "lowpoly",
    },
  ],
  outfits: [
    {
      ...src,
      id: "man_tshirt",
      category: "outfit",
      label: "Man in a T-shirt",
      tags: ["man"],
      file: "outfits/man_tshirt.glb",
      heightMm: 1860,
      slots: { skin: ["Skin"], hair: [], top: [], bottom: [] },
    },
  ],
  surfaces: [
    {
      ...src,
      id: "floor_tiles",
      category: "surface",
      label: "Tiles",
      tags: ["tiles"],
      file: "surfaces/floor_tiles.jpg",
      tileMm: 2000,
      tintable: false,
      use: "floor",
    },
    {
      ...src,
      id: "plaster",
      category: "surface",
      label: "Plaster",
      tags: ["wall"],
      file: "surfaces/plaster.jpg",
      tileMm: 2000,
      tintable: true,
      use: "wall",
    },
  ],
  animations: null,
};

/** A furnisher that answers whatever it's told to, and counts its calls. */
function fakeFurnisher(answer: unknown) {
  const calls = { world: 0, city: 0, last: null as WorldFurnishRequest | null };
  const furnisher: Furnisher = {
    model: { provider: "test", model: "furnisher", version: "1" },
    prompt: "furnish",
    cityPrompt: "outfits",
    decoratePrompt: "decorate",
    populatePrompt: "populate",
    effort: "low",
    async furnishWorld(request) {
      calls.world++;
      calls.last = request;
      return answer;
    },
    async furnishCity(_request: CityFurnishRequest) {
      calls.city++;
      return { outfits: [] };
    },
    async populate() {
      return { groups: [] };
    },
    async decorate() {
      return { items: [] };
    },
  };
  return { furnisher, calls };
}

const deps = (furnisher: Furnisher) => ({
  furnisher,
  store: new MemoryArtifactStore(),
  index: new MemoryRecipeIndex(),
  catalog,
});

describe("furnishWorld", () => {
  it("links things only to panels the city really has", async () => {
    const { furnisher } = fakeFurnisher({
      kinds: [
        { kind: 0, asset: NONE, panel: "mobile" },
        { kind: 1, asset: NONE, panel: "<script>" },
      ],
      people: [],
      floors: [],
      walls: NONE,
    });
    const { spec } = await furnishWorld(sampleSpec, sampleFlat, {
      ...deps(furnisher),
      panels: [{ key: "mobile", label: "Mobile" }],
    });
    expect(spec.kinds[0]?.panel).toBe("mobile");
    expect(spec.kinds[1]?.panel).toBeUndefined();
  });

  it("applies the choices that are real entries of the right kind", async () => {
    const { furnisher, calls } = fakeFurnisher({
      kinds: sampleSpec.kinds.map((_, kind) => ({ kind, asset: kind === 0 ? "bed_double" : NONE })),
      people: sampleSpec.people.map((_, person) => ({ person, outfit: "man_tshirt" })),
      floors: sampleFlat.spaces.map((_, space) => ({ space, surface: "floor_tiles" })),
      walls: "plaster",
    });
    const { spec, chosen } = await furnishWorld(sampleSpec, sampleFlat, deps(furnisher));
    expect(calls.world).toBe(1);
    expect(spec.kinds[0]?.asset).toBe("bed_double");
    expect(spec.kinds.slice(1).every((k) => k.asset === undefined)).toBe(true);
    expect(spec.people.every((p) => p.outfit === "man_tshirt")).toBe(true);
    expect(spec.ground.every((g) => g.surface === "floor_tiles")).toBe(true);
    expect(spec.walls.surface).toBe("plaster");
    expect(chosen).toBe(1 + sampleSpec.people.length + sampleFlat.spaces.length + 1);
    // Only looks change: rules, people and money stay exactly as play-tested.
    expect(spec.kinds.map(({ asset: _, ...k }) => k)).toEqual(sampleSpec.kinds);
    expect(spec.people.map(({ outfit: _, ...p }) => p)).toEqual(sampleSpec.people);
    expect(WorldSpec.safeParse(spec).success).toBe(true);
  });

  it("drops anything that isn't in the catalog or is the wrong kind of entry", async () => {
    const { furnisher } = fakeFurnisher({
      kinds: [
        { kind: 0, asset: "../../etc/passwd" },
        { kind: 1, asset: "man_tshirt" }, // an outfit is not a thing
        { kind: 99, asset: "fridge" }, // no such kind
      ],
      people: [{ person: 0, outfit: "fridge" }], // a thing is not an outfit
      floors: [{ space: 0, surface: "plaster" }], // a wall surface is not a floor
      walls: "floor_tiles", // a floor is not a wall
    });
    const { spec, chosen } = await furnishWorld(sampleSpec, sampleFlat, deps(furnisher));
    expect(chosen).toBe(0);
    expect(spec.kinds.every((k) => k.asset === undefined)).toBe(true);
    expect(spec.people.every((p) => p.outfit === undefined)).toBe(true);
    expect(spec.ground.every((g) => g.surface === undefined)).toBe(true);
    expect(spec.walls.surface).toBeUndefined();
  });

  it("refuses an answer that isn't the right shape", async () => {
    const { furnisher } = fakeFurnisher({ kinds: "everything", walls: 7 });
    await expect(furnishWorld(sampleSpec, sampleFlat, deps(furnisher))).rejects.toThrow(
      /output rejected/,
    );
  });

  it("never overwrites a choice already made", async () => {
    const chosen = WorldSpec.parse({
      ...sampleSpec,
      kinds: sampleSpec.kinds.map((k, i) => (i === 0 ? { ...k, asset: "fridge" } : k)),
    });
    const { furnisher } = fakeFurnisher({
      kinds: [{ kind: 0, asset: "bed_double" }],
      people: [],
      floors: [],
      walls: NONE,
    });
    const { spec } = await furnishWorld(chosen, sampleFlat, deps(furnisher));
    expect(spec.kinds[0]?.asset).toBe("fridge");
  });

  it("replays from the recipe cache with no model call", async () => {
    const { furnisher, calls } = fakeFurnisher({
      kinds: [{ kind: 0, asset: "bed_double" }],
      people: [],
      floors: [],
      walls: NONE,
    });
    const d = deps(furnisher);
    const first = await furnishWorld(sampleSpec, sampleFlat, d);
    const again = await furnishWorld(sampleSpec, sampleFlat, d);
    expect(calls.world).toBe(1);
    expect(again.cached).toBe(1);
    expect(again.spec).toEqual(first.spec);
  });

  it("shows the model labels as data and constrains answers to real ids", async () => {
    const { furnisher, calls } = fakeFurnisher({ kinds: [], people: [], floors: [], walls: NONE });
    await furnishWorld(sampleSpec, sampleFlat, deps(furnisher));
    expect(calls.last?.library.things.map((t) => t.id)).toEqual(["bed_double", "fridge"]);
    expect(calls.last?.library.things[0]).not.toHaveProperty("file");
    const schema = worldFurnishSchema(catalog);
    expect(
      schema.safeParse({ kinds: [{ kind: 0, asset: "nope" }], people: [], floors: [], walls: NONE })
        .success,
    ).toBe(false);
  });

  it("does nothing without a library", async () => {
    const { furnisher, calls } = fakeFurnisher({});
    const empty = { ...catalog, things: [], outfits: [], surfaces: [] };
    const { spec } = await furnishWorld(sampleSpec, sampleFlat, {
      ...deps(furnisher),
      catalog: empty,
    });
    expect(calls.world).toBe(0);
    expect(spec).toBe(sampleSpec);
  });
});
