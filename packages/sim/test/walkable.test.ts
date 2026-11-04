/** `cutOff` reports rooms and things an ordinary body can't get to, by the building alone. */
import { Scene } from "@aye/schema";
import { sampleFlat } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import { cutOff } from "../src/index.ts";

describe("can people get around a place?", () => {
  it("finds nothing wrong with a place that connects", () => {
    expect(cutOff(sampleFlat).spaces).toEqual([]);
  });

  it("finds a room with no way in", () => {
    // Take away every opening, and the rooms behind them have no way in.
    const sealed = Scene.parse({ ...sampleFlat, openings: [] });
    const cut = cutOff(sealed);
    expect(cut.spaces.length).toBeGreaterThan(0);
    expect(cut.things.length).toBeGreaterThan(0);
  });

  it("is the same every time, and leaves the scene alone", () => {
    const before = JSON.stringify(sampleFlat);
    expect(cutOff(sampleFlat)).toEqual(cutOff(sampleFlat));
    expect(JSON.stringify(sampleFlat)).toBe(before);
  });

  it("doesn't take things for walls: only the building decides what's cut off", () => {
    const first = sampleFlat.objects[0];
    if (!first) throw new Error("the sample has things");
    // A huge thing across the whole place, as a string of hanging packets looks by size alone.
    const blocked = Scene.parse({
      ...sampleFlat,
      objects: [
        ...sampleFlat.objects,
        { ...first, id: "obj_across", size: { w: 40_000, h: 1_000, d: 40_000 } },
      ],
    });
    expect(cutOff(blocked).spaces).toEqual([]);
  });
});
