/** The asset library: ids and catalog entries can only ever name files inside it. */
import { describe, expect, it } from "vitest";
import { sampleSpec } from "../src/fixtures.ts";
import { AssetId, LIBRARY_CATALOG, LibraryCatalog, libraryIndex, WorldSpec } from "../src/index.ts";

describe("asset ids", () => {
  it("are plain names, never paths, URLs or markup", () => {
    expect(AssetId.safeParse("plastic_chair").success).toBe(true);
    for (const bad of ["../x", "a/b", "https://x.y/z.glb", "<img>", "Chair", "", "a".repeat(49)]) {
      expect(AssetId.safeParse(bad).success).toBe(false);
    }
  });

  it("can be chosen for kinds, people, floors and walls, and are optional", () => {
    const furnished = {
      ...sampleSpec,
      kinds: sampleSpec.kinds.map((k) => ({ ...k, asset: "bed_double" })),
      people: sampleSpec.people.map((p) => ({ ...p, outfit: "man_tshirt" })),
      ground: sampleSpec.ground.map((g) => ({ ...g, surface: "floor_tiles" })),
      walls: { ...sampleSpec.walls, surface: "plaster" },
    };
    expect(WorldSpec.safeParse(furnished).success).toBe(true);
    expect(WorldSpec.safeParse(sampleSpec).success).toBe(true);
    const sneaky = { ...sampleSpec, walls: { ...sampleSpec.walls, surface: "../../secret" } };
    expect(WorldSpec.safeParse(sneaky).success).toBe(false);
  });
});

describe("the library catalog", () => {
  it("parses, and every file stays inside the library", () => {
    const catalog = LibraryCatalog.parse(LIBRARY_CATALOG);
    const files = [
      ...catalog.things.map((t) => t.file),
      ...catalog.outfits.map((o) => o.file),
      ...catalog.surfaces.map((s) => s.file),
      ...(catalog.animations ? [catalog.animations.file] : []),
    ];
    for (const f of files) {
      expect(f).toMatch(/^[a-z0-9_]+(\/[a-z0-9_]+)*\.(glb|jpg)$/);
      expect(f.split("/")).not.toContain("..");
    }
    expect(new Set(files).size).toBe(files.length);
  });

  it("rejects entries pointing outside the library or at other hosts", () => {
    const base = LibraryCatalog.parse({
      format: "aye.library",
      version: 1,
      things: [],
      outfits: [],
      surfaces: [],
      animations: null,
    });
    const thing = {
      id: "x",
      category: "thing",
      label: "X",
      tags: [],
      sha256: "0".repeat(64),
      sizeMm: [1, 1, 1],
      style: "lowpoly",
      source: "https://example.org",
      author: "A",
      licence: "CC0-1.0",
    };
    for (const file of ["../x.glb", "/etc/x.glb", "things/x.exe", "https://evil/x.glb"]) {
      expect(LibraryCatalog.safeParse({ ...base, things: [{ ...thing, file }] }).success).toBe(
        false,
      );
    }
    expect(
      LibraryCatalog.safeParse({
        ...base,
        things: [{ ...thing, file: "things/x.glb", licence: "GPL" }],
      }).success,
    ).toBe(false);
  });

  it("finds entries by id and category only", () => {
    const index = libraryIndex(LIBRARY_CATALOG);
    const thing = LIBRARY_CATALOG.things[0];
    if (thing) {
      expect(index.thing(thing.id)).toBe(thing);
      expect(index.outfit(thing.id)).toBeUndefined();
    }
    expect(index.thing("__proto__")).toBeUndefined();
  });
});
