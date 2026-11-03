import { describe, expect, it } from "vitest";
import { sampleFlat, sampleSpec } from "../src/fixtures.ts";
import {
  applyEdits,
  EditOp,
  Json,
  LIMITS,
  Scene,
  specIssues,
  WORLD_BOUNDS,
  WorldSpec,
} from "../src/index.ts";

describe("Scene", () => {
  it("accepts the sample flat", () => {
    expect(Scene.safeParse(sampleFlat).success).toBe(true);
  });

  it("rejects dangling references", () => {
    const broken = {
      ...sampleFlat,
      objects: [{ ...sampleFlat.objects[0], spaceId: "spc_nowhere" }],
    };
    const result = Scene.safeParse(broken);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("unknown space");
  });

  it("rejects duplicate ids across collections", () => {
    const dup = { ...sampleFlat, objects: [...sampleFlat.objects, sampleFlat.objects[0]] };
    expect(Scene.safeParse(dup).success).toBe(false);
  });

  it("rejects non-integer and out-of-range millimetres", () => {
    const [first] = sampleFlat.objects;
    const fractional = {
      ...sampleFlat,
      objects: [{ ...first, transform: { position: [0.5, 0, 0], yawDeg: 0 } }],
    };
    const far = {
      ...sampleFlat,
      objects: [{ ...first, transform: { position: [LIMITS.coordMm + 1, 0, 0], yawDeg: 0 } }],
    };
    expect(Scene.safeParse(fractional).success).toBe(false);
    expect(Scene.safeParse(far).success).toBe(false);
  });

  it("bounds collection sizes", () => {
    const huge = {
      ...sampleFlat,
      levels: [
        {
          ...sampleFlat.levels[0],
          footprint: Array.from({ length: LIMITS.polygonVertices + 1 }, (_, i) => [i, i]),
        },
      ],
    };
    expect(Scene.safeParse(huge).success).toBe(false);
  });
});

describe("Json", () => {
  it("rejects oversized and non-finite payloads", () => {
    expect(Json.safeParse("x".repeat(LIMITS.text + 1)).success).toBe(false);
    expect(Json.safeParse(Number.NaN).success).toBe(false);
    expect(Json.safeParse({ a: [1, 2, { b: "ok" }] }).success).toBe(true);
  });
});

describe("EditOp", () => {
  it("discriminates by op and validates the payload", () => {
    expect(EditOp.safeParse({ op: "object.remove", id: "obj_bed" }).success).toBe(true);
    expect(EditOp.safeParse({ op: "object.remove", id: "spc_living" }).success).toBe(false);
    expect(EditOp.safeParse({ op: "object.put", value: sampleFlat.objects[0] }).success).toBe(true);
    expect(EditOp.safeParse({ op: "object.explode", id: "obj_bed" }).success).toBe(false);
  });
});

describe("WorldSpec", () => {
  it("accepts the sample world and covers every object in the sample flat", () => {
    expect(WorldSpec.safeParse(sampleSpec).success).toBe(true);
    const things = new Set(sampleSpec.things.map((t) => t.object));
    for (const o of sampleFlat.objects) expect(things.has(o.id), o.id).toBe(true);
  });

  it("reports every broken reference in words a model can act on", () => {
    const [first] = sampleSpec.kinds;
    const broken = {
      ...sampleSpec,
      kinds: [
        {
          ...first!,
          actions: [
            {
              ...first!.actions[0]!,
              needs: [{ need: "joy", perHour: 10 }],
              sets: [{ var: "lit", value: 1, forMin: 0 }],
              requires: [{ resource: "magic" }],
            },
          ],
        },
        ...sampleSpec.kinds.slice(1),
      ],
      things: [...sampleSpec.things, { object: "obj_bed", kind: "dragon", state: [] }],
    };
    const issues = specIssues(broken as never);
    expect(issues).toEqual(
      expect.arrayContaining([
        'kind "bed" action "sleep" changes unknown need "joy"',
        'kind "bed" action "sleep" sets unknown var "lit"',
        'kind "bed" action "sleep" needs unknown resource "magic"',
        "thing obj_bed is listed twice",
        'thing obj_bed has unknown kind "dragon"',
      ]),
    );
    expect(WorldSpec.safeParse(broken).success).toBe(false);
  });

  it("bounds everything a model could use to break the game", () => {
    const gen = sampleSpec.kinds.find((k) => k.key === "generator")!;
    const printer = {
      ...sampleSpec,
      kinds: sampleSpec.kinds.map((k) =>
        k === gen
          ? { ...k, actions: [{ ...k.actions[0]!, durationMin: 1, income: WORLD_BOUNDS.cost }] }
          : k,
      ),
    };
    expect(specIssues(printer)).toEqual([
      `kind "generator" action "start" earns more than ${WORLD_BOUNDS.incomePerHour} per hour`,
    ]);
    const tooFast = {
      ...sampleSpec,
      needs: [{ key: "hunger", label: "Hunger", decayPerHour: 99_999 }],
    };
    expect(WorldSpec.safeParse(tooFast).success).toBe(false);
  });

  it("keys are identifiers, never free text", () => {
    const evil = { ...sampleSpec, needs: [{ key: "x; drop table", label: "x", decayPerHour: 1 }] };
    expect(WorldSpec.safeParse(evil).success).toBe(false);
  });
});

describe("applyEdits", () => {
  const sofa = sampleFlat.objects.find((o) => o.id === "obj_sofa")!;

  it("moves, adds and removes by id, idempotently", () => {
    const moved = {
      ...sofa,
      transform: { ...sofa.transform, position: [1500, 0, 3000] as [number, number, number] },
    };
    const edits = [
      EditOp.parse({ op: "object.put", value: moved }),
      EditOp.parse({ op: "object.remove", id: "obj_fan" }),
    ];
    const once = applyEdits(sampleFlat, edits).scene;
    const twice = applyEdits(once, edits).scene;
    expect(once.objects.find((o) => o.id === "obj_sofa")?.transform.position).toEqual([
      1500, 0, 3000,
    ]);
    expect(once.objects.some((o) => o.id === "obj_fan")).toBe(false);
    expect(twice).toEqual(once);
  });

  it("rejects edits that break referential integrity", () => {
    const edits = [EditOp.parse({ op: "space.remove", id: "spc_living" })];
    expect(() => applyEdits(sampleFlat, edits)).toThrow();
  });
});
