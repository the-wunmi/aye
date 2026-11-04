import { describe, expect, it } from "vitest";
import { aimAhead, predict, stepTowards } from "../src/steer.ts";

const open = () => true;
/** A wall along x = 1000: nothing goes past it. */
const wall = (x: number) => x < 1000;

describe("walking your own character", () => {
  it("moves the moment there's a direction, at their speed", () => {
    const p = predict(null, { x: 0, z: 0 }, { dx: 1, dz: 0, speedMmPerS: 1000 }, 0.1, open);
    expect(p).toEqual({ x: 100, z: 0 });
  });

  it("stops at a wall, and slides along it rather than sticking", () => {
    expect(stepTowards(990, 0, 1, 0, 100, wall)).toEqual([990, 0]);
    const d = Math.SQRT1_2;
    const [x, z] = stepTowards(990, 0, d, d, 100, wall);
    expect(x).toBe(990);
    expect(z).toBeCloseTo(70.7, 0);
  });

  it("gives way to the server when they've come far apart", () => {
    const p = predict(
      { x: 9000, z: 0 },
      { x: 0, z: 0 },
      { dx: 1, dz: 0, speedMmPerS: 1000 },
      0.1,
      open,
    );
    expect(p).toEqual({ x: 0, z: 0 });
  });

  it("settles on the server's answer once they stop, and then lets go", () => {
    let p = predict({ x: 500, z: 0 }, { x: 0, z: 0 }, null, 0.1, open);
    expect(p?.x).toBeLessThan(500);
    expect(p?.x).toBeGreaterThan(0);
    for (let i = 0; i < 100 && p; i++) p = predict(p, { x: 0, z: 0 }, null, 0.1, open);
    expect(p).toBeNull();
    expect(predict(null, { x: 0, z: 0 }, null, 0.1, open)).toBeNull();
  });

  it("aims a walk as far ahead as there's floor, never into the wall", () => {
    expect(aimAhead(0, 0, 1, 0, 1800, open)).toEqual([1800, 0]);
    const [x] = aimAhead(0, 0, 1, 0, 1800, wall);
    expect(x).toBeLessThan(1000);
    expect(x).toBeGreaterThan(0);
    expect(aimAhead(999, 0, 1, 0, 1800, wall)).toEqual([999, 0]);
  });
});
