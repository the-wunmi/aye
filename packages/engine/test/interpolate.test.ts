import { describe, expect, it } from "vitest";
import { interpolatePositions } from "../src/interpolate.ts";

describe("interpolatePositions", () => {
  it("blends between snapshots and clamps alpha", () => {
    const prev = Float32Array.from([0, 0, 100, 100]);
    const next = Float32Array.from([10, 20, 100, 0]);
    const out = new Float32Array(4);
    expect([...interpolatePositions(prev, next, 0.5, out)]).toEqual([5, 10, 100, 50]);
    expect([...interpolatePositions(prev, next, 7, out)]).toEqual([10, 20, 100, 0]);
    expect([...interpolatePositions(prev, next, -1, out)]).toEqual([0, 0, 100, 100]);
  });

  it("falls back to the newest snapshot when people come or go", () => {
    const out = new Float32Array(2);
    expect([
      ...interpolatePositions(Float32Array.from([1, 1, 2, 2]), Float32Array.from([5, 6]), 0.5, out),
    ]).toEqual([5, 6]);
  });
});
