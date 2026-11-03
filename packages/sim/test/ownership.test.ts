import type { ObjectId, WorldSpec } from "@aye/schema";
import { sampleFlat, sampleSettings, sampleSpec } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import { Sim, type SimEvent } from "../src/index.ts";

const GEN = "obj_gen" as ObjectId;

// The generator becomes something people go out with (stand-in for a car), Tolu's own.
const owned = (owner: string | undefined): WorldSpec => ({
  ...sampleSpec,
  kinds: sampleSpec.kinds.map((k) =>
    k.key === "generator"
      ? {
          ...k,
          actions: [
            ...k.actions,
            {
              key: "ride",
              label: "Ride it out",
              durationMin: 30,
              capacity: 1,
              cost: 0,
              income: 0,
              requires: [],
              needs: [],
              sets: [],
              leaves: { withThing: true },
              pose: "sit",
            },
          ],
          travel: { speedKmh: 30 },
        }
      : k,
  ),
  things: sampleSpec.things.map((t) => (t.object === GEN && owner ? { ...t, owner } : t)),
});

const rejected = (events: SimEvent[], agent: string) =>
  events
    .filter((e) => e.type === "command_rejected" && e.agent === agent)
    .map((e) => (e.type === "command_rejected" ? e.reason : ""));

function settle(sim: Sim) {
  sim.step([]);
  for (const k of ["tolu", "mama"]) sim.step([{ type: "control", agent: k, on: true }]);
}

describe("ownership", () => {
  it("lets only its owner take a thing away; anyone may use it here", () => {
    const sim = new Sim({ scene: sampleFlat, spec: owned("tolu"), settings: sampleSettings });
    settle(sim);
    const mama = sim.step([{ type: "use", agent: "mama", object: GEN, action: "ride" }]);
    expect(rejected(mama, "mama")).toEqual(["not_yours"]);
    const tolu = sim.step([{ type: "use", agent: "tolu", object: GEN, action: "ride" }]);
    expect(rejected(tolu, "tolu")).toEqual([]);
  });

  it("in someone's own home, what nobody else owns is theirs", () => {
    const sim = new Sim({
      scene: sampleFlat,
      spec: owned(undefined),
      settings: sampleSettings,
      keeper: "mama",
    });
    settle(sim);
    const tolu = sim.step([{ type: "use", agent: "tolu", object: GEN, action: "ride" }]);
    expect(rejected(tolu, "tolu")).toEqual(["not_yours"]);
  });

  it("an owner leaves with their thing, and it comes back with them", () => {
    const sim = new Sim({ scene: sampleFlat, spec: owned("tolu"), settings: sampleSettings });
    settle(sim);
    const t = sim.things.findIndex((x) => x.id === GEN);
    const person = sim.people[sim.slotOf("tolu")];
    expect(person).toBeDefined();
    sim.step([{ type: "depart", agent: "tolu", taking: GEN }]);
    expect(sim.thingAway[t]).toBeGreaterThan(sim.tick);
    // Nobody else can use it while it's out.
    const mama = sim.step([{ type: "use", agent: "mama", object: GEN, action: "start" }]);
    expect(rejected(mama, "mama")).toEqual(["not_now"]);
    sim.step([{ type: "arrive", person: person!, controlled: true }]);
    expect(sim.thingAway[t]).toBe(0);
  });

  it("refuses to let someone leave with what isn't theirs (they still leave)", () => {
    const sim = new Sim({ scene: sampleFlat, spec: owned("tolu"), settings: sampleSettings });
    settle(sim);
    const t = sim.things.findIndex((x) => x.id === GEN);
    const events = sim.step([{ type: "depart", agent: "mama", taking: GEN }]);
    expect(rejected(events, "mama")).toEqual(["not_yours"]);
    expect(sim.thingAway[t]).toBe(0);
    expect(sim.slotOf("mama")).toBe(-1);
  });

  it("is deterministic", () => {
    const run = () => {
      const sim = new Sim({ scene: sampleFlat, spec: owned("tolu"), settings: sampleSettings });
      settle(sim);
      const person = sim.people[sim.slotOf("tolu")]!;
      sim.step([{ type: "depart", agent: "tolu", taking: GEN }]);
      for (let i = 0; i < 600; i++) sim.step([]);
      sim.step([{ type: "arrive", person, controlled: false }]);
      for (let i = 0; i < 600; i++) sim.step([]);
      return sim.hash();
    };
    expect(run()).toBe(run());
  });
});
