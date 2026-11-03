import { type LevelId, type ObjectId, Scene } from "@aye/schema";
import { sampleFlat, sampleSettings, sampleSpec } from "@aye/schema/fixtures";
import { buildNavGrid, cellAt, cutOff, entryCells, floodFill } from "@aye/sim";
import { describe, expect, it } from "vitest";
import {
  bringInside,
  bringWithinReach,
  clearWays,
  makeWayThrough,
  openSealedSpaces,
} from "../src/clear-ways.ts";

// The parlour's front door is at (2500, 0); the parlour is x 0..5000, z 0..3500.
const parlour = sampleFlat.spaces.find((s) => s.name === "Parlour");
const bedAcrossDoor = (scene: Scene): Scene => ({
  ...scene,
  objects: scene.objects.map((o) =>
    o.label.startsWith("Brown leather")
      ? {
          ...o,
          spaceId: parlour?.id ?? o.spaceId,
          transform: { position: [2300, 0, 600], yawDeg: 0 },
        }
      : o,
  ),
});

describe("clearWays", () => {
  it("slides what stands in a doorway out of its way, staying in its room", () => {
    const blocked = bedAcrossDoor(sampleFlat);
    const sofa = (s: Scene) => s.objects.find((o) => o.label.startsWith("Brown leather"));
    const { scene, moved } = clearWays(blocked);
    expect(moved).toBeGreaterThanOrEqual(1);
    const [x, , z] = sofa(scene)?.transform.position ?? [0, 0, 0];
    // Out of the door's approach (700 mm deep) or beside it, still inside the parlour.
    const clear = z - 450 >= 700 || x + 950 <= 2500 - 600 || x - 950 >= 2500 + 600;
    expect(clear).toBe(true);
    expect(x - 950).toBeGreaterThanOrEqual(0);
    expect(x + 950).toBeLessThanOrEqual(5000);
    // Cleared once, it stays put.
    expect(clearWays(scene).moved).toBe(0);
  });

  it("leaves a layout whose ways are clear exactly as it was", () => {
    const { scene, moved } = clearWays(sampleFlat);
    expect(moved).toBe(0);
    expect(scene.objects.map((o) => o.transform)).toEqual(
      sampleFlat.objects.map((o) => o.transform),
    );
  });

  it("is deterministic", () => {
    const a = clearWays(bedAcrossDoor(sampleFlat)).scene;
    const b = clearWays(bedAcrossDoor(sampleFlat)).scene;
    expect(a).toEqual(b);
    expect(a.objects.every((o) => Number.isInteger(o.transform.position[0]))).toBe(true);
    expect(a.objects.find((o) => o.id === ("" as ObjectId))).toBeUndefined();
  });
});

describe("openSealedSpaces", () => {
  it("cuts a doorway into a room nobody could walk into", () => {
    // Brick up the bedroom's only door.
    const sealed: Scene = {
      ...sampleFlat,
      openings: sampleFlat.openings.filter((o) => o.id !== "opn_bedroom"),
    };
    const { scene, opened } = openSealedSpaces(sealed);
    expect(opened).toEqual(["Bedroom"]);
    const fresh = scene.openings.filter((o) => !sealed.openings.some((p) => p.id === o.id));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.kind).toBe("doorway");
    expect(fresh[0]?.id).toMatch(/^opn_/);
    // And again: nothing left to open.
    expect(openSealedSpaces(scene).opened).toEqual([]);
  });

  it("leaves a place everyone can walk around alone", () => {
    const { scene, opened } = openSealedSpaces(sampleFlat);
    expect(opened).toEqual([]);
    expect(scene).toBe(sampleFlat);
  });
});

describe("bringInside", () => {
  // The standing fan, placed in solid ground beyond the parlour's east wall.
  const astray: Scene = {
    ...sampleFlat,
    objects: sampleFlat.objects.map((o) =>
      o.label === "Standing fan"
        ? { ...o, transform: { position: [9500, 0, 1600], yawDeg: 0 } }
        : o,
    ),
  };

  it("brings something standing outside the place into its own space", () => {
    const { scene, moved } = bringInside(astray);
    expect(moved).toEqual(["Standing fan"]);
    const fan = scene.objects.find((o) => o.label === "Standing fan");
    const [x, , z] = fan?.transform.position ?? [0, 0, 0];
    // Inside the parlour (x 0..5000, z 0..3500), with its whole footprint.
    expect(x - 225).toBeGreaterThanOrEqual(0);
    expect(x + 225).toBeLessThanOrEqual(5000);
    expect(z - 225).toBeGreaterThanOrEqual(0);
    expect(z + 225).toBeLessThanOrEqual(3500);
    expect(fan?.spaceId).toBe("spc_living");
    // Nothing else moved.
    const others = (s: Scene) => s.objects.filter((o) => o.label !== "Standing fan");
    expect(others(scene)).toEqual(others(astray));
  });

  it("leaves a place where everything is inside alone, and is deterministic", () => {
    expect(bringInside(sampleFlat)).toEqual({ scene: sampleFlat, moved: [] });
    expect(bringInside(astray)).toEqual(bringInside(astray));
  });
});

/** Can someone get from the way in to the far end, with these things solid? */
function labelsReach(scene: Scene, isSolid: (o: Scene["objects"][number]) => boolean): boolean {
  const level = scene.levels[0];
  if (!level) return false;
  const grid = buildNavGrid(scene, level.id, { cellMm: 100, isSolid });
  const body = { clearWidthMm: 450, maxStepRiseMm: 200, maxSlopePermille: 150, canUseStairs: true };
  const reached = floodFill(grid, entryCells(scene, grid), body);
  return reached[cellAt(grid, 2000, 5000)] === 1;
}

describe("makeWayThrough", () => {
  const room = (id: string, x0: number, x1: number) => ({
    id,
    levelId: "lvl_aaaaaaaa",
    name: id,
    polygon: [
      [x0, 0],
      [x1, 0],
      [x1, 6000],
      [x0, 6000],
    ],
    floorOffsetMm: 0,
    ceilingMm: 2800,
  });
  const box = (id: string, x: number, z: number, w: number, d: number) => ({
    ...(sampleFlat.objects[0] as Scene["objects"][number]),
    id,
    levelId: "lvl_aaaaaaaa",
    spaceId: "spc_aaaaaaaa",
    trackId: undefined,
    label: id,
    size: { w, h: 1000, d },
    transform: { position: [x, 0, z] as [number, number, number], yawDeg: 0, scale: 1 },
  });
  // One long room, with two things side by side right across it: together they close it, and
  // neither would alone.
  const sealed = (objects: unknown[]) =>
    Scene.parse({
      ...sampleFlat,
      levels: [
        {
          id: "lvl_aaaaaaaa",
          name: "Ground",
          elevationMm: 0,
          footprint: [
            [0, 0],
            [4000, 0],
            [4000, 6000],
            [0, 6000],
          ],
        },
      ],
      spaces: [room("spc_aaaaaaaa", 0, 4000)],
      walls: [],
      openings: [],
      levelChanges: [],
      objects,
      portals: [
        {
          id: "prt_aaaaaaaa",
          levelId: "lvl_aaaaaaaa",
          at: [2000, 100],
          yawDeg: 0,
          widthMm: 1000,
          label: "In",
        },
      ],
      entry: "prt_aaaaaaaa",
    });

  it("clears what's solid in the finished world, even if it looks too low to matter", () => {
    const low = (id: string, x: number) => ({
      ...box(id, x, 3000, 2000, 600),
      size: { w: 2000, h: 250, d: 600 },
    });
    const scene = sealed([low("obj_aaaaaaaa", 1000), low("obj_bbbbbbbb", 3000)]);
    expect(makeWayThrough(scene).moved).toEqual([]);
    expect(cutOff(scene).spaces).toEqual([]);
    const moved = makeWayThrough(scene, () => true);
    expect(moved.moved.length).toBeGreaterThan(0);
    const blocked = (o: Scene["objects"][number]) => o.size.h > 0;
    const open = (at: Scene) => labelsReach(at, blocked);
    expect(open(scene)).toBe(false);
    expect(open(moved.scene)).toBe(true);
  });

  it("turns what can't be slid out of the way", () => {
    // A narrow passage, and a bench right across it: sliding along it only moves the problem.
    const passage = (bench: unknown) => {
      const footprint = [
        [0, 0],
        [1400, 0],
        [1400, 6000],
        [0, 6000],
      ];
      return Scene.parse({
        ...sealed([bench]),
        levels: [{ id: "lvl_aaaaaaaa", name: "Ground", elevationMm: 0, footprint }],
        spaces: [{ ...room("spc_aaaaaaaa", 0, 1400) }],
        portals: [
          {
            id: "prt_aaaaaaaa",
            levelId: "lvl_aaaaaaaa",
            at: [700, 100],
            yawDeg: 0,
            widthMm: 1000,
            label: "In",
          },
        ],
      });
    };
    const scene = passage(box("obj_aaaaaaaa", 700, 3000, 1100, 300));
    const { scene: out, moved } = makeWayThrough(scene, () => true);
    expect(moved).toEqual(["obj_aaaaaaaa"]);
    expect(cutOff(out, () => true).spaces).toEqual([]);
    expect(out.objects[0]?.transform.yawDeg).toBe(90);
    expect(makeWayThrough(scene, () => true)).toEqual({ scene: out, moved });
  });

  it("opens a floor that two things close only together", () => {
    const scene = sealed([
      box("obj_aaaaaaaa", 1000, 3000, 2000, 600),
      box("obj_bbbbbbbb", 3000, 3000, 2000, 600),
    ]);
    const { scene: out, moved } = makeWayThrough(scene);
    expect(moved.length).toBeGreaterThan(0);
    const grid = buildNavGrid(out, "lvl_aaaaaaaa" as LevelId, { cellMm: 100, isSolid: () => true });
    const reach = floodFill(grid, entryCells(out, grid), {
      clearWidthMm: 400,
      maxStepRiseMm: 180,
      maxSlopePermille: 200,
      canUseStairs: true,
    });
    expect(reach[cellAt(grid, 2000, 5500)]).toBe(1);
    // ...and it doesn't throw anything out, or out of the room.
    expect(out.objects).toHaveLength(2);
    for (const o of out.objects) {
      expect(o.transform.position[0] - o.size.w / 2).toBeGreaterThanOrEqual(0);
      expect(o.transform.position[0] + o.size.w / 2).toBeLessThanOrEqual(4000);
    }
    // The same every time.
    expect(makeWayThrough(scene)).toEqual(makeWayThrough(scene));
  });

  it("leaves a place that already connects alone, however close things stand", () => {
    const scene = sealed([box("obj_aaaaaaaa", 1000, 3000, 1000, 600)]);
    expect(makeWayThrough(scene)).toEqual({ scene, moved: [] });
    expect(makeWayThrough(sampleFlat).moved).toEqual([]);
  });
});

describe("bringWithinReach", () => {
  /** The chair, boxed into the parlour's corner by the sofa and the table standing around it. */
  const box = (): { scene: Scene; id: string } => {
    const room = sampleFlat.spaces.find((s) => s.name === "Parlour");
    const chair = sampleFlat.objects.find((o) => o.id === "obj_chair");
    if (!room || !chair) throw new Error("the sample flat changed");
    const wall = (name: string, x: number, z: number, w: number, d: number) => ({
      ...chair,
      id: name as ObjectId,
      label: name,
      spaceId: room.id,
      size: { ...chair.size, w, d },
      transform: { position: [x, 0, z] as [number, number, number], yawDeg: 0 },
    });
    const scene: Scene = {
      ...sampleFlat,
      objects: [
        ...sampleFlat.objects.map((o) =>
          o.id === chair.id
            ? {
                ...o,
                spaceId: room.id,
                transform: { position: [500, 0, 3000] as [number, number, number], yawDeg: 0 },
              }
            : o,
        ),
        wall("obj_box_a", 1300, 3000, 300, 1000),
        wall("obj_box_b", 500, 2200, 1900, 300),
      ],
    };
    return { scene, id: chair.id };
  };

  const spec = {
    ...sampleSpec,
    kinds: [
      ...sampleSpec.kinds,
      { ...(sampleSpec.kinds[0] as (typeof sampleSpec.kinds)[number]), key: "boxing", actions: [] },
    ],
    things: [
      ...sampleSpec.things,
      { ...sampleSpec.things[0], object: "obj_box_a" as ObjectId, kind: "boxing" },
      { ...sampleSpec.things[0], object: "obj_box_b" as ObjectId, kind: "boxing" },
    ],
  } as typeof sampleSpec;

  it("moves what nobody can get to, inside its own space, and is deterministic", () => {
    const { scene, id } = box();
    const first = bringWithinReach(scene, spec, sampleSettings);
    expect(first.moved).toEqual([id]);
    const after = first.scene.objects.find((o) => o.id === id);
    const before = scene.objects.find((o) => o.id === id);
    expect(after?.transform).not.toEqual(before?.transform);
    expect(after?.spaceId).toBe(before?.spaceId);
    expect(bringWithinReach(scene, spec, sampleSettings)).toEqual(first);
    expect(bringWithinReach(first.scene, spec, sampleSettings).moved).toEqual([]);
  });

  it("leaves a place alone when everything can be reached", () => {
    const { scene, moved } = bringWithinReach(sampleFlat, sampleSpec, sampleSettings);
    expect(moved).toEqual([]);
    expect(scene).toBe(sampleFlat);
  });
});
