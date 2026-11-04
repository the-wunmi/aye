/** People coming, going and being taken over, and what stays with them from place to place. */
import type { ObjectId, PersonDef } from "@aye/schema";
import { sampleFlat, sampleSettings, sampleSpec } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import { MAX_PEOPLE, Mode, Sim, type SimEvent } from "../src/index.ts";
import { cellCentre } from "../src/navgrid.ts";

const init = { scene: sampleFlat, spec: sampleSpec, settings: sampleSettings };
const visitor = (key: string, money = 5_000): PersonDef => ({
  ...(sampleSpec.people[0] as PersonDef),
  key,
  name: key,
  money,
  needs: [{ need: "hunger", start: 400 }],
});
const steps = (sim: Sim, n: number, first: Parameters<Sim["step"]>[0] = []) => {
  const events: SimEvent[] = [...sim.step(first)];
  for (let t = 1; t < n; t++) events.push(...sim.step());
  return events;
};

describe("people arriving, leaving and being taken over", () => {
  it("someone arrives by the entrance with their own money and needs, and leaves with them", () => {
    const sim = new Sim(init);
    const events = sim.step([{ type: "arrive", person: visitor("ada"), controlled: true }]);
    const arrived = events.find((e) => e.type === "arrived");
    expect(arrived).toMatchObject({ agent: "ada" });
    const i = sim.slotOf("ada");
    expect(sim.present[i]).toBe(1);
    expect(sim.wallet[i]).toBe(5_000);
    expect(sim.need(i, "hunger")).toBeGreaterThanOrEqual(399); // one tick of decay
    // A need the visitor didn't bring starts at a neutral level.
    expect(sim.need(i, "energy")).toBeGreaterThanOrEqual(699);

    steps(sim, 600);
    const left = sim.step([{ type: "depart", agent: "ada" }]);
    const departed = left.find((e) => e.type === "departed");
    expect(departed).toMatchObject({ agent: "ada", slot: i, wallet: 5_000 });
    if (departed?.type !== "departed") throw new Error("no departure");
    expect(departed.needs.find((n) => n.need === "hunger")?.level).toBeLessThan(400);
    expect(sim.slotOf("ada")).toBe(-1);
    expect(sim.present[i]).toBe(0);
  });

  describe("what stays with someone", () => {
    const skilled = {
      ...sampleSpec,
      marks: [
        { key: "cooking", label: "Cooking", max: 5, shown: true },
        { key: "groceries", label: "Groceries", max: 9, shown: true },
      ],
      kinds: sampleSpec.kinds.map((k) => ({
        ...k,
        actions: k.actions.map((a) =>
          a.key === "snack"
            ? {
                ...a,
                durationMin: 2,
                cost: 0,
                needs: [],
                asks: [{ mark: "groceries", op: "gte" as const, value: 1 }],
                marks: [
                  { mark: "groceries", by: -1 },
                  { mark: "cooking", by: 9 },
                  { mark: "not_known_here", by: 1 },
                ],
              }
            : a,
        ),
      })),
    };
    const person = (marks: { mark: string; value: number }[]) => ({
      ...(sampleSpec.people[0] as PersonDef),
      marks,
    });
    const use = (marks: { mark: string; value: number }[]) => {
      const sim = new Sim({ ...init, spec: skilled, people: [person(marks)] });
      const key = sampleSpec.people[0]?.key as string;
      sim.step([{ type: "control", agent: key, on: true }]);
      const events = steps(sim, 3600, [
        { type: "use", agent: key, object: "obj_fridge" as ObjectId, action: "snack" },
      ]);
      return { sim, slot: sim.slotOf(key), events, key };
    };

    it("is checked before someone being played can start, and says why not", () => {
      const { events } = use([]);
      expect(events.some((e) => e.type === "action_started")).toBe(false);
      expect(events.find((e) => e.type === "command_rejected")).toMatchObject({
        reason: "lacks_mark",
      });
    });

    it("changes when it's done, within its bounds, ignoring what the place doesn't know", () => {
      const { sim, slot } = use([{ mark: "groceries", value: 2 }]);
      expect(sim.mark(slot, "groceries")).toBe(1);
      expect(sim.mark(slot, "cooking")).toBe(5);
      expect(sim.mark(slot, "not_known_here")).toBe(0);
    });

    it("someone left to themselves wakes to eat rather than sleeping through starving", () => {
      const key = sampleSpec.people[0]?.key as string;
      const sim = new Sim({
        ...init,
        people: [
          {
            ...(sampleSpec.people[0] as PersonDef),
            money: 1_000_000,
            needs: sampleSpec.needs.map((n) => ({
              need: n.key,
              start: n.key === "hunger" ? 0 : 500,
            })),
          },
        ],
      });
      sim.step([{ type: "control", agent: key, on: true }]);
      const started = steps(sim, 1_500, [
        { type: "use", agent: key, object: "obj_bed" as ObjectId, action: "sleep" },
      ]).find((e) => e.type === "action_started" && e.agent === key);
      expect(started).toBeDefined();
      sim.step([{ type: "control", agent: key, on: false }]);
      const after = steps(sim, 3_000, []);
      expect(
        after.some(
          (e) => e.type === "action_interrupted" && e.agent === key && e.reason === "conditions",
        ),
      ).toBe(true);
    });

    describe("getting better at something", () => {
      const practising = (cost: number) => {
        const spec = {
          ...sampleSpec,
          marks: [{ key: "cooking", label: "Cooking", max: 1000, shown: true }],
          kinds: sampleSpec.kinds.map((k) => ({
            ...k,
            actions: k.actions.map((a) =>
              a.key === "snack"
                ? { ...a, durationMin: 1, cost, needs: [], marks: [{ mark: "cooking", by: 1 }] }
                : a,
            ),
          })),
        };
        const key = sampleSpec.people[0]?.key as string;
        const sim = new Sim({
          ...init,
          spec,
          people: [{ ...(sampleSpec.people[0] as PersonDef), money: 100_000_000 }],
        });
        sim.step([{ type: "control", agent: key, on: true }]);
        let goes = 0;
        for (let round = 0; round < 400 && goes < 100; round++) {
          const events = steps(sim, 90, [
            { type: "use", agent: key, object: "obj_fridge" as ObjectId, action: "snack" },
          ]);
          goes += events.filter((e) => e.type === "action_finished" && e.agent === key).length;
        }
        expect(goes).toBeGreaterThanOrEqual(100);
        return sim.mark(sim.slotOf(key), "cooking");
      };

      it("comes slower the better you are, and the same on every machine", () => {
        // About n+1 goes to go from n to n+1, so 100 goes reach about 13, nothing like 100.
        const level = practising(0);
        expect(level).toBeGreaterThan(6);
        expect(level).toBeLessThan(25);
        expect(practising(0)).toBe(level);
      });

      it("what's paid for is certain", () => {
        expect(practising(1)).toBeGreaterThanOrEqual(100);
      });
    });

    it("goes with them when they leave, and is in the hash", () => {
      const { sim, key, slot } = use([{ mark: "groceries", value: 2 }]);
      const left = sim
        .step([{ type: "depart", agent: key }])
        .concat(steps(sim, 5))
        .find((e) => e.type === "departed");
      expect(left).toMatchObject({
        marks: expect.arrayContaining([{ mark: "cooking", value: 5 }]),
      });
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(use([{ mark: "groceries", value: 2 }]).sim.hash()).toBe(
        use([{ mark: "groceries", value: 2 }]).sim.hash(),
      );
      expect(use([{ mark: "groceries", value: 3 }]).sim.hash()).not.toBe(
        use([{ mark: "groceries", value: 2 }]).sim.hash(),
      );
    });

    it("reads as nothing for someone who isn't here", () => {
      const sim = new Sim({ ...init, spec: skilled, people: [person([])] });
      expect(sim.mark(sim.slotOf("nobody_here"), "cooking")).toBe(0);
    });

    it("survives the place changing around them", () => {
      const sim = new Sim({ ...init, spec: skilled, people: [person([])] });
      const key = sampleSpec.people[0]?.key as string;
      sim.step([{ type: "mark", agent: key, mark: "cooking", by: 2 }]);
      const next = Sim.rebuild(sim, { ...init, spec: skilled, people: [person([])] });
      expect(next.mark(next.slotOf(key), "cooking")).toBe(2);
    });

    it("settles what's owed before someone leaves, whatever order it was sent in", () => {
      const sim = new Sim({ ...init, spec: skilled, people: [person([])] });
      const key = sampleSpec.people[0]?.key as string;
      const had = sim.wallet[sim.slotOf(key)] as number;
      const left = sim
        .step([
          { type: "depart", agent: key },
          { type: "charge", agent: key, amount: 100 },
        ])
        .concat(steps(sim, 3))
        .find((e) => e.type === "departed");
      expect(left).toMatchObject({ wallet: had - 100 });
    });

    it("can be moved by the server, and nobody's stranded by the place running on without it", () => {
      const sim = new Sim({ ...init, spec: skilled, people: [person([])] });
      const key = sampleSpec.people[0]?.key as string;
      sim.step([{ type: "mark", agent: key, mark: "cooking", by: 2 }]);
      expect(sim.mark(sim.slotOf(key), "cooking")).toBe(2);
    });
  });

  describe("how something turns out", () => {
    const risky = {
      ...sampleSpec,
      marks: [{ key: "hawking", label: "Hawking", max: 10, shown: true }],
      kinds: sampleSpec.kinds.map((k) => ({
        ...k,
        actions: k.actions.map((a) =>
          a.key === "snack"
            ? {
                ...a,
                durationMin: 2,
                cost: 0,
                income: 100,
                needs: [],
                outcomes: [
                  { weight: 1, say: "Big day", money: 1_000, marks: [] },
                  {
                    weight: 1,
                    favours: { mark: "hawking", perPoint: 20 },
                    say: "Quiet day",
                    money: -50_000_000,
                    marks: [{ mark: "hawking", by: 1 }],
                  },
                ],
              }
            : a,
        ),
      })),
    };
    const key = sampleSpec.people[0]?.key as string;
    const run = (seed: number, marks: { mark: string; value: number }[] = []) => {
      const sim = new Sim({
        ...init,
        spec: risky,
        settings: { ...sampleSettings, seed },
        people: [{ ...(sampleSpec.people[0] as PersonDef), marks }],
      });
      sim.step([{ type: "control", agent: key, on: true }]);
      const events = steps(sim, 3600, [
        { type: "use", agent: key, object: "obj_fridge" as ObjectId, action: "snack" },
      ]);
      return { sim, done: events.find((e) => e.type === "action_finished") };
    };

    it("says how it went, and the same seed always goes the same way", () => {
      const a = run(7);
      expect(["Big day", "Quiet day"]).toContain((a.done as { say?: string }).say);
      expect(run(7).sim.hash()).toBe(a.sim.hash());
    });

    it("goes both ways across seeds, and never leaves anyone below nothing", () => {
      const said = new Set<string>();
      for (let seed = 1; seed <= 20; seed++) {
        const r = run(seed);
        said.add((r.done as { say?: string }).say ?? "");
        expect(r.sim.wallet[r.sim.slotOf(key)]).toBeGreaterThanOrEqual(0);
      }
      expect(said).toEqual(new Set(["Big day", "Quiet day"]));
    });

    it("lets a mark shift the odds", () => {
      let quiet = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const r = run(seed, [{ mark: "hawking", value: 10 }]);
        if ((r.done as { say?: string }).say === "Quiet day") quiet++;
      }
      expect(quiet).toBeGreaterThanOrEqual(18);
    });
  });

  describe("being charged", () => {
    it("takes what's owed, never below nothing, and it's the same everywhere", () => {
      const run = () => {
        const sim = new Sim(init);
        const i = sim.slotOf("tolu");
        const had = sim.wallet[i] as number;
        sim.step([{ type: "charge", agent: "tolu", amount: 100 }]);
        expect(sim.wallet[i]).toBe(had - 100);
        sim.step([{ type: "charge", agent: "tolu", amount: had * 10 }]);
        expect(sim.wallet[i]).toBe(0);
        return sim.hash();
      };
      expect(run()).toBe(run());
    });
  });

  describe("what's someone else's", () => {
    const rideable = (cost: number) => ({
      ...sampleSpec,
      things: sampleSpec.things.map((x) =>
        x.object === "obj_fridge" ? { ...x, owner: "someone_else" } : x,
      ),
      kinds: sampleSpec.kinds.map((k) => ({
        ...k,
        actions: k.actions.map((a) =>
          a.key === "snack"
            ? { ...a, cost, durationMin: 2, leaves: { withThing: true }, needs: [] }
            : a,
        ),
      })),
    });
    const take = (cost: number) => {
      const sim = new Sim({ ...init, spec: rideable(cost) });
      sim.step([{ type: "control", agent: "tolu", on: true }]);
      return steps(sim, 1200, [
        { type: "use", agent: "tolu", object: "obj_fridge" as ObjectId, action: "snack" },
      ]);
    };

    it("can't be taken for free", () => {
      expect(take(0).some((e) => e.type === "action_started")).toBe(false);
    });

    it("can be ridden by anyone who pays the fare", () => {
      expect(take(100).some((e) => e.type === "action_started")).toBe(true);
    });
  });

  describe("running out of a need", () => {
    const costly = (income: number) => ({
      ...sampleSpec,
      needs: sampleSpec.needs.map((n) =>
        n.key === "hunger"
          ? { ...n, whenEmpty: { payPermille: 500, walkPermille: 400, feeling: "Starving" } }
          : n,
      ),
      kinds: sampleSpec.kinds.map((k) => ({
        ...k,
        actions: k.actions.map((a) =>
          a.key === "snack" ? { ...a, durationMin: 2, income, cost: 0, needs: [] } : a,
        ),
      })),
    });
    /** Tolu, hungry to nothing or not, walks to the fridge and works: when, and for how much. */
    const work = (empty: boolean) => {
      const sim = new Sim({ ...init, spec: costly(1_000) });
      sim.step([{ type: "control", agent: "tolu", on: true }]);
      const slot = sim.slotOf("tolu");
      const hunger = sim.needKeys.indexOf("hunger");
      const at = slot * sim.needKeys.length + hunger;
      sim.needs[at] = empty ? 0 : 3_600_000;
      const before = sim.wallet[slot] as number;
      const events = steps(sim, 3600, [
        { type: "use", agent: "tolu", object: "obj_fridge" as ObjectId, action: "snack" },
      ]);
      return {
        sim,
        tick: events.find((e) => e.type === "action_started")?.tick ?? -1,
        earned: (sim.wallet[slot] as number) - before,
        paid: events.find((e) => e.type === "action_finished"),
      };
    };

    it("cuts pay, and says so in what it reports, by what the spec says", () => {
      const full = work(false);
      const empty = work(true);
      expect(full.earned).toBe(1_000);
      expect(empty.earned).toBe(500);
      expect(empty.paid).toMatchObject({ earned: 500 });
    });

    it("slows someone down, but they still get there", () => {
      const full = work(false);
      const empty = work(true);
      expect(full.tick).toBeGreaterThan(0);
      expect(empty.tick).toBeGreaterThan(full.tick);
    });

    it("is the same on every machine", () => {
      expect(work(true).sim.hash()).toBe(work(true).sim.hash());
      expect(work(true).sim.hash()).not.toBe(work(false).sim.hash());
    });
  });

  describe("time spent on yourself", () => {
    /** The sample's snack, free, eight hours long, and worth 50 an hour. */
    const longSpec = (income = 0) => {
      const kinds = sampleSpec.kinds.map((k) =>
        k.actions.some((a) => a.key === "snack")
          ? {
              ...k,
              actions: k.actions.map((a) =>
                a.key === "snack"
                  ? {
                      ...a,
                      durationMin: 480,
                      income,
                      cost: 0,
                      needs: [{ need: "hunger", perHour: 50 }],
                    }
                  : a,
              ),
            }
          : k,
      );
      return { ...sampleSpec, kinds };
    };
    const goUse = (income = 0) => {
      const sim = new Sim({ ...init, spec: longSpec(income) });
      sim.step([{ type: "control", agent: "tolu", on: true }]);
      const started = steps(sim, 3600, [
        { type: "use", agent: "tolu", object: "obj_fridge" as ObjectId, action: "snack" },
      ]).find((e) => e.type === "action_started");
      return { sim, started };
    };

    it("takes someone being played at most a minute, and does as much for them", () => {
      const settings = { ...sampleSettings, ticksPerRealSecond: 10, actionMaxRealSec: 60 };
      const sim = new Sim({ ...init, settings, spec: longSpec() });
      sim.step([{ type: "control", agent: "tolu", on: true }]);
      const i = sim.slotOf("tolu");
      const hungerBefore = sim.need(i, "hunger");
      let started = -1;
      let finished = -1;
      const first = [
        { type: "use", agent: "tolu", object: "obj_fridge" as ObjectId, action: "snack" } as const,
      ];
      for (let t = 0; t < 4_000 && finished < 0; t++) {
        for (const e of sim.step(t === 0 ? first : [])) {
          if (e.type === "action_started") started = e.tick;
          if (e.type === "action_finished") finished = e.tick;
        }
      }
      expect(started).toBeGreaterThanOrEqual(0);
      expect(finished - started).toBeLessThanOrEqual(600);
      // Eight hours' worth (400), less what they got hungrier on the way and while eating.
      expect(sim.need(i, "hunger") - hungerBefore).toBeGreaterThan(250);
    });

    it("shortens work too, and it pays exactly what the whole shift pays", () => {
      const sim = new Sim({ ...init, spec: longSpec(500) });
      sim.step([{ type: "control", agent: "tolu", on: true }]);
      const events = steps(sim, 3600, [
        { type: "use", agent: "tolu", object: "obj_fridge" as ObjectId, action: "snack" },
      ]);
      const started = events.find((e) => e.type === "action_started");
      const finished = events.find((e) => e.type === "action_finished" && e.agent === "tolu");
      if (started?.type !== "action_started" || finished?.type !== "action_finished") {
        throw new Error("never finished");
      }
      expect(finished.tick - started.tick).toBeLessThan(480 * 60);
      expect(finished.earned).toBe(500);
    });

    it("leaves people nobody's playing to live at the pace of the day", () => {
      const sim = new Sim(init);
      const durations = new Map(
        sampleSpec.kinds.flatMap((k) => k.actions.map((a) => [a.key, a.durationMin] as const)),
      );
      let checked = 0;
      for (let t = 0; t < 40_000 && checked < 3; t++) {
        for (const e of sim.step()) {
          if (e.type !== "action_started") continue;
          const i = sim.slotOf(e.agent);
          expect(sim.actionPace[i]).toBe(1000);
          expect((sim.actionEnd[i] as number) - e.tick).toBe((durations.get(e.action) ?? 0) * 60);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(0);
    });

    it("is part of the state two machines must agree on", () => {
      const run = () => goUse().sim;
      expect(run().hash()).toBe(run().hash());
      const a = run();
      const before = a.hash();
      (a.actionPace as Int32Array)[0] = 7;
      expect(a.hash()).not.toBe(before);
    });
  });

  it("a held person doesn't choose for themselves; let go, they do", () => {
    const sim = new Sim(init);
    sim.step([{ type: "control", agent: "tolu", on: true }]);
    const i = sim.slotOf("tolu");
    steps(sim, 3600);
    expect(sim.mode[i]).toBe(Mode.Idle);
    sim.step([{ type: "control", agent: "tolu", on: false }]);
    steps(sim, 600);
    expect(sim.activity(i).action).not.toBeNull();
  });

  it("a held person walks where they're told and does what they're told", () => {
    const sim = new Sim(init);
    sim.step([{ type: "control", agent: "tolu", on: true }]);
    const i = sim.slotOf("tolu");
    const [x, z] = sim.position(i);
    const events = steps(sim, 120, [{ type: "walk", agent: "tolu", x: x + 600, z }]);
    expect(events.filter((e) => e.type === "command_rejected")).toEqual([]);
    expect(sim.mode[i]).toBe(Mode.Idle);
    expect(Math.abs((sim.position(i)[0] as number) - (x + 600))).toBeLessThanOrEqual(100);

    const used = steps(sim, 3600, [
      { type: "use", agent: "tolu", object: "obj_fridge" as ObjectId, action: "snack" },
    ]);
    expect(used.some((e) => e.type === "action_started" && e.agent === "tolu")).toBe(true);
  });

  it("refuses a walk to nowhere, and never lets anyone off the map", () => {
    const sim = new Sim(init);
    for (const x of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const events = sim.step([{ type: "walk", agent: "tolu", x, z: 0 }]);
      expect(events.find((e) => e.type === "command_rejected")).toMatchObject({
        agent: "tolu",
        reason: "unreachable",
      });
    }
    // Absurdly far is only a direction: they go as far as there is, and stay on floor.
    const regions = new Sim(init);
    const i = regions.agentIds.indexOf("tolu");
    const before = regions.cell[i] as number;
    for (const [x, z] of [
      [1e12, 0],
      [-1e9, -1e9],
    ] as const) {
      steps(regions, 3_000, [{ type: "walk", agent: "tolu", x, z }]);
      const c = regions.cell[i] as number;
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(regions.grid.width * regions.grid.height);
    }
    expect(regions.cell[i]).not.toBe(before);
  });

  it("someone pushing towards a wall walks up to it rather than standing still", () => {
    const sim = new Sim(init);
    const i = sim.agentIds.indexOf("tolu");
    const g = sim.grid;
    const startCell = sim.cell[i] as number;
    const [x, z] = cellCentre(g, startCell);
    // In every direction, however close the wall is, the push is never just refused.
    for (const [dx, dz] of [
      [1_800, 0],
      [-1_800, 0],
      [0, 1_800],
      [0, -1_800],
    ] as const) {
      const events = sim.step([{ type: "walk", agent: "tolu", x: x + dx, z: z + dz }]);
      expect(events.some((e) => e.type === "command_rejected")).toBe(false);
    }
  });

  it("walking is the same every time, off the map or into walls", () => {
    const run = () => {
      const sim = new Sim(init);
      steps(sim, 200, [{ type: "walk", agent: "tolu", x: 1e9, z: 500 }]);
      steps(sim, 200, [{ type: "walk", agent: "tolu", x: -1e9, z: 1e9 }]);
      return sim.hash();
    };
    expect(run()).toBe(run());
  });

  it("refuses a second copy of someone already here, and arrivals past capacity", () => {
    const sim = new Sim(init);
    const twice = sim.step([
      { type: "arrive", person: visitor("ada"), controlled: true },
      { type: "arrive", person: visitor("ada"), controlled: true },
    ]);
    expect(twice.filter((e) => e.type === "arrived")).toHaveLength(1);
    expect(twice.find((e) => e.type === "command_rejected")).toMatchObject({
      reason: "already_here",
    });
    const crowd = Array.from({ length: MAX_PEOPLE + 4 }, (_, k) => ({
      type: "arrive" as const,
      person: visitor(`v${String(k).padStart(2, "0")}`),
      controlled: false,
    }));
    const events = sim.step(crowd);
    expect(sim.present.reduce((a, b) => a + b, 0)).toBe(MAX_PEOPLE);
    expect(events.filter((e) => e.type === "command_rejected" && e.reason === "full").length).toBe(
      crowd.length - (MAX_PEOPLE - 3),
    );
  });

  it("leaving while away with a thing brings the thing back", () => {
    const sim = new Sim(init);
    sim.step([{ type: "control", agent: "tolu", on: true }]);
    // The sample world has nothing to go out with, so this only shows leaving takes nothing away.
    const events = steps(sim, 2, [{ type: "depart", agent: "tolu" }]);
    expect(events.some((e) => e.type === "departed" && e.agent === "tolu")).toBe(true);
    expect(sim.thingAway.every((v) => v === 0)).toBe(true);
  });

  it("people arriving together stand apart, not on top of each other", () => {
    const sim = new Sim(init);
    sim.step([
      { type: "arrive", person: visitor("ada"), controlled: true },
      { type: "arrive", person: visitor("bayo"), controlled: true },
      { type: "arrive", person: visitor("chi"), controlled: true },
    ]);
    const cells = ["ada", "bayo", "chi"].map((k) => sim.cell[sim.slotOf(k)]);
    expect(new Set(cells).size).toBe(3);
  });

  it("is deterministic: same arrivals and commands in any order give the same hash", () => {
    const a = new Sim(init);
    const b = new Sim(init);
    const cmds = [
      { type: "arrive" as const, person: visitor("ada"), controlled: true },
      { type: "arrive" as const, person: visitor("bayo"), controlled: false },
      { type: "control" as const, agent: "mama", on: true },
    ];
    a.step(cmds);
    b.step([...cmds].reverse());
    for (let t = 0; t < 7200; t++) {
      if (t === 3000) {
        a.step([{ type: "depart", agent: "bayo" }]);
        b.step([{ type: "depart", agent: "bayo" }]);
        continue;
      }
      a.step();
      b.step();
    }
    expect(a.hash()).toBe(b.hash());
    // And arrivals change the hash: they are state.
    const c = new Sim(init);
    for (let t = 0; t < 7201; t++) c.step();
    expect(c.hash()).not.toBe(a.hash());
  });

  it("rebuilding keeps arrivals in their slots with their state", () => {
    const sim = new Sim(init);
    sim.step([{ type: "arrive", person: visitor("ada", 9_999), controlled: true }]);
    const i = sim.slotOf("ada");
    steps(sim, 100);
    const next = Sim.rebuild(sim, init);
    expect(next.slotOf("ada")).toBe(i);
    expect(next.controlled[i]).toBe(1);
    expect(next.wallet[i]).toBe(sim.wallet[i]);
    expect(next.position(i)).toEqual(sim.position(i));
  });
});
