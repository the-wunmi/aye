/** Someone nobody is playing: how they spend, carrying on through a change, and practice news. */
import type { ActionDef, KindDef, ObjectId, PersonDef, WorldSpec } from "@aye/schema";
import { sampleFlat, sampleSettings, sampleSpec } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import { Mode, Sim, type SimEvent } from "../src/index.ts";

const pay = sampleSpec.hourPay;
const key = sampleSpec.people[0]?.key as string;
const fillsAt = (need: string, perHour: number) => [{ need, perHour }];

/** A shop whose every kind sells the same three things, so anyone can reach all of them. */
const shop: WorldSpec = {
  ...sampleSpec,
  kinds: sampleSpec.kinds.map((k: KindDef) => {
    const a = k.actions[0] as ActionDef;
    const base = { ...a, requires: [], sets: [], leaves: null, income: 0, marks: [], outcomes: [] };
    return {
      ...k,
      actions: [
        { ...base, key: "meal", label: "Meal", cost: pay / 10, needs: fillsAt("hunger", 900) },
        { ...base, key: "cheap", label: "Cheap", cost: pay, needs: fillsAt("fun", 900) },
        { ...base, key: "dear", label: "Dear", cost: pay * 5, needs: fillsAt("fun", 2_000) },
      ],
    };
  }),
};

const person = (money: number, levels: Record<string, number>): PersonDef => ({
  ...(sampleSpec.people[0] as PersonDef),
  money,
  needs: sampleSpec.needs.map((n) => ({ need: n.key, start: levels[n.key] ?? 900 })),
});

function bought(money: number, levels: Record<string, number>, ticks = 200): string[] {
  const sim = new Sim({
    scene: sampleFlat,
    spec: shop,
    settings: sampleSettings,
    people: [person(money, levels)],
  });
  const out: string[] = [];
  for (let t = 0; t < ticks; t++) {
    for (const e of sim.step()) {
      if (e.type === "action_started" && e.agent === key) out.push(e.action);
    }
  }
  return out;
}

describe("someone left to themselves, with their money", () => {
  it("sees to the need that's lowest first, whatever else is low", () => {
    const first = bought(pay * 100, { hunger: 0, fun: 100 })[0];
    expect(first).toBe("meal");
  });

  it("won't spend a third or more of what they have on one buy", () => {
    const got = bought(pay * 12, { hunger: 900, fun: 100 });
    expect(got).not.toContain("dear");
  });

  it("won't pay over an hour's pay until the need is nearly gone", () => {
    const got = bought(pay * 100, { hunger: 900, fun: 400 });
    expect(got).not.toContain("dear");
  });

  it("will still buy something dear for a need nearly gone, with plenty left", () => {
    const sim = new Sim({
      scene: sampleFlat,
      spec: {
        ...shop,
        kinds: shop.kinds.map((k) => ({
          ...k,
          actions: k.actions.filter((a) => a.key === "dear"),
        })),
      },
      settings: sampleSettings,
      people: [person(pay * 100, { fun: 50 })],
    });
    const seen: SimEvent[] = [];
    for (let t = 0; t < 200; t++) seen.push(...sim.step());
    expect(seen.some((e) => e.type === "action_started" && e.action === "dear")).toBe(true);
  });
});

describe("a change to the place while someone's busy", () => {
  it("carries on with what they were doing, and it still finishes and pays", () => {
    const worked: WorldSpec = {
      ...sampleSpec,
      kinds: sampleSpec.kinds.map((k) => ({
        ...k,
        actions: k.actions.map((a) =>
          a.key === "sleep" ? { ...a, income: 7_000, sets: [], durationMin: 60 } : a,
        ),
      })),
    };
    const init = { scene: sampleFlat, spec: worked, settings: sampleSettings };
    const sim = new Sim(init);
    const i = sim.slotOf(key);
    sim.step([{ type: "control", agent: key, on: true }]);
    sim.step([{ type: "use", agent: key, object: "obj_bed" as ObjectId, action: "sleep" }]);
    let t = 0;
    while (sim.mode[i] !== Mode.Acting && t++ < 2_000) sim.step();
    expect(sim.mode[i]).toBe(Mode.Acting);
    const money = sim.wallet[i] as number;
    const end = sim.actionEnd[i] as number;

    const next = Sim.rebuild(sim, init);
    expect(next.mode[i]).toBe(Mode.Acting);
    expect(next.actionEnd[i]).toBe(end);
    const finished: SimEvent[] = [];
    while (next.tick <= end + 1) finished.push(...next.step());
    expect(finished.some((e) => e.type === "action_finished" && e.agent === key)).toBe(true);
    expect(next.wallet[i]).toBe(money + 7_000);
  });

  it("drops it if the thing no longer does that", () => {
    const init = { scene: sampleFlat, spec: sampleSpec, settings: sampleSettings };
    const sim = new Sim(init);
    const i = sim.slotOf(key);
    sim.step([{ type: "control", agent: key, on: true }]);
    sim.step([{ type: "use", agent: key, object: "obj_bed" as ObjectId, action: "sleep" }]);
    let t = 0;
    while (sim.mode[i] !== Mode.Acting && t++ < 2_000) sim.step();
    const without: WorldSpec = {
      ...sampleSpec,
      kinds: sampleSpec.kinds.map((k) => ({
        ...k,
        actions: k.actions.filter((a) => a.key !== "sleep"),
      })),
    };
    const next = Sim.rebuild(sim, { ...init, spec: without });
    expect(next.mode[i]).not.toBe(Mode.Acting);
  });

  it("rebuilds the same on two machines", () => {
    const init = { scene: sampleFlat, spec: sampleSpec, settings: sampleSettings };
    const run = () => {
      const sim = new Sim(init);
      sim.step([{ type: "control", agent: key, on: true }]);
      sim.step([{ type: "use", agent: key, object: "obj_bed" as ObjectId, action: "sleep" }]);
      for (let t = 0; t < 400; t++) sim.step();
      const next = Sim.rebuild(sim, init);
      for (let t = 0; t < 400; t++) next.step();
      return next.hash();
    };
    expect(run()).toBe(run());
  });
});

describe("telling someone practice came to nothing", () => {
  it("only says so when nothing at all came of it", () => {
    const practice = (marks: { mark: string; by: number }[]): WorldSpec => ({
      ...sampleSpec,
      marks: [
        { key: "easy", label: "Easy", max: 1000, shown: true },
        { key: "hard", label: "Hard", max: 1000, shown: true },
      ],
      kinds: sampleSpec.kinds.map((k) => ({
        ...k,
        actions: k.actions.map((a) =>
          a.key === "sleep" ? { ...a, cost: 500, durationMin: 1, needs: [], sets: [], marks } : a,
        ),
      })),
    });
    const run = (spec: WorldSpec) => {
      const sim = new Sim({ scene: sampleFlat, spec, settings: sampleSettings });
      sim.step([{ type: "control", agent: key, on: true }]);
      sim.step([{ type: "use", agent: key, object: "obj_bed" as ObjectId, action: "sleep" }]);
      for (let t = 0; t < 3_000; t++) {
        for (const e of sim.step()) {
          if (e.type === "action_finished" && e.agent === key) return e;
        }
      }
      return null;
    };
    // Paid for, it always takes: nothing to apologise for.
    const paid = run(practice([{ mark: "easy", by: 1 }]));
    expect(paid).not.toBeNull();
    expect(paid?.practiceMissed).toBeUndefined();
  });
});
