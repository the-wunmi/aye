/** The place sim on the sample flat: RNG, nav grid, bodies, actions, stateful things, rebuilds. */
import {
  applyEdits,
  EditOp,
  heldActionTicks,
  type KindDef,
  type ObjectId,
  WorldSpec,
} from "@aye/schema";
import { sampleFlat, sampleSettings, sampleSpec } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import {
  buildNavGrid,
  cellAt,
  entryCells,
  evaluateWorld,
  Flag,
  Rng,
  Sim,
  type SimEvent,
  solidity,
  staticFindings,
  TICKS_PER_HOUR,
} from "../src/index.ts";

const init = { scene: sampleFlat, spec: sampleSpec, settings: sampleSettings };
const run = (sim: Sim, hours: number) => {
  const events: SimEvent[] = [];
  for (let t = 0; t < hours * TICKS_PER_HOUR; t++) events.push(...sim.step());
  return events;
};

describe("Rng", () => {
  it("is reproducible per seed and stream", () => {
    const a = Rng.seeded(42);
    const b = Rng.seeded(42);
    const c = Rng.seeded(42, 1);
    const seqA = Array.from({ length: 5 }, () => a.nextU32());
    expect(Array.from({ length: 5 }, () => b.nextU32())).toEqual(seqA);
    expect(Array.from({ length: 5 }, () => c.nextU32())).not.toEqual(seqA);
  });

  it("int() stays in range", () => {
    const r = Rng.seeded(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.int(10);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(10);
    }
  });
});

describe("NavGrid", () => {
  const grid = buildNavGrid(sampleFlat, sampleFlat.levels[0]!.id, {
    cellMm: 100,
    isSolid: solidity(sampleSpec),
  });

  it("blocks walls and solid things but opens doors", () => {
    expect(grid.flags[cellAt(grid, 2500, 0)]! & Flag.Blocked).toBe(0); // front door
    expect(grid.flags[cellAt(grid, 1000, 20)]! & Flag.Blocked).toBeTruthy(); // front wall
    expect(grid.flags[cellAt(grid, 1100, 5250)]! & Flag.Object).toBeTruthy(); // bed
  });

  it("carries the yard step and the door threshold as floor heights", () => {
    expect(grid.floorMm[cellAt(grid, 2500, -1500)]).toBe(-180);
    expect(grid.floorMm[cellAt(grid, 2500, -50)]).toBe(25);
    expect(grid.floorMm[cellAt(grid, 2500, 1500)]).toBe(0);
  });
});

describe("bodies obey the world", () => {
  const sit = {
    type: "use",
    agent: "mama",
    object: "obj_sofa" as ObjectId,
    action: "sit",
  } as const;

  it("a wheelchair can't climb the 180 mm front step", () => {
    const events = new Sim(init).step([sit]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "command_rejected", reason: "unreachable" }),
    );
  });

  it("a ramp and a level threshold let her into the living room", () => {
    const ramped = {
      ...sampleFlat,
      openings: sampleFlat.openings.map((o) =>
        o.id === "opn_front" ? { ...o, thresholdMm: 0 } : o,
      ),
      levelChanges: [
        {
          ...sampleFlat.levelChanges[0]!,
          kind: "ramp" as const,
          from: [2500, -2400] as [number, number],
        },
      ],
    };
    const events = new Sim({ ...init, scene: ramped }).step([sit]);
    expect(events.filter((e) => e.type === "command_rejected")).toEqual([]);
  });
});

describe("Sim", () => {
  it("is deterministic: same inputs give the same state hash, whatever the people order", () => {
    const a = new Sim(init);
    const b = new Sim({ ...init, people: [...sampleSpec.people].reverse() });
    run(a, 6);
    run(b, 6);
    expect(a.hash()).toBe(b.hash());
  });

  it("diverges with a different seed", () => {
    const a = new Sim(init);
    const b = new Sim({ ...init, settings: { ...sampleSettings, seed: 2 } });
    run(a, 12);
    run(b, 12);
    expect(a.hash()).not.toBe(b.hash());
  });

  it("people act on their needs over a day, by the spec's actions", () => {
    const events = run(new Sim(init), 24);
    const done = new Set(events.flatMap((e) => (e.type === "action_finished" ? [e.action] : [])));
    expect(done.has("sleep")).toBe(true);
    expect(done.has("use")).toBe(true);
  });

  it("lets one of the world's people be asked to do something, by the same rules", () => {
    const find = (sim: Sim) => {
      for (const person of sampleSpec.people) {
        const slot = sim.slotOf(person.key);
        for (const kind of sampleSpec.kinds) {
          for (const action of kind.actions) {
            const object = sim.thingFor(slot, kind.key, action.key);
            if (object) return { agent: person.key, object, action: action.key, slot, kind };
          }
        }
      }
      return null;
    };
    const a = new Sim(init);
    const before = a.hash();
    const asked = find(a);
    if (!asked) throw new Error("nothing to do in the sample");
    // Looking changes nothing.
    expect(a.hash()).toBe(before);
    expect(a.canDoNow(asked.slot, asked.kind.key, asked.action)).toBe(true);
    expect(a.thingFor(asked.slot, "no_such_kind", asked.action)).toBeNull();
    const use = {
      type: "use" as const,
      agent: asked.agent,
      object: asked.object,
      action: asked.action,
    };
    const rejected = a.step([use]).filter((e) => e.type === "command_rejected");
    expect(rejected).toEqual([]);
    // Same request, same world.
    const b = new Sim(init);
    b.step([use]);
    expect(b.hash()).toBe(a.hash());
  });

  it("rejects intents that break the rules instead of trusting the client", () => {
    const sim = new Sim(init);
    const events = sim.step([
      { type: "use", agent: "nobody", object: "obj_bed" as ObjectId, action: "sleep" },
      { type: "use", agent: "tolu", object: "obj_nothing" as ObjectId, action: "sleep" },
      { type: "use", agent: "tolu", object: "obj_bed" as ObjectId, action: "fly" },
    ]);
    expect(events.map((e) => (e.type === "command_rejected" ? e.reason : e.type))).toEqual([
      "unknown_agent",
      "unknown_object",
      "not_offered",
    ]);
  });

  it("a thing supplies a resource while its state says so, and stops when its time runs out", () => {
    const sim = new Sim(init);
    const power = sim.resourceKeys.indexOf("power");
    sim.supplyOn[power] = 0;
    sim.nextToggle[power] = -1;
    expect(sim.resourceOn(power)).toBe(false);
    sim.step([{ type: "use", agent: "tolu", object: "obj_gen" as ObjectId, action: "start" }]);
    for (let t = 0; t < TICKS_PER_HOUR; t++) sim.step();
    expect(sim.thingVar("obj_gen", "running")).toBe(1);
    expect(sim.resourceOn(power)).toBe(true);
    for (let t = 0; t < 4 * TICKS_PER_HOUR; t++) sim.step();
    expect(sim.thingVar("obj_gen", "running")).toBe(0);
  });
});

describe("no money printers", () => {
  it("an action that pays runs its full duration, even when the worker's needs are already met", () => {
    // A stall shift that pays and also gives a little comfort, worked by someone who is
    // perfectly comfortable: it must still take its full hour, not pay out every tick.
    const spec = WorldSpec.parse({
      ...sampleSpec,
      kinds: sampleSpec.kinds.map((k) =>
        k.key === "shelf"
          ? {
              ...k,
              actions: [
                {
                  key: "work",
                  label: "Work a shift",
                  durationMin: 60,
                  capacity: 1,
                  cost: 0,
                  income: 100_000,
                  requires: [],
                  needs: [{ need: "comfort", perHour: 10 }],
                  sets: [],
                  leaves: null,
                  pose: "stand",
                },
              ],
            }
          : k,
      ),
      people: sampleSpec.people.map((p) => ({
        ...p,
        needs: sampleSpec.needs.map((n) => ({ need: n.key, start: 1000 })),
      })),
    });
    const sim = new Sim({ scene: sampleFlat, spec, settings: sampleSettings });
    const events = sim.step([
      { type: "use", agent: "tolu", object: "obj_shelf" as ObjectId, action: "work" },
    ]);
    expect(events.filter((e) => e.type === "command_rejected")).toEqual([]);
    const all = run(sim, 2);
    const shifts = all.filter((e) => e.type === "action_finished" && e.action === "work");
    expect(shifts.length).toBeLessThanOrEqual(2);
  });
});

describe("long actions for someone being played", () => {
  it("a long paid shift takes a minute to watch, and pays and tires the same", () => {
    const shift = { durationMin: 180, leaves: null };
    const settings = { ticksPerRealSecond: 30, actionMaxRealSec: 60 };
    expect(heldActionTicks(shift, settings)).toBe(60 * 30);
    expect(heldActionTicks({ durationMin: 180, leaves: { withThing: false } }, settings)).toBe(
      180 * 60,
    );
    // Paid to be out is a shift: watching it shouldn't take minutes longer than any other.
    expect(
      heldActionTicks({ durationMin: 180, income: 1, leaves: { withThing: false } }, settings),
    ).toBe(60 * 30);
  });
});

describe("things with state: the covered car", () => {
  // A car the spec says is under a cover, with a door, that can be driven. Nothing in code
  // knows what a car is; the chain cover → door → drive comes from the spec alone.
  const action = (over: Partial<KindDef["actions"][number]>): KindDef["actions"][number] => ({
    key: "x",
    label: "x",
    durationMin: 5,
    capacity: 1,
    cost: 0,
    income: 0,
    requires: [],
    needs: [],
    sets: [],
    leaves: null,
    pose: "stand",
    ...over,
  });
  const car: KindDef = {
    key: "car",
    label: "Car",
    solid: true,
    vars: [
      { key: "covered", label: "Covered", max: 1, initial: 1 },
      { key: "door_open", label: "Door open", max: 1, initial: 0 },
    ],
    actions: [
      action({
        key: "uncover",
        label: "Take the cover off",
        requires: [{ var: "covered", op: "eq", value: 1 }],
        sets: [{ var: "covered", value: 0, forMin: 0 }],
      }),
      action({
        key: "open_door",
        label: "Open the door",
        durationMin: 1,
        requires: [
          { var: "covered", op: "eq", value: 0 },
          { var: "door_open", op: "eq", value: 0 },
        ],
        sets: [{ var: "door_open", value: 1, forMin: 0 }],
      }),
      action({
        key: "drive",
        label: "Go for a drive",
        durationMin: 60,
        requires: [{ var: "door_open", op: "eq", value: 1 }],
        needs: [{ need: "fun", perHour: 900 }],
        sets: [{ var: "door_open", value: 0, forMin: 0 }],
        leaves: { withThing: true },
        pose: "inside",
      }),
    ],
    supplies: [],
    look: [
      {
        shape: "box",
        centre: [0, 300, 0],
        size: [1000, 600, 1000],
        rotateDeg: [0, 0, 0],
        colour: "#1f5fa8",
        glow: false,
        when: [],
      },
      {
        shape: "box",
        centre: [0, 520, 0],
        size: [1050, 1100, 1050],
        rotateDeg: [0, 0, 0],
        colour: "#555555",
        glow: false,
        when: [{ var: "covered", op: "eq", value: 1 }],
      },
    ],
    note: "",
  };
  const scene = {
    ...sampleFlat,
    objects: [
      ...sampleFlat.objects,
      {
        id: "obj_car" as ObjectId,
        label: "Car under a cover",
        levelId: sampleFlat.levels[0]!.id,
        spaceId: sampleFlat.spaces[0]!.id,
        // A small car parked across the yard, clear of the front step and the generator.
        transform: { position: [4800, 0, -1100] as [number, number, number], yawDeg: 90 },
        size: { w: 1600, d: 3400, h: 1450 },
        evidence: null,
      },
    ],
  };
  // Only the car is fun here, and Tolu is bored (and otherwise fine).
  const spec = WorldSpec.parse({
    ...sampleSpec,
    kinds: [
      ...sampleSpec.kinds.map((k) => ({
        ...k,
        actions: k.actions.map((a) => ({
          ...a,
          needs: a.needs.filter((n) => n.need !== "fun"),
        })),
      })),
      car,
    ],
    things: [...sampleSpec.things, { object: "obj_car", kind: "car", state: [] }],
    people: sampleSpec.people.map((p) =>
      p.key === "tolu"
        ? {
            ...p,
            needs: sampleSpec.needs.map((n) => ({
              need: n.key,
              start: n.key === "fun" ? 50 : 980,
            })),
          }
        : p,
    ),
  });

  it("people plan through state: the cover comes off, the door opens, someone drives off and back", () => {
    const sim = new Sim({ scene, spec, settings: sampleSettings });
    const events = run(sim, 4);
    // The car's story, whoever does each step (the world is shared).
    const steps = events.flatMap((e) =>
      e.type === "action_finished" && e.object === "obj_car" ? [e.action] : [],
    );
    expect(steps.slice(0, 3)).toEqual(["uncover", "open_door", "drive"]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "left", agent: "tolu", object: "obj_car" }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: "returned", object: "obj_car" }));
    expect(sim.thingVar("obj_car", "covered")).toBe(0);
  });

  it("can't skip a step: driving with the cover on is refused", () => {
    const sim = new Sim({ scene, spec, settings: sampleSettings });
    const events = sim.step([
      { type: "use", agent: "tolu", object: "obj_car" as ObjectId, action: "drive" },
    ]);
    expect(events).toContainEqual(expect.objectContaining({ reason: "not_now" }));
  });

  it("spots actions that can never happen", () => {
    const stuck = WorldSpec.parse({
      ...spec,
      kinds: spec.kinds.map((k) =>
        k.key === "car" ? { ...k, actions: k.actions.filter((a) => a.key !== "open_door") } : k,
      ),
    });
    expect(staticFindings(stuck)).toContainEqual({
      severity: "error",
      message: '"Car: Go for a drive" waits for door_open eq 1, which nothing ever sets.',
    });
  });
});

describe("Sim.rebuild after an edit", () => {
  const sofa = sampleFlat.objects.find((o) => o.id === "obj_sofa")!;
  const moved = applyEdits(sampleFlat, [
    EditOp.parse({
      op: "object.put",
      value: { ...sofa, transform: { ...sofa.transform, position: [2000, 0, 2800] } },
    }),
  ]).scene;

  it("carries time, money, needs, thing state and randomness across", () => {
    const prev = new Sim(init);
    run(prev, 3);
    const next = Sim.rebuild(prev, { ...init, scene: moved });
    expect(next.tick).toBe(prev.tick);
    expect([...next.wallet]).toEqual([...prev.wallet]);
    expect(next.need(0, "hunger")).toBe(prev.need(0, "hunger"));
    expect([...next.thingVars]).toEqual([...prev.thingVars]);
  });

  it("is deterministic", () => {
    const a = new Sim(init);
    const b = new Sim(init);
    run(a, 2);
    run(b, 2);
    const ra = Sim.rebuild(a, { ...init, scene: moved });
    const rb = Sim.rebuild(b, { ...init, scene: moved });
    run(ra, 2);
    run(rb, 2);
    expect(ra.hash()).toBe(rb.hash());
  });
});

describe("open places", () => {
  it("people arrive through an exit that sits exactly on the edge of the mapped ground", () => {
    const level = sampleFlat.levels[0]!;
    const maxX = Math.max(...level.footprint.map((p) => p[0]));
    const scene = {
      ...sampleFlat,
      portals: [{ ...sampleFlat.portals[0]!, at: [maxX, 1500] as [number, number] }],
    };
    const grid = buildNavGrid(scene, level.id, { cellMm: 100 });
    expect(entryCells(scene, grid).length).toBe(1);
  });

  it("each body arrives where it can reach the most, never on a cut-off island", () => {
    // The first way in opens into the bathroom, whose 700 mm door a wheelchair can't pass.
    const scene = {
      ...sampleFlat,
      entry: null,
      portals: [
        {
          ...sampleFlat.portals[0]!,
          id: "prt_abath" as never,
          at: [5000, 6000] as [number, number],
        },
        { ...sampleFlat.portals[0]!, id: "prt_yard" as never },
      ],
    };
    const sim = new Sim({ ...init, scene });
    const events = sim.step([
      { type: "use", agent: "mama", object: "obj_gen" as ObjectId, action: "start" },
    ]);
    expect(events.filter((e) => e.type === "command_rejected")).toEqual([]);
  });
});

describe("evaluateWorld", () => {
  it("plays the sample world without errors", () => {
    const evaluation = evaluateWorld(sampleFlat, sampleSpec, sampleSettings, { hours: 24 });
    expect(evaluation.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(evaluation.actions["Bed: Sleep"]).toBeGreaterThan(0);
  });

  it("visited places aren't expected to meet every need", () => {
    const visited = WorldSpec.parse({ ...sampleSpec, livedIn: false });
    const findings = evaluateWorld(sampleFlat, visited, sampleSettings).findings;
    expect(findings.some((f) => f.message.startsWith("Nothing here satisfies"))).toBe(false);
  });
});
