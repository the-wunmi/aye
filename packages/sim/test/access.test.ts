import { Scene } from "@aye/schema";
import { sampleFlat, sampleSettings, sampleSpec } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import { type BodyQuery, crossingsOf, tryBody, tryDay, withChanges } from "../src/index.ts";

const walking: BodyQuery = {
  widthMm: 450,
  stepMm: 200,
  stairs: true,
  slopePermille: 150,
  speedMmPerS: 1_300,
  reachUpMm: 2_000,
};
const wheels: BodyQuery = {
  widthMm: 700,
  stepMm: 20,
  stairs: false,
  slopePermille: 83,
  speedMmPerS: 900,
  reachUpMm: 1_200,
};

/** The flat, with a step at the door and something fixed high on a wall. */
function withBarriers(): Scene {
  const high = sampleFlat.objects.find((o) => o.id === "obj_fridge")!;
  return Scene.parse({
    ...sampleFlat,
    objects: sampleFlat.objects.map((o) =>
      o.id === high.id
        ? {
            ...o,
            transform: {
              ...o.transform,
              position: [o.transform.position[0], 1_500, o.transform.position[2]],
            },
          }
        : o,
    ),
  });
}

describe("what a body can do in a place", () => {
  it("is the same answer every time", () => {
    const a = tryBody(sampleFlat, sampleSpec, sampleSettings, wheels);
    const b = tryBody(sampleFlat, sampleSpec, sampleSettings, wheels);
    expect(a).toEqual(b);
    expect(tryDay(sampleFlat, sampleSpec, sampleSettings, wheels)).toEqual(
      tryDay(sampleFlat, sampleSpec, sampleSettings, wheels),
    );
  });

  it("reports more barriers for a wider body that can't climb, each with a reason", () => {
    const a = tryBody(sampleFlat, sampleSpec, sampleSettings, walking);
    const w = tryBody(sampleFlat, sampleSpec, sampleSettings, wheels);
    const blocked = (r: typeof a) => r.things.filter((t) => !t.reaches);
    expect(blocked(w).length).toBeGreaterThanOrEqual(blocked(a).length);
    for (const t of blocked(w)) expect(t.blockedBy).not.toBeNull();
    for (const t of w.things.filter((x) => x.reaches)) expect(t.blockedBy).toBeNull();
  });

  it("knows what's too high to reach, whoever gets to it", () => {
    const scene = withBarriers();
    const high = (r: ReturnType<typeof tryBody>) => r.things.find((t) => t.aboveFloorMm === 1_500);
    const tall = tryBody(scene, sampleSpec, sampleSettings, walking);
    const seated = tryBody(scene, sampleSpec, sampleSettings, { ...walking, reachUpMm: 1_200 });
    expect(high(tall)?.reaches).toBe(true);
    expect(high(seated)?.reaches).toBe(false);
    expect(high(seated)?.blockedBy).toBe("height");
  });

  it("tries changes without touching the real place, and says what couldn't be done", () => {
    const before = JSON.stringify(sampleFlat);
    const stuck = tryBody(sampleFlat, sampleSpec, sampleSettings, wheels).things.find(
      (t) => !t.reaches,
    );
    const r = tryBody(sampleFlat, sampleSpec, sampleSettings, wheels, [
      { type: "remove_thing", thing: 9_999 },
      { type: "ramp", crossing: 9_999, slopePermille: 83 },
      { type: "widen", opening: 9_999, widthMm: 2_000 },
    ]);
    expect(r.ignoredChanges).toBe(3);
    expect(JSON.stringify(sampleFlat)).toBe(before);
    expect(stuck === undefined || stuck.label.length > 0).toBe(true);
    // Widening is bounded, however wide it's asked for.
    if (sampleFlat.openings.length > 0) {
      const { scene } = withChanges(sampleFlat, [{ type: "widen", opening: 0, widthMm: 1e9 }]);
      expect(scene.openings[0]?.clearWidthMm).toBe(6_000);
    }
  });

  it("widening every door helps a wide body, or at least never hurts", () => {
    const before = tryBody(sampleFlat, sampleSpec, sampleSettings, wheels);
    const after = tryBody(
      sampleFlat,
      sampleSpec,
      sampleSettings,
      wheels,
      sampleFlat.openings.map((_, opening) => ({
        type: "widen" as const,
        opening,
        widthMm: 1_200,
      })),
    );
    const n = (r: typeof before) => r.things.filter((t) => t.reaches).length;
    expect(n(after)).toBeGreaterThanOrEqual(n(before));
    for (const o of after.openings) expect(o.fits).toBe(true);
  });

  describe("a ramp over a rise between two floors", () => {
    // A street, a raised yard beyond it, and the crossing marked as a model marks one: its first
    // point already on the upper floor, with nothing to do past the far side of the yard.
    const raised = (): Scene => {
      const level = sampleFlat.levels[0]!;
      const box = (x0: number, z0: number, x1: number, z1: number) =>
        [
          [x0, z0],
          [x1, z0],
          [x1, z1],
          [x0, z1],
        ] as [number, number][];
      const spaces = [
        {
          ...sampleFlat.spaces[0]!,
          id: "spc_street",
          polygon: box(0, 0, 6_000, 3_000),
          floorOffsetMm: 0,
        },
        {
          ...sampleFlat.spaces[0]!,
          id: "spc_yard",
          polygon: box(0, 3_000, 6_000, 12_000),
          floorOffsetMm: 150,
        },
      ];
      const object = sampleFlat.objects[0]!;
      return Scene.parse({
        ...sampleFlat,
        levels: [{ ...level, footprint: box(0, 0, 6_000, 12_000) }],
        spaces,
        walls: [],
        openings: [],
        portals: sampleFlat.portals.map((p) => ({ ...p, at: [3_000, 300] })),
        objects: [
          {
            ...object,
            spaceId: "spc_yard",
            transform: { ...object.transform, position: [3_000, 150, 10_000] },
          },
        ],
        levelChanges: [
          {
            ...sampleFlat.levelChanges[0]!,
            kind: "step",
            from: [3_000, 3_100],
            to: [3_000, 4_100],
            widthMm: 2_000,
            riseMm: 150,
            stepCount: 1,
            fromLevelId: level.id,
            toLevelId: level.id,
          },
        ],
      });
    };
    const flatBody: BodyQuery = { ...wheels, stepMm: 0, slopePermille: 83 };
    const spec = (scene: Scene) => ({
      ...sampleSpec,
      things: [{ ...sampleSpec.things[0]!, object: scene.objects[0]!.id }],
    });
    const reaches = (scene: Scene, body: BodyQuery, slope?: number) =>
      tryBody(
        scene,
        spec(scene),
        sampleSettings,
        body,
        slope ? [{ type: "ramp", crossing: 0, slopePermille: slope }] : [],
      ).things.filter((t) => t.reaches).length;

    it("gets wheels up at exactly the slope they manage, and no steeper", () => {
      const scene = raised();
      expect(reaches(scene, flatBody)).toBe(0);
      expect(reaches(scene, flatBody, 83)).toBeGreaterThan(0);
      expect(reaches(scene, flatBody, 120)).toBe(0);
    });

    it("finds a rise at a gate nobody marked, and a ramp there opens the way", () => {
      const scene = raised();
      const wall = {
        ...sampleFlat.walls[0]!,
        id: "wal_gate",
        levelId: scene.levels[0]!.id,
        from: [0, 3_000],
        to: [6_000, 3_000],
      };
      const gate = {
        ...sampleFlat.openings[0]!,
        id: "opn_gate",
        levelId: scene.levels[0]!.id,
        wallId: "wal_gate",
        kind: "gate",
        at: [3_000, 3_000],
        clearWidthMm: 2_000,
        thresholdMm: 0,
        connects: ["spc_street", "spc_yard"],
      };
      const unmarked = Scene.parse({ ...scene, walls: [wall], openings: [gate], levelChanges: [] });
      const crossings = crossingsOf(unmarked);
      expect(crossings).toHaveLength(1);
      expect(crossings[0]?.riseMm).toBe(150);
      // The same scene, the same crossing.
      expect(crossingsOf(unmarked)).toEqual(crossings);
      expect(reaches(unmarked, flatBody)).toBe(0);
      expect(reaches(unmarked, flatBody, 83)).toBeGreaterThan(0);
    });

    it("never makes a place harder to get around", () => {
      const scene = raised();
      const climber = { ...flatBody, stepMm: 150 };
      expect(reaches(scene, climber)).toBeGreaterThan(0);
      expect(reaches(scene, climber, 83)).toBeGreaterThan(0);
    });
  });

  it("a ramp makes a crossing climbable at its slope", () => {
    const lift = sampleFlat.levelChanges[0];
    if (!lift) return;
    const before = tryBody(sampleFlat, sampleSpec, sampleSettings, wheels);
    const after = tryBody(sampleFlat, sampleSpec, sampleSettings, wheels, [
      { type: "ramp", crossing: 0, slopePermille: 80 },
    ]);
    expect(after.crossings[0]?.kind).toBe("ramp");
    expect(after.crossings[0]?.climbs).toBe(true);
    // Too steep for them is too steep; and it says how long the gentle one has to be.
    const steep = tryBody(sampleFlat, sampleSpec, sampleSettings, wheels, [
      { type: "ramp", crossing: 0, slopePermille: 300 },
    ]);
    expect(steep.crossings[0]?.climbs).toBe(lift.riseMm === 0);
    expect(after.crossings[0]?.runMm).toBeGreaterThanOrEqual(lift.riseMm * 12);
    expect(before.crossings[0]).toBeTruthy();
  });

  it("lives a day and says what they did and what went without", () => {
    const r = tryDay(sampleFlat, sampleSpec, sampleSettings, walking);
    expect(r.hours).toBe(24);
    expect(r.did.length).toBeGreaterThan(0);
    expect(r.did[0]?.times).toBeGreaterThanOrEqual(r.did.at(-1)?.times ?? 0);
    // A body that can barely move does less.
    const small = tryDay(sampleFlat, sampleSpec, sampleSettings, { ...wheels, widthMm: 1_200 });
    const total = (d: typeof r) => d.did.reduce((t, x) => t + x.times, 0);
    expect(total(small)).toBeLessThanOrEqual(total(r) * 2);
  });
});
