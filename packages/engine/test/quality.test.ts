/** The quality governor: when it gives up looks, leaves them alone, or gives one back. */
import { describe, expect, it } from "vitest";
import { PLACE_LOOKS, qualityGovernor } from "../src/quality.ts";

const run = (g: ReturnType<typeof qualityGovernor>, ms: number, frames: number) => {
  let changes = 0;
  for (let i = 0; i < frames; i++) if (g.frame(ms)) changes++;
  return changes;
};

describe("keeping frames quick", () => {
  it("leaves a device alone that's keeping up", () => {
    const g = qualityGovernor(0, 3);
    expect(run(g, 16, 1000)).toBe(0);
    expect(g.level).toBe(0);
    expect(g.fps).toBe(63);
  });

  it("gives up looks one step at a time while that helps, and stops at the lowest", () => {
    const g = qualityGovernor(0, 3);
    run(g, 60, 80);
    expect(g.level).toBe(1);
    run(g, 45, 80);
    expect(g.level).toBe(2);
    run(g, 32, 80);
    expect(g.level).toBe(3);
    run(g, 28, 5000);
    expect(g.level).toBe(3);
  });

  it("doesn't step back up once things are quick, so the look doesn't flicker", () => {
    const g = qualityGovernor(0, 3);
    run(g, 40, 80);
    run(g, 8, 5000);
    expect(g.level).toBe(1);
  });

  it("gives the look back if giving it up changed nothing: a 30 fps cap isn't slow drawing", () => {
    const g = qualityGovernor(1, 3);
    run(g, 33, 5000);
    expect(g.level).toBe(1);
    expect(g.fps).toBe(30);
  });

  it("doesn't count a hidden tab as slow drawing", () => {
    const g = qualityGovernor(0, 3);
    run(g, 5000, 1000);
    expect(g.level).toBe(0);
  });

  it("has a look for every level, each no heavier than the last", () => {
    for (let i = 1; i < PLACE_LOOKS.length; i++) {
      const was = PLACE_LOOKS[i - 1]!;
      const now = PLACE_LOOKS[i]!;
      expect(now.maxPixelRatio).toBeLessThanOrEqual(was.maxPixelRatio);
      expect(now.shadowEveryFrames).toBeGreaterThanOrEqual(was.shadowEveryFrames);
    }
  });
});
