/** Placement physics: what walls, solid things and door widths allow an edit to do. */
import type { ObjectId, Scene } from "@aye/schema";
import { sampleFlat, sampleSpec } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import { PlacementField, placementProblem, solidity } from "../src/index.ts";

const catalog = solidity(sampleSpec);
const moved = (id: string, position: [number, number, number], yawDeg?: number): Scene => ({
  ...sampleFlat,
  objects: sampleFlat.objects.map((o) =>
    o.id === id ? { ...o, transform: { position, yawDeg: yawDeg ?? o.transform.yawDeg } } : o,
  ),
});

describe("placement physics", () => {
  it("every object in the sample flat is validly placed where it stands", () => {
    for (const o of sampleFlat.objects) {
      expect(PlacementField.for(sampleFlat, catalog, o.id).problem(o.transform), o.id).toBeNull();
    }
  });

  it("furniture can be moved and turned within its room", () => {
    expect(
      placementProblem(sampleFlat, moved("obj_chair", [3000, 0, 1500], 90), catalog),
    ).toBeNull();
  });

  it("nothing goes into a wall", () => {
    // The living/bedroom wall runs along z = 3500; its doors are at x = 3200, 4600 and 7000.
    expect(placementProblem(sampleFlat, moved("obj_chair", [1500, 0, 3500]), catalog)).toMatch(
      /wall/,
    );
  });

  it("solid things don't overlap", () => {
    expect(placementProblem(sampleFlat, moved("obj_chair", [1200, 0, 3000]), catalog)).toMatch(
      /bump into the brown leather three-seater/,
    );
  });

  it("things are carried through doors, never through walls, and only if they fit", () => {
    // The armchair fits through the 800 mm bedroom door; the sofa (850 mm at its slimmest)
    // doesn't, and nothing gets in once the door is walled up.
    expect(placementProblem(sampleFlat, moved("obj_chair", [2800, 0, 4500]), catalog)).toBeNull();
    expect(placementProblem(sampleFlat, moved("obj_sofa", [2900, 0, 4200]), catalog)).toMatch(
      /carry/,
    );
    const noDoor = {
      ...sampleFlat,
      openings: sampleFlat.openings.filter((o) => o.id !== "opn_bedroom"),
    };
    const chairIn = moved("obj_chair", [2800, 0, 4500]);
    expect(placementProblem(noDoor, { ...chairIn, openings: noDoor.openings }, catalog)).toMatch(
      /carry/,
    );
  });

  it("stays inside the place", () => {
    expect(placementProblem(sampleFlat, moved("obj_chair", [-5000, 0, 1500]), catalog)).toMatch(
      /outside/,
    );
  });

  it("checks only what changed", () => {
    const id = "obj_cooker" as ObjectId;
    expect(placementProblem(sampleFlat, sampleFlat, catalog)).toBeNull();
    expect(
      PlacementField.for(sampleFlat, catalog, id).problem({ position: [6000, 0, 400], yawDeg: 0 }),
    ).toBeNull();
  });
});
