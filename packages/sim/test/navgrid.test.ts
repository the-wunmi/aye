/** The nav grid's step and lip rule, on the sample flat's front door. */
import { sampleFlat } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import { buildNavGrid, cellAt, entryCells, floodFill } from "../src/index.ts";

// The flat's front door (25 mm lip) is at the top of a 180 mm step up from the yard.
describe("doors at the top of a step", () => {
  const grid = buildNavGrid(sampleFlat, sampleFlat.levels[0]!.id, { cellMm: 100 });
  const reach = (stepMm: number) =>
    floodFill(grid, entryCells(sampleFlat, grid), {
      clearWidthMm: 400,
      maxStepRiseMm: stepMm,
      maxSlopePermille: 200,
      canUseStairs: true,
    });
  const parlour = cellAt(grid, 2500, 1500);

  it("a walker steps up and over the lip into the house", () => {
    expect(reach(180)[parlour]).toBe(1);
  });

  it("wheels that can't climb the step still can't get in", () => {
    expect(reach(20)[parlour]).toBe(0);
  });
});
