/** World evals: what `staticFindings` and `evaluateWorld` report as wrong with a world. */
import type { ActionDef, WorldSpec } from "@aye/schema";
import { sampleFlat, sampleSettings, sampleSpec } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import { evaluateWorld, Sim, staticFindings } from "../src/index.ts";

const leaving = (spec: WorldSpec, pose: "stand" | "sit", count: number): WorldSpec => ({
  ...spec,
  kinds: spec.kinds.map((k, ki) => ({
    ...k,
    actions: k.actions.map((a, ai) =>
      ki * 10 + ai < count ? { ...a, pose, leaves: { withThing: false } } : a,
    ),
  })),
});

describe("staticFindings on leaving", () => {
  it("flags going away while sitting or lying here", () => {
    const f = staticFindings(leaving(sampleSpec, "sit", 1));
    expect(f.some((x) => x.severity === "error" && /sends the person away/.test(x.message))).toBe(
      true,
    );
  });

  it("flags a place where most things send people away", () => {
    const many = leaving(sampleSpec, "stand", 99);
    const away = many.kinds
      .flatMap((k) => k.actions)
      .filter((a) => a.leaves && !a.leaves.withThing).length;
    const f = staticFindings(many);
    expect(f.some((x) => /actions send people out/.test(x.message))).toBe(away > 3);
  });

  it("lets someone sit in what they leave with (driving off)", () => {
    const drive: WorldSpec = {
      ...sampleSpec,
      kinds: sampleSpec.kinds.map((k, ki) => ({
        ...k,
        actions: k.actions.map((a, ai) =>
          ki === 0 && ai === 0 ? { ...a, pose: "sit" as const, leaves: { withThing: true } } : a,
        ),
      })),
    };
    expect(staticFindings(drive).filter((x) => /sends the person away/.test(x.message))).toEqual(
      [],
    );
  });

  it("leaves an ordinary world alone", () => {
    expect(
      staticFindings(sampleSpec).filter((x) => /away|send people out/.test(x.message)),
    ).toEqual([]);
  });
});

describe("evaluateWorld on multi-step things", () => {
  const withLastStep = (needs: { need: string; perHour: number }[], cost: number): WorldSpec => ({
    ...sampleSpec,
    kinds: sampleSpec.kinds.map((k) =>
      k.key === "generator"
        ? {
            ...k,
            actions: [
              ...k.actions,
              {
                key: "tinker",
                label: "Tinker with the running engine",
                durationMin: 30,
                capacity: 1,
                cost,
                income: 0,
                requires: [{ var: "running", op: "eq", value: 1 }],
                needs,
                sets: [],
                leaves: null,
                pose: "stand",
              },
            ],
          }
        : k,
    ),
  });

  it("says when nobody ever gets to the last step of a thing", () => {
    const { findings } = evaluateWorld(sampleFlat, withLastStep([], 50_000_000), sampleSettings, {
      hours: 24,
    });
    expect(findings.some((f) => /nobody got as far as .*Tinker/.test(f.message))).toBe(true);
  });

  it("says nothing of the plain one-step things in the place", () => {
    const { findings } = evaluateWorld(sampleFlat, sampleSpec, sampleSettings, { hours: 24 });
    expect(findings.some((f) => /nobody got as far as/.test(f.message))).toBe(false);
  });

  it("play-tests a place nobody was written for, with a stand-in who's never part of it", () => {
    const empty = { ...sampleSpec, people: [] };
    const r = evaluateWorld(sampleFlat, empty, sampleSettings);
    expect(r.people.map((p) => p.key)).toContain("play_tester");
    expect(empty.people).toEqual([]);
    // It still finds what's wrong with the place.
    expect(Array.isArray(r.findings)).toBe(true);
  });

  it("says when one person is doing the same thing all day, to be fixed", () => {
    // Needs fall as fast as they can, and each go does next to nothing, so it's go after go.
    const frantic: WorldSpec = {
      ...sampleSpec,
      needs: sampleSpec.needs.map((n) => ({ ...n, decayPerHour: 2_000 })),
      kinds: sampleSpec.kinds.map((k) => ({
        ...k,
        actions: k.actions.map((a) => ({ ...a, durationMin: 1, requires: [], cost: 0 })),
      })),
    };
    const { findings } = evaluateWorld(sampleFlat, frantic, sampleSettings, { hours: 24 });
    const chore = findings.find((f) => f.message.includes("Nobody lives like that"));
    expect(chore?.severity).toBe("fix");
  });

  it("leaves an ordinary world alone", () => {
    const { findings } = evaluateWorld(sampleFlat, sampleSpec, sampleSettings, { hours: 24 });
    expect(findings.some((f) => f.message.includes("Nobody lives like that"))).toBe(false);
  });

  it("sends back pay far above what an ordinary hour pays, and leaves ordinary pay alone", () => {
    const paying = (income: number, durationMin: number) => ({
      ...sampleSpec,
      hourPay: 1_000,
      kinds: sampleSpec.kinds.map((k, i) =>
        i === 0 && sampleSpec.things.some((t) => t.kind === k.key)
          ? {
              ...k,
              actions: [
                {
                  ...(sampleSpec.kinds.flatMap((x) => x.actions)[0] as (typeof k.actions)[number]),
                  key: "work",
                  label: "Work",
                  requires: [],
                  sets: [],
                  income,
                  durationMin,
                },
              ],
            }
          : k,
      ),
    });
    const said = (spec: typeof sampleSpec) =>
      staticFindings(spec).filter((f) => f.message.includes("ordinary work pays"));
    expect(said(paying(2_000, 60))).toEqual([]);
    const over = said(paying(1_000, 5));
    expect(over[0]?.severity).toBe("fix");
    expect(over[0]?.message).toContain("12000 an hour");
  });
});

describe("things used up for good", () => {
  const withOneUse = (refill: boolean) => ({
    ...sampleSpec,
    kinds: sampleSpec.kinds.map((k, i) =>
      i !== 0
        ? k
        : {
            ...k,
            vars: [...k.vars, { key: "stock", label: "Stock", max: 1, initial: 1 }],
            actions: [
              {
                ...(k.actions[0] as ActionDef),
                key: "buy",
                requires: [{ var: "stock", op: "gte" as const, value: 1 }],
                sets: [{ var: "stock", value: 0, forMin: 0 }],
              },
              ...(refill
                ? [
                    {
                      ...(k.actions[0] as ActionDef),
                      key: "refill",
                      requires: [],
                      sets: [{ var: "stock", value: 1, forMin: 0 }],
                    },
                  ]
                : []),
            ],
          },
    ),
  });
  const spentFindings = (spec: WorldSpec) =>
    staticFindings(spec).filter((f) => f.message.includes("brings these back"));

  it("sends back what stops working forever once used", () => {
    expect(spentFindings(withOneUse(false))[0]?.severity).toBe("fix");
  });

  it("is happy when something refills it", () => {
    expect(spentFindings(withOneUse(true))).toEqual([]);
  });
});

describe("marks that mean nothing", () => {
  const raising = (durationMin: number, cost: number) => ({
    ...sampleSpec,
    kinds: sampleSpec.kinds.map((k, i) =>
      i !== 0
        ? k
        : {
            ...k,
            actions: [
              {
                ...(k.actions[0] as ActionDef),
                durationMin,
                cost,
                marks: [{ mark: "hustle", by: 1 }],
              },
            ],
          },
    ),
  });
  const cheap = (spec: WorldSpec) =>
    staticFindings(spec).filter((f) => f.message.includes("for almost nothing"));

  it("sends back a quick free chore that raises one", () => {
    expect(cheap(raising(5, 0))[0]?.severity).toBe("fix");
  });

  it("doesn't count a token price as real money", () => {
    const spec = raising(5, 1);
    expect(cheap({ ...spec, hourPay: 1_000 })[0]?.severity).toBe("fix");
    expect(cheap({ ...spec, hourPay: 2 })).toEqual([]);
  });

  it("is happy with real work or real money", () => {
    expect(cheap(raising(60, 0))).toEqual([]);
    expect(cheap(raising(5, 50_000))).toEqual([]);
  });
});

describe("what's bought", () => {
  const eats = (cost: number, perHour: number): WorldSpec => ({
    ...sampleSpec,
    kinds: sampleSpec.kinds.map((k, i) =>
      i === 0
        ? {
            ...k,
            actions: [
              {
                ...(k.actions[0] as ActionDef),
                cost,
                income: 0,
                durationMin: 60,
                leaves: null,
                needs: [{ need: sampleSpec.needs[0]?.key ?? "", perHour }],
              },
            ],
          }
        : k,
    ),
  });
  const poor = (spec: WorldSpec) =>
    staticFindings(spec).filter((f) => f.message.includes("cost a lot and do little"));

  it("sends back what costs a lot and does little", () => {
    expect(poor(eats(sampleSpec.hourPay * 2, 80))[0]?.severity).toBe("fix");
  });

  it("leaves fair prices alone", () => {
    expect(poor(eats(sampleSpec.hourPay * 2, 600))).toEqual([]);
    expect(poor(eats(sampleSpec.hourPay / 2, 10))).toEqual([]);
  });
});

describe("a supply that needs itself", () => {
  const looping: WorldSpec = {
    ...sampleSpec,
    resources: [{ key: "power", label: "Power", supply: null }],
    kinds: sampleSpec.kinds.map((k, i) =>
      i === 0 ? { ...k, supplies: [{ resource: "power", when: [{ resource: "power" }] }] } : k,
    ),
  };

  it("is off, not an endless loop that takes the server down", () => {
    const sim = new Sim({ scene: sampleFlat, spec: looping, settings: sampleSettings });
    const power = looping.resources.findIndex((r) => r.key === "power");
    expect(sim.resourceOn(power)).toBe(false);
    expect(() => sim.step([])).not.toThrow();
  });

  it("goes back to whoever wrote it", () => {
    expect(staticFindings(looping).some((f) => f.message.includes("can't need itself"))).toBe(true);
  });
});

describe("what an action does to people", () => {
  const first = sampleSpec.kinds[0]?.key;
  const hunger = sampleSpec.needs.find((n) => n.key === "hunger");
  const only = (a: Partial<ActionDef>): WorldSpec => ({
    ...sampleSpec,
    kinds: sampleSpec.kinds.map((k) =>
      k.key === first
        ? {
            ...k,
            actions: [
              {
                ...(k.actions[0] as ActionDef),
                income: 0,
                cost: 0,
                durationMin: 60,
                leaves: null,
                sets: [],
                requires: [],
                ...a,
              },
            ],
          }
        : k,
    ),
  });
  const says = (spec: WorldSpec, what: RegExp) =>
    staticFindings(spec).filter((f) => what.test(f.message));

  it("sends back a meal that makes you hungrier", () => {
    const bad = only({ cost: 1_000, needs: [{ need: "hunger", perHour: -800 }] });
    expect(says(bad, /only makes people worse off/)[0]?.severity).toBe("fix");
  });

  it("leaves what hurts for a reason alone", () => {
    const shift = only({ income: 5_000, needs: [{ need: "hunger", perHour: -800 }] });
    expect(says(shift, /only makes people worse off/)).toEqual([]);
  });

  it("sends back what fills a need slower than it runs down", () => {
    const decay = hunger?.decayPerHour ?? 0;
    const slow = only({ needs: [{ need: "hunger", perHour: Math.max(1, decay) }] });
    expect(says(slow, /runs down about as fast/)[0]?.severity).toBe("fix");
    const fair = only({ needs: [{ need: "hunger", perHour: decay * 3 + 1 }] });
    expect(says(fair, /runs down about as fast/)).toEqual([]);
  });

  it("sends back work that pays and costs nothing", () => {
    const pay = sampleSpec.hourPay;
    const easy = only({ income: pay, needs: [{ need: "hunger", perHour: 10 }] });
    expect(says(easy, /pay people but cost them nothing/)[0]?.severity).toBe("fix");
    const hard = only({ income: pay, needs: [{ need: "hunger", perHour: -80 }] });
    expect(says(hard, /pay people but cost them nothing/)).toEqual([]);
  });
});

describe("somewhere to sleep", () => {
  const nowhere: WorldSpec = {
    ...sampleSpec,
    livedIn: false,
    kinds: sampleSpec.kinds.map((k) => ({
      ...k,
      actions: k.actions.map((a) => (a.pose === "lie" ? { ...a, pose: "sit" as const } : a)),
    })),
  };
  const says = (spec: WorldSpec, home: boolean) =>
    evaluateWorld(sampleFlat, spec, sampleSettings, { hours: 1, home }).findings.filter((f) =>
      /nowhere here to lie down/.test(f.message),
    );

  it("sends back a home with nowhere to lie down, whatever its author called it", () => {
    expect(says(nowhere, true)[0]?.severity).toBe("fix");
  });

  it("doesn't ask it of somewhere people only visit", () => {
    expect(says(nowhere, false)).toEqual([]);
  });

  it("is happy with a bed that really rests you", () => {
    expect(says(sampleSpec, true)).toEqual([]);
  });

  it("isn't fooled by a bed that takes you away or barely rests you", () => {
    const poor = (change: Partial<ActionDef>): WorldSpec => ({
      ...sampleSpec,
      kinds: sampleSpec.kinds.map((k) => ({
        ...k,
        actions: k.actions.map((a) => (a.pose === "lie" ? { ...a, ...change } : a)),
      })),
    });
    expect(says(poor({ leaves: { withThing: false } }), true)).toHaveLength(1);
    expect(says(poor({ needs: [{ need: "energy", perHour: 10 }] }), true)).toHaveLength(1);
    expect(says(poor({ cost: 100 }), true)).toHaveLength(1);
  });
});

describe("paying to lose what you've built", () => {
  it("sends it back", () => {
    const first = sampleSpec.kinds[0]?.key;
    const spec: WorldSpec = {
      ...sampleSpec,
      marks: [{ key: "trading", label: "Trading", max: 5, shown: true }],
      kinds: sampleSpec.kinds.map((k) =>
        k.key === first
          ? {
              ...k,
              actions: [
                {
                  ...(k.actions[0] as ActionDef),
                  cost: 500,
                  marks: [{ mark: "trading", by: -1 }],
                },
              ],
            }
          : k,
      ),
    };
    expect(
      staticFindings(spec).find((f) => /pay for these and lose/.test(f.message))?.severity,
    ).toBe("fix");
  });
});
