/**
 * A place's hours are the city's, so the realm tells the sim when it closes. Once it has, nobody
 * earns or spends there, neither by asking nor when left to themselves, but nobody is trapped.
 */
import type { ActionDef, KindDef, ObjectId, PersonDef, WorldSpec } from "@aye/schema";
import { sampleFlat, sampleSettings, sampleSpec } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import { Sim, type SimEvent } from "../src/index.ts";

const pay = sampleSpec.hourPay;
const shop: WorldSpec = {
  ...sampleSpec,
  kinds: sampleSpec.kinds.map((k: KindDef) => {
    const a = k.actions[0] ?? sampleSpec.kinds.flatMap((x: KindDef) => x.actions)[0];
    const base = {
      ...(a as ActionDef),
      requires: [],
      sets: [],
      leaves: null,
      income: 0,
      cost: 0,
      needs: [],
      marks: [],
      outcomes: [],
    };
    return {
      ...k,
      actions: [
        { ...base, key: "shift", label: "Shift", income: pay },
        { ...base, key: "buy", label: "Buy", cost: Math.floor(pay / 10) },
        { ...base, key: "rest", label: "Rest" },
        {
          ...base,
          key: "ride",
          label: "Ride",
          cost: Math.floor(pay / 10),
          leaves: { withThing: false },
        },
      ],
    };
  }),
} as WorldSpec;

const person: PersonDef = { ...(sampleSpec.people[0] as PersonDef), money: pay * 10 };
const key = person.key;

function start(): { sim: Sim; thing: ObjectId } {
  const sim = new Sim({
    scene: sampleFlat,
    spec: shop,
    settings: sampleSettings,
    people: [person],
  });
  sim.step([{ type: "control", agent: key, on: true }]);
  return { sim, thing: shop.things[0]?.object as ObjectId };
}

const rejections = (events: SimEvent[]) =>
  events.flatMap((e) => (e.type === "command_rejected" ? [e.reason] : []));

function tryIt(sim: Sim, thing: ObjectId, action: string): string[] {
  return rejections(sim.step([{ type: "use", agent: key, object: thing, action }]));
}

describe("closing time", () => {
  it("stops paid work and buying, but not resting or leaving", () => {
    const { sim, thing } = start();
    sim.step([{ type: "shut", on: true }]);
    expect(tryIt(sim, thing, "shift")).toEqual(["closed"]);
    expect(tryIt(sim, thing, "buy")).toEqual(["closed"]);
    expect(tryIt(sim, thing, "rest")).toEqual([]);
    const fresh = start();
    fresh.sim.step([{ type: "shut", on: true }]);
    expect(tryIt(fresh.sim, fresh.thing, "ride")).toEqual([]);
  });

  it("opens again", () => {
    const { sim, thing } = start();
    sim.step([{ type: "shut", on: true }]);
    sim.step([{ type: "shut", on: false }]);
    expect(tryIt(sim, thing, "shift")).toEqual([]);
  });

  it("isn't worked around by people left to themselves", () => {
    const walletAfter = (shut: boolean) => {
      const { sim } = start();
      sim.step([
        { type: "shut", on: shut },
        { type: "control", agent: key, on: false },
      ]);
      for (let t = 0; t < 20_000; t++) sim.step([]);
      return sim.wallet[sim.slotOf(key)] as number;
    };
    expect(walletAfter(true)).toBe(person.money);
    expect(walletAfter(false)).not.toBe(person.money);
  });

  it("counts towards the hash, and the same commands give the same hash", () => {
    const a = start().sim;
    const b = start().sim;
    expect(a.hash()).toBe(b.hash());
    a.step([{ type: "shut", on: true }]);
    b.step([]);
    expect(a.hash()).not.toBe(b.hash());
    const c = start().sim;
    c.step([{ type: "shut", on: true }]);
    expect(a.hash()).toBe(c.hash());
  });

  it("survives a change to the place", () => {
    const { sim } = start();
    sim.step([{ type: "shut", on: true }]);
    const next = Sim.rebuild(sim, { scene: sampleFlat, spec: shop, settings: sampleSettings });
    expect(next.shut).toBe(1);
  });

  it("says what running on empty took off the pay", () => {
    const empty: PersonDef = {
      ...person,
      needs: shop.needs.map((n) => ({ need: n.key, start: 0 })),
    };
    const sim = new Sim({
      scene: sampleFlat,
      spec: {
        ...shop,
        needs: shop.needs.map((n) => ({
          ...n,
          whenEmpty: { payPermille: 400, walkPermille: 1000, feeling: "Spent" },
        })),
      },
      settings: sampleSettings,
      people: [empty],
    });
    sim.step([{ type: "control", agent: key, on: true }]);
    const thing = shop.things[0]?.object as ObjectId;
    sim.step([{ type: "use", agent: key, object: thing, action: "shift" }]);
    const done: SimEvent[] = [];
    for (let t = 0; t < 20_000 && done.length === 0; t++) {
      done.push(...sim.step([]).filter((e) => e.type === "action_finished"));
    }
    const event = done[0] as Extract<SimEvent, { type: "action_finished" }>;
    expect(event.docked).toBeGreaterThan(0);
    expect(event.earned + (event.docked as number)).toBe(pay);
  });
});

describe("how fast needs fill", () => {
  const level = (needFillPermille?: number) => {
    const low: PersonDef = {
      ...person,
      needs: shop.needs.map((n) => ({ need: n.key, start: 100 })),
    };
    const need = shop.needs[0]?.key as string;
    const eats: WorldSpec = {
      ...shop,
      kinds: shop.kinds.map((k: KindDef) => ({
        ...k,
        actions: k.actions.map((a: ActionDef) =>
          a.key === "rest"
            ? {
                ...a,
                needs: [
                  { need, perHour: 600 },
                  { need: shop.needs[1]?.key as string, perHour: -600 },
                ],
                durationMin: 10,
              }
            : a,
        ),
      })),
    } as WorldSpec;
    const sim = new Sim({
      scene: sampleFlat,
      spec: eats,
      settings: {
        ...sampleSettings,
        ...(needFillPermille ? { needFillPermille } : {}),
      },
      people: [low],
    });
    sim.step([{ type: "control", agent: key, on: true }]);
    sim.step([
      { type: "use", agent: key, object: eats.things[0]?.object as ObjectId, action: "rest" },
    ]);
    for (let t = 0; t < 2_000; t++) sim.step([]);
    return [sim.needs[0] as number, sim.needs[1] as number];
  };

  it("fills faster when the realm says so, without making anything tire you less", () => {
    const [plain, plainTired] = level() as [number, number];
    const [quick, quickTired] = level(3000) as [number, number];
    expect(quick).toBeGreaterThan(plain);
    expect(quickTired).toBe(plainTired);
  });

  it("is the same every time", () => {
    expect(level(3000)).toEqual(level(3000));
  });
});
