import { type Scene, Scene as SceneSchema } from "@aye/schema";
import { sampleFlat } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import { buildNavGrid, cellAt, Flag, objectUseCells } from "../src/index.ts";

const levelId = sampleFlat.levels[0]!.id;

/** The sample flat, plus a counter and something standing on it. */
function withCounter(): { scene: Scene; bottle: Scene["objects"][number] } {
  const fridge = sampleFlat.objects.find((o) => o.id === "obj_fridge")!;
  const bottle = {
    ...fridge,
    id: "obj_bottle" as typeof fridge.id,
    size: { w: 100, d: 100, h: 200 },
  };
  const scene = SceneSchema.parse({ ...sampleFlat, objects: [...sampleFlat.objects, bottle] });
  return { scene, bottle };
}

describe("where things are used from", () => {
  it("reaches something standing on furniture, from the floor in front of it", () => {
    const { scene, bottle } = withCounter();
    const grid = buildNavGrid(scene, levelId, {
      cellMm: 100,
      isSolid: (o) => o.id !== bottle.id,
    });
    // It stands inside the fridge's footprint: solid all around it.
    const at = cellAt(grid, bottle.transform.position[0], bottle.transform.position[2]);
    expect((grid.flags[at] as number) & Flag.Blocked).toBeTruthy();
    const cells = objectUseCells(grid, bottle, 700);
    expect(cells.length).toBeGreaterThan(0);
    // Only ever floor: nobody stands in the fridge.
    for (const c of cells) expect((grid.flags[c] as number) & Flag.Blocked).toBe(0);
  });

  it("stands beside what isn't solid, not inside it, so its sides don't hide them", () => {
    const { scene, bottle } = withCounter();
    const stall = {
      ...bottle,
      id: "obj_stall" as typeof bottle.id,
      size: { w: 1000, d: 1000, h: 2000 },
      transform: {
        ...bottle.transform,
        position: sampleFlat.objects[0]!.transform.position,
      },
    };
    const open = SceneSchema.parse({ ...scene, objects: [stall] });
    const grid = buildNavGrid(open, levelId, { cellMm: 100, isSolid: () => false });
    const cells = objectUseCells(grid, stall, 700);
    expect(cells.length).toBeGreaterThan(0);
    const [cx, , cz] = stall.transform.position;
    expect(cells).not.toContain(cellAt(grid, cx, cz));
  });

  it("never reaches through a wall", () => {
    const wall = sampleFlat.walls[0]!;
    // A thing hard against one side of a wall, with nothing else around it.
    const [ax, az] = wall.a;
    const [bx, bz] = wall.b;
    const cx = (ax + bx) / 2;
    const cz = (az + bz) / 2;
    const horizontal = Math.abs(bx - ax) >= Math.abs(bz - az);
    const offset = wall.thicknessMm / 2 + 60;
    const base = sampleFlat.objects[0]!;
    const thing = {
      ...base,
      id: "obj_onewall" as typeof base.id,
      size: { w: 100, d: 100, h: 200 },
      transform: {
        ...base.transform,
        yawDeg: 0,
        position: [
          horizontal ? cx : cx + offset,
          base.transform.position[1],
          horizontal ? cz + offset : cz,
        ] as typeof base.transform.position,
      },
    };
    const scene = SceneSchema.parse({ ...sampleFlat, objects: [...sampleFlat.objects, thing] });
    const grid = buildNavGrid(scene, levelId, { cellMm: 100, isSolid: (o) => o.id !== thing.id });
    const cells = objectUseCells(grid, thing, 700);
    // Everything it's used from is on its own side of the wall.
    for (const c of cells) {
      const x = grid.originX + (c % grid.width) * grid.cellMm + grid.cellMm / 2;
      const z = grid.originZ + Math.floor(c / grid.width) * grid.cellMm + grid.cellMm / 2;
      const side = horizontal ? z - cz : x - cx;
      expect(side).toBeGreaterThan(0);
    }
  });

  it("lets people walk under what's over their heads, but not into what's at head height", () => {
    const base = sampleFlat.objects[0]!;
    const floor = sampleFlat.spaces[0]!.polygon;
    const cx = Math.round(floor.reduce((t, p) => t + p[0], 0) / floor.length);
    const cz = Math.round(floor.reduce((t, p) => t + p[1], 0) / floor.length);
    const at = (y: number) => ({
      ...base,
      id: "obj_hanging" as typeof base.id,
      size: { w: 400, d: 400, h: 300 },
      transform: { yawDeg: 0, position: [cx, y, cz] as typeof base.transform.position },
    });
    const blocked = (y: number) => {
      const scene = SceneSchema.parse({ ...sampleFlat, objects: [at(y)] });
      const grid = buildNavGrid(scene, levelId, { cellMm: 100 });
      return Boolean((grid.flags[cellAt(grid, cx, cz)] as number) & Flag.Object);
    };
    expect(blocked(0)).toBe(true);
    expect(blocked(1_400)).toBe(true);
    expect(blocked(2_100)).toBe(false);
  });
});
