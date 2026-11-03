import { Scene } from "@aye/schema";
import { sampleFlat } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import { understandingFromScene } from "../src/fake.ts";
import {
  cutOffSpaceNames,
  layoutFindings,
  walkFindings,
  withoutSpaces,
} from "../src/layout-check.ts";

const thing = (
  label: string,
  at: [number, number],
  sizeM: [number, number, number],
  above = 0,
) => ({
  trackId: 1,
  label,
  spaceKey: null,
  at,
  yawDeg: 0,
  sizeM,
  aboveFloorM: above,
});

describe("what code can say about a layout", () => {
  it("flags two things in the same place at the same height", () => {
    const f = layoutFindings({
      objects: [thing("big box", [1, 1], [1, 1, 2]), thing("other box", [1.2, 1], [1, 1, 2])],
    });
    expect(f).toHaveLength(1);
    expect(f[0]).toContain("big box");
  });

  it("lets things stand on each other and hang above each other", () => {
    expect(
      layoutFindings({
        objects: [
          thing("counter", [1, 1], [2, 0.6, 0.9]),
          thing("on the counter", [1, 1], [0.3, 0.3, 0.3], 0.9),
          thing("on the wall above", [1, 1], [2, 0.3, 0.7], 1.5),
        ],
      }),
    ).toEqual([]);
  });

  it("doesn't mind things side by side, or just touching", () => {
    expect(
      layoutFindings({
        objects: [
          thing("a", [0, 0], [1, 1, 1]),
          thing("b", [1, 0], [1, 1, 1]),
          thing("c", [0.95, 3], [1, 1, 1]),
        ],
      }),
    ).toEqual([]);
  });

  it("turns a footprint with the thing", () => {
    const long = { ...thing("long", [0, 0], [4, 0.5, 1]), yawDeg: 90 };
    // Turned a quarter, it runs along z, so this one isn't in its way, and this one is.
    expect(layoutFindings({ objects: [long, thing("x side", [1.5, 0], [0.5, 0.5, 1])] })).toEqual(
      [],
    );
    expect(
      layoutFindings({ objects: [long, thing("z side", [0, 1.5], [0.5, 0.5, 1])] }),
    ).toHaveLength(1);
  });

  it("says what can't be walked to, by name, and how to think about it, not what to build", () => {
    const sealed = Scene.parse({ ...sampleFlat, openings: [] });
    const names = cutOffSpaceNames(sealed);
    expect(names.length).toBeGreaterThan(0);
    const found = walkFindings(sealed);
    expect(found.some((f) => f.includes(names[0] as string))).toBe(true);
    expect(walkFindings(sampleFlat)).toEqual([]);
  });

  it("leaves out a space it never connected, with everything in it", () => {
    const u = understandingFromScene(sampleFlat);
    const space = u.spaces[0]!;
    const out = withoutSpaces(u, [space.name]);
    expect(out.spaces.some((s) => s.key === space.key)).toBe(false);
    expect(out.objects.some((o) => o.spaceKey === space.key)).toBe(false);
    expect(out.openings.some((o) => o.between.includes(space.key))).toBe(false);
    // Nothing named: nothing changes. Everything named: it can't be nothing at all.
    expect(withoutSpaces(u, [])).toBe(u);
    expect(
      withoutSpaces(
        u,
        u.spaces.map((s) => s.name),
      ),
    ).toBe(u);
  });
});
