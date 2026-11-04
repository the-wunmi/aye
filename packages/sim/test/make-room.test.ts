/** The world's people give way to players, and two people at one thing don't share a spot. */
import type { ObjectId } from "@aye/schema";
import { sampleFlat, sampleSettings, sampleSpec } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import { Mode, Sim } from "../src/index.ts";

const cooker = "obj_cooker" as ObjectId;

describe("the world's people make room for players", () => {
  it("someone the world wrote steps away from a thing a player wants, and leaves it to them", () => {
    const sim = new Sim({ scene: sampleFlat, spec: sampleSpec, settings: sampleSettings });
    // Tolu is cooking (the cooker takes one person).
    sim.step([{ type: "use", agent: "tolu", object: cooker, action: "cook" }]);
    for (let k = 0; k < 600 && sim.mode[sim.slotOf("tolu")] !== Mode.Acting; k++) {
      sim.step([]);
    }
    expect(sim.mode[sim.slotOf("tolu")]).toBe(Mode.Acting);
    const base = sampleSpec.people[0]!;
    sim.step([
      { type: "arrive", person: { ...base, key: "kofi", name: "Kofi" }, controlled: true },
    ]);
    const events = sim.step([{ type: "use", agent: "kofi", object: cooker, action: "cook" }]);
    expect(events.some((e) => e.type === "command_rejected")).toBe(false);
    // Kofi walks over and cooks; Tolu doesn't take it back while he's on his way.
    let cooking = false;
    for (let k = 0; k < 900 && !cooking; k++) {
      sim.step([]);
      const k2 = sim.slotOf("kofi");
      cooking = sim.mode[k2] === Mode.Acting && sim.activity(k2).action?.key === "cook";
    }
    expect(cooking).toBe(true);
    const t = sim.slotOf("tolu");
    expect(sim.mode[t] === Mode.Acting && sim.activity(t).action?.key === "cook").toBe(false);
  });

  it("players don't push each other off things", () => {
    const sim = new Sim({ scene: sampleFlat, spec: sampleSpec, settings: sampleSettings });
    const base = sampleSpec.people[0]!;
    for (const key of ["ada", "kofi"]) {
      sim.step([{ type: "arrive", person: { ...base, key, name: key }, controlled: true }]);
    }
    sim.step([{ type: "use", agent: "ada", object: cooker, action: "cook" }]);
    for (let k = 0; k < 600 && sim.mode[sim.slotOf("ada")] !== Mode.Acting; k++) {
      sim.step([]);
    }
    const events = sim.step([{ type: "use", agent: "kofi", object: cooker, action: "cook" }]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "command_rejected", reason: "full" }),
    );
    expect(sim.mode[sim.slotOf("ada")]).toBe(Mode.Acting);
  });

  it("nobody walks up to stand inside someone already standing there", () => {
    const sim = new Sim({ scene: sampleFlat, spec: sampleSpec, settings: sampleSettings });
    const base = sampleSpec.people[0]!;
    sim.step([
      { type: "arrive", person: { ...base, key: "kofi", name: "Kofi" }, controlled: true },
    ]);
    const fridge = "obj_fridge" as ObjectId;
    // Kofi has a snack and stays standing at the fridge.
    sim.step([{ type: "use", agent: "kofi", object: fridge, action: "snack" }]);
    for (let k = 0; k < 3_000 && sim.mode[sim.slotOf("kofi")] !== Mode.Idle; k++) sim.step([]);
    for (let k = 0; k < 30; k++) sim.step([]);
    expect(sim.mode[sim.slotOf("kofi")]).toBe(Mode.Idle);
    // Then Tolu comes for a snack too.
    sim.step([{ type: "use", agent: "tolu", object: fridge, action: "snack" }]);
    for (let k = 0; k < 900 && sim.mode[sim.slotOf("tolu")] !== Mode.Acting; k++) sim.step([]);
    expect(sim.mode[sim.slotOf("tolu")]).toBe(Mode.Acting);
    const g = sim.grid;
    const [a, b] = ["kofi", "tolu"].map((k) => sim.cell[sim.slotOf(k)] as number) as [
      number,
      number,
    ];
    const d = Math.hypot(
      ((a % g.width) - (b % g.width)) * g.cellMm,
      (Math.floor(a / g.width) - Math.floor(b / g.width)) * g.cellMm,
    );
    expect(d).toBeGreaterThanOrEqual(500);
  });

  it("someone the world wrote who's out with a thing brings it back for a player", () => {
    const outing: typeof sampleSpec = {
      ...sampleSpec,
      kinds: sampleSpec.kinds.map((k) =>
        k.key === "cooker"
          ? {
              ...k,
              actions: k.actions.map((a) => ({
                ...a,
                requires: [],
                sets: [],
                cost: 0,
                durationMin: 600,
                leaves: { withThing: true },
              })),
            }
          : k,
      ),
    };
    const action = outing.kinds.find((k) => k.key === "cooker")?.actions[0]?.key as string;
    const sim = new Sim({ scene: sampleFlat, spec: outing, settings: sampleSettings });
    sim.step([{ type: "use", agent: "tolu", object: cooker, action }]);
    for (let t = 0; t < 3_000 && sim.mode[sim.slotOf("tolu")] !== Mode.Away; t++) sim.step([]);
    expect(sim.mode[sim.slotOf("tolu")]).toBe(Mode.Away);
    const base = sampleSpec.people[0];
    if (!base) throw new Error("the sample has people");
    sim.step([
      { type: "arrive", person: { ...base, key: "kofi", name: "Kofi" }, controlled: true },
    ]);
    const events = sim.step([{ type: "use", agent: "kofi", object: cooker, action }]);
    expect(events.filter((e) => e.type === "command_rejected")).toEqual([]);
    expect(sim.mode[sim.slotOf("tolu")]).not.toBe(Mode.Away);
  });
});
