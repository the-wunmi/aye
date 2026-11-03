import { MemoryArtifactStore, MemoryRecipeIndex } from "@aye/artifacts";
import {
  AIM_NEVER_DUE,
  CitySpec,
  moverNow,
  moversOf,
  placeOpen,
  placesOf,
  THREAD_BOUNDS,
} from "@aye/schema";
import { sampleCity } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import {
  type ActivePlayer,
  directorBriefFor as briefFor,
  compileDirection,
  type Director,
  type DirectorDraft,
  directCity,
} from "../src/index.ts";

const minute = 1440 + 9 * 60; // day 2, 09:00

const draft = (over: Partial<DirectorDraft> = {}): DirectorDraft => ({
  aims: [],
  events: [
    {
      name: "Fuel queue",
      about: "Buses wait hours for diesel.",
      icon: "\u{26FD}",
      startsInMin: 30,
      lastsMin: 240,
      effects: [
        { type: "slowed", target: "Bus", permille: 400 },
        { type: "fare", target: "Bus", permille: 1500 },
      ],
    },
  ],
  end: [],
  headlines: [{ icon: "\u{26FD}", text: "Queues at every pump on the mainland" }],
  threads: [],
  memory: "Started a fuel shortage; follow up with prices tomorrow.",
  ...over,
});

const catalog = new Map([
  [
    "mama_s_spot",
    {
      actions: [{ kind: "stove", action: "cook", label: "Cook a pot of stew", cost: 0, income: 0 }],
      people: [{ key: "mama", name: "Mama" }],
    },
  ],
]);
const active = [
  {
    userId: "usr_bob",
    name: "Bob",
    place: "your_flat",
    money: 5_000,
    needs: [{ label: "Hunger", level: 200 }],
    threads: [],
  },
];

describe("the director", () => {
  it("won't send a player to do what can't be done yet, and doesn't offer it", () => {
    const shelf = new Map([
      [
        "mama_s_spot",
        {
          actions: [
            {
              kind: "shelf",
              action: "restock",
              label: "Restock shelf",
              cost: 0,
              income: 0,
              ready: false,
            },
          ],
          people: [],
        },
      ],
    ]);
    const b = briefFor({
      city: sampleCity,
      minute,
      players: new Map(),
      catalog: shelf,
      active,
      life: null,
      memory: "",
    });
    expect(b.places.find((p) => p.name === "Mama's spot")?.actions).toEqual([]);
    const out = compileDirection(
      draft({
        events: [],
        threads: [
          {
            player: "Bob",
            title: "A hand",
            about: "Help out.",
            icon: "\u{2B50}",
            dueInMin: 240,
            reward: 500,
            onDone: [],
            onMissed: [],
            steps: [
              { check: "do", place: "Mama's spot", action: "Restock shelf", text: "Stack it" },
            ],
          },
        ] as never,
      }),
      sampleCity,
      minute,
      { catalog: shelf, active },
    );
    expect(out.threads).toEqual([]);
    expect(out.issues.join(" ")).toContain("can't be done yet");
  });

  it("won't send a player back to what they were just asked, or pile more on", () => {
    const job = (title: string) => ({
      player: "Bob",
      title,
      about: "Help out.",
      icon: "\u{2B50}",
      dueInMin: 240,
      reward: 500,
      onDone: [],
      onMissed: [],
      steps: [{ check: "do", place: "Mama's spot", action: "Cook a pot of stew", text: "Cook" }],
    });
    const asked = { place: "mama_s_spot", kind: "stove", action: "cook" };
    const repeat = compileDirection(
      draft({ events: [], threads: [job("Again")] as never }),
      sampleCity,
      minute,
      { catalog, active: [{ ...active[0]!, recent: [asked] }] },
    );
    expect(repeat.threads).toEqual([]);
    expect(repeat.issues.join(" ")).toContain("just asked");
    const busy = compileDirection(
      draft({ events: [], threads: [job("More")] as never }),
      sampleCity,
      minute,
      { catalog, active: [{ ...active[0]!, threads: ["One", "Two"] }] },
    );
    expect(busy.threads).toEqual([]);
  });

  it("puts something at stake, only on the city's marks, within bounds", () => {
    const job = {
      player: "Bob",
      title: "A favour",
      about: "",
      icon: "x",
      dueInMin: 240,
      reward: 500,
      steps: [
        {
          check: "have_money",
          mark: "",
          place: "",
          action: "",
          person: "",
          amount: 100,
          text: "Save",
        },
      ],
      onDone: [{ mark: "Cooking", by: 99 }],
      onMissed: [
        { mark: "Cooking", by: -1 },
        { mark: "Nonsense", by: -1 },
      ],
    };
    const out = compileDirection(
      draft({ events: [], threads: [job] as never }),
      sampleCity,
      minute,
      {
        catalog,
        active,
      },
    );
    expect(out.threads[0]?.thread.onDone).toEqual([{ mark: "cooking", by: 3 }]);
    expect(out.threads[0]?.thread.onMissed).toEqual([{ mark: "cooking", by: -1 }]);
    expect(out.issues.join(" ")).toContain("Nonsense");
  });

  it("never pays less for a job than it costs to do", () => {
    const paying = new Map([
      [
        "mama_s_spot",
        {
          actions: [
            {
              kind: "stall",
              action: "buy",
              label: "Buy lunch",
              cost: 250_000,
              income: 0,
              durationMin: 30,
            },
          ],
          people: [],
        },
      ],
    ]);
    const job = {
      player: "Bob",
      title: "Lunch for a friend",
      about: "",
      icon: "x",
      dueInMin: 300,
      reward: 1,
      steps: [
        {
          check: "do",
          mark: "",
          place: "mama_s_spot",
          action: "Buy lunch",
          person: "",
          amount: 0,
          text: "Buy it",
        },
      ],
      onDone: [],
      onMissed: [],
    };
    const out = compileDirection(
      draft({ events: [], threads: [job] as never }),
      sampleCity,
      minute,
      {
        catalog: paying,
        active,
      },
    );
    expect(out.threads[0]?.thread.reward).toBeGreaterThan(250_000);
  });

  it("won't send anyone through a door they can't get through yet", () => {
    const mark = sampleCity.marks[0];
    if (!mark) throw new Error("the sample city has marks");
    const gated = {
      ...sampleCity,
      items: sampleCity.items.map((i) =>
        i.key === "mama_s_spot"
          ? {
              ...i,
              traits: {
                ...i.traits,
                place: {
                  ...i.traits.place,
                  hours: null,
                  asks: [{ mark: mark.key, atLeast: 2 }],
                },
              },
            }
          : i,
      ),
    };
    const job = {
      player: "Bob",
      title: "Go and see",
      about: "",
      icon: "x",
      dueInMin: 240,
      reward: 500,
      steps: [
        {
          check: "be_at",
          mark: "",
          place: "mama_s_spot",
          action: "",
          person: "",
          amount: 0,
          text: "Go there",
        },
      ],
      onDone: [],
      onMissed: [],
    };
    const run = (marks: { label: string; value: number }[]) =>
      compileDirection(draft({ events: [], threads: [job] as never }), gated, minute, {
        active: active.map((a) => ({ ...a, marks })),
      });
    const shut = run([]);
    expect(shut.threads).toEqual([]);
    expect(shut.issues.join(" ")).toContain("can't get into");
    expect(run([{ label: mark.label, value: 2 }]).threads).toHaveLength(1);
  });

  it("keeps a long event name inside a valid key", () => {
    const base = draft();
    const first = base.events[0];
    if (!first) throw new Error("the draft has an event");
    const out = compileDirection(
      draft({
        events: [{ ...first, name: "Heavy rain floods the whole of the mainland road network" }],
      }),
      sampleCity,
      minute,
    );
    expect(out.events[0]?.key).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
    expect(out.events[0]?.key.endsWith(`_${minute + 30}`)).toBe(true);
    expect(() => CitySpec.parse({ ...sampleCity, events: out.events })).not.toThrow();
  });

  it("reads the city as it is now: what's open, running, and its own notes", () => {
    const b = briefFor({
      city: sampleCity,
      minute,
      players: new Map([["mama_s_spot", 2]]),
      catalog,
      active,
      life: null,
      memory: "remember",
    });
    expect(b.players).toEqual([
      {
        name: "Bob",
        at: "Your flat",
        money: "50.00 NGN",
        owes: "0.00 NGN",
        aim: "",
        marks: [],
        low: ["Hunger"],
        threads: [],
        askedLately: [],
      },
    ]);
    expect(b.now).toEqual({ day: 2, time: "09:00", daylight: true });
    expect(b.places).toEqual([
      {
        name: "Mama's spot",
        about: "Hot food by the water.",
        open: true,
        needs: [],
        hours: "06:00-23:00",
        players: 2,
        actions: [{ label: "Cook a pot of stew", costs: "", pays: "" }],
        people: ["Mama"],
      },
    ]);
    expect(b.movers.map((m) => [m.name, m.fare])).toEqual([
      ["Walk", "free"],
      ["Bus", "200.00 NGN + 50.00 NGN/km"],
    ]);
    expect(b.memory).toBe("remember");
  });

  it("turns its words into bounded events on the city's own things", () => {
    const r = compileDirection(draft(), sampleCity, minute);
    expect(r.issues).toEqual([]);
    expect(r.events).toHaveLength(1);
    const e = r.events[0]!;
    expect([e.from, e.to]).toEqual([minute + 30, minute + 270]);
    const bus = moversOf(sampleCity)[1]!;
    expect(moverNow(bus, r.events, minute + 60)).toMatchObject({ speedKmh: 10, running: true });
    expect(r.headlines[0]?.text).toBe("Queues at every pump on the mainland");
    expect(r.memory).toContain("fuel shortage");
  });

  it("never stops or charges for the way people with no money get around", () => {
    const r = compileDirection(
      draft({
        events: [
          {
            name: "Lockdown",
            about: "",
            icon: "\u{1F6AB}",
            startsInMin: 0,
            lastsMin: 99_999,
            effects: [
              { type: "halted", target: "Walk", permille: 1000 },
              { type: "fare", target: "walk", permille: 5000 },
              { type: "closed", target: "Nowhere", permille: 1000 },
              { type: "closed", target: "Mama's spot", permille: 1000 },
            ],
          },
        ],
      }),
      sampleCity,
      minute,
    );
    expect(r.issues.filter((i) => i.includes("no money"))).toHaveLength(2);
    expect(r.issues.some((i) => i.includes('"Nowhere", which isn\'t a place'))).toBe(true);
    const e = r.events[0]!;
    // Kept: the place it really can close; bounded to three days.
    expect(e.effects).toEqual([{ type: "closed", place: "mama_s_spot" }]);
    expect(e.to - e.from).toBe(3 * 1440);
    const spot = placesOf(sampleCity)[1]!;
    expect(placeOpen(spot, r.events, minute + 10)).toBe(false);
  });

  it("ends what it says is over, and drops what's long past", () => {
    const first = compileDirection(draft(), sampleCity, minute);
    const city = { ...sampleCity, events: first.events };
    const later = minute + 60;
    const r = compileDirection(draft({ events: [], end: ["Fuel queue"] }), city, later);
    expect(r.events[0]?.to).toBe(later + 1);
    const muchLater = compileDirection(draft({ events: [] }), city, minute + 2000);
    expect(muchLater.events).toEqual([]);
  });

  it("acts through a memoised stage, fixing its answer once if it must", async () => {
    let calls = 0;
    const director: Director = {
      model: { provider: "test", model: "director", version: "1" },
      prompt: "direct",
      effort: "low",
      async direct(brief) {
        calls++;
        // First answer breaks a rule; given the fix, it complies.
        return brief.fix.length === 0
          ? draft({
              events: [
                {
                  ...draft().events[0]!,
                  effects: [{ type: "halted", target: "Walk", permille: 1000 }],
                },
              ],
            })
          : draft();
      },
    };
    const deps = { director, store: new MemoryArtifactStore(), index: new MemoryRecipeIndex() };
    const args = {
      city: sampleCity,
      minute,
      players: new Map(),
      catalog,
      active,
      life: null,
      memory: "",
    };
    const r = await directCity(args, deps);
    expect(calls).toBe(2);
    expect(r.issues).toEqual([]);
    expect(r.city.events).toHaveLength(1);
    await directCity(args, deps);
    expect(calls).toBe(2);
  });

  it("gives a player a thread of steps the realm can check, fairly paid", () => {
    const step = (over: Partial<DirectorDraft["threads"][number]["steps"][number]>) => ({
      check: "be_at" as const,
      mark: "",
      place: "",
      action: "",
      person: "",
      amount: 0,
      text: "",
      ...over,
    });
    const r = compileDirection(
      draft({
        events: [],
        threads: [
          {
            player: "Bob",
            title: "Help Mama",
            about: "She's short-handed at lunch.",
            icon: "\u{1F372}",
            steps: [
              step({ check: "be_at", place: "Mama's spot", text: "Go to Mama's" }),
              step({ check: "meet", place: "Mama's spot", person: "Mama", text: "Find Mama" }),
              step({
                check: "do",
                place: "Mama's spot",
                action: "Cook a pot of stew",
                text: "Cook",
              }),
              step({ check: "do", place: "Mama's spot", action: "Fly to the moon", text: "?" }),
              step({ check: "be_at", place: "Your flat", text: "Not public" }),
            ],
            dueInMin: 10,
            reward: 999_999_999,
            onDone: [],
            onMissed: [],
          },
          // One new thread a turn, and only for players who are here.
          {
            player: "Bob",
            title: "Another",
            about: "",
            icon: "x",
            steps: [step({ check: "have_money", amount: 100 })],
            dueInMin: 100,
            reward: 1,
            onDone: [],
            onMissed: [],
          },
          {
            player: "Nobody",
            title: "Ghost",
            about: "",
            icon: "x",
            steps: [step({ check: "have_money", amount: 1 })],
            dueInMin: 100,
            reward: 1,
            onDone: [],
            onMissed: [],
          },
        ],
      }),
      sampleCity,
      minute,
      { catalog, active },
    );
    expect(r.threads).toHaveLength(1);
    const { userId, thread } = r.threads[0]!;
    expect(userId).toBe("usr_bob");
    expect(thread.steps).toEqual([
      { check: "be_at", place: "mama_s_spot", text: "Go to Mama's" },
      { check: "meet", place: "mama_s_spot", person: "mama", text: "Find Mama" },
      { check: "do", place: "mama_s_spot", kind: "stove", action: "cook", text: "Cook" },
    ]);
    // A day's pay at most; at least three hours to do it.
    expect(thread.reward).toBe(sampleCity.economy.hourPay * 8);
    expect(thread.due - thread.from).toBe(THREAD_BOUNDS.minMinutes);
    expect(r.issues.some((i) => i.includes('"Fly to the moon"'))).toBe(true);
    expect(r.issues.some((i) => i.includes('"Your flat" isn\'t a public place'))).toBe(true);
    expect(r.issues.some((i) => i.includes('"Nobody"'))).toBe(true);
  });

  it("gives someone who has reached their aim the next one, in marks and money only", () => {
    const aim = (player: string) => ({
      player,
      title: "Open a second stall",
      about: "Bigger.",
      icon: "x",
      reward: 999_999_999_999,
      steps: [
        { mark: "Cooking", amount: 2, text: "Cook" },
        { mark: "", amount: 999_999_999_999, text: "Save" },
        { mark: "Nonsense", amount: 1, text: "Dropped" },
      ],
    });
    const done = [{ ...(active[0] as ActivePlayer), aim: "" }];
    const r = compileDirection(draft({ aims: [aim("Bob"), aim("Bob")] }), sampleCity, 1_000, {
      catalog,
      active: done,
    });
    expect(r.threads).toHaveLength(1);
    const { thread } = r.threads[0] as (typeof r.threads)[number];
    expect(thread.aim).toBe(true);
    expect(thread.due).toBe(AIM_NEVER_DUE);
    expect(thread.steps.map((s) => s.check)).toEqual(["mark", "have_money"]);
    expect(thread.reward).toBe(sampleCity.economy.hourPay * 200);
    expect(r.issues.some((i) => i.includes('"Nonsense"'))).toBe(true);
    // Still working towards one: no second.
    const busy = [{ ...done[0], aim: "Own a stall" } as ActivePlayer];
    expect(
      compileDirection(draft({ aims: [aim("Bob")] }), sampleCity, 1_000, { catalog, active: busy })
        .threads,
    ).toEqual([]);
  });

  it("leaves room for the work itself, or doesn't hand the job out", () => {
    const long = (durationMin: number) =>
      new Map(
        [...catalog].map(([k, v]) => [
          k,
          { ...v, actions: v.actions.map((a) => ({ ...a, durationMin })) },
        ]),
      );
    const job = (at: number, durationMin: number) =>
      compileDirection(
        draft({
          events: [],
          threads: [
            {
              player: "Bob",
              title: "Long shift",
              about: "",
              icon: "x",
              steps: [
                {
                  check: "do",
                  mark: "",
                  place: "Mama's spot",
                  action: catalog.get("mama_s_spot")?.actions[0]?.label ?? "",
                  person: "",
                  amount: 0,
                  text: "Work",
                },
              ],
              dueInMin: 180,
              reward: 100,
              onDone: [],
              onMissed: [],
            },
          ],
        }),
        sampleCity,
        at,
        { catalog: long(durationMin), active },
      );
    const morning = 1440 + 7 * 60;
    const fits = job(morning, 240).threads[0]?.thread;
    expect(fits && fits.due - fits.from).toBeGreaterThanOrEqual(240 + 120);
    expect(job(morning, 2_000).threads).toEqual([]);
  });

  it("never hands out a thread that can't be done in time: closed places push the deadline", () => {
    const night = 1440 + 2 * 60; // day 2, 02:00; Mama's opens at 06:00
    const r = compileDirection(
      draft({
        events: [],
        threads: [
          {
            player: "Bob",
            title: "Dawn shift",
            about: "",
            icon: "x",
            steps: [
              {
                check: "be_at",
                mark: "",
                place: "Mama's spot",
                action: "",
                person: "",
                amount: 0,
                text: "Go",
              },
            ],
            dueInMin: 60,
            reward: 100,
            onDone: [],
            onMissed: [],
          },
        ],
      }),
      sampleCity,
      night,
      { catalog, active },
    );
    const { thread } = r.threads[0]!;
    // Opens at 06:00, then three hours to do it.
    expect(thread.due).toBe(1440 + 6 * 60 + 180);
    expect(r.issues.some((i) => i.includes("given until after"))).toBe(true);
  });

  it("never due after the doors shut; too little time left today means tomorrow", () => {
    const dawn = (at: number) =>
      compileDirection(
        draft({
          events: [],
          threads: [
            {
              player: "Bob",
              title: "Evening shift",
              about: "",
              icon: "x",
              steps: [
                {
                  check: "be_at",
                  mark: "",
                  place: "Mama's spot",
                  action: "",
                  person: "",
                  amount: 0,
                  text: "Go",
                },
              ],
              dueInMin: 600,
              reward: 100,
              onDone: [],
              onMissed: [],
            },
          ],
        }),
        sampleCity,
        at,
        { catalog, active },
      ).threads[0]!.thread;
    // 21:00, two hours before Mama's closes at 23:00: due at closing, not 07:00 tomorrow.
    expect(dawn(1440 + 21 * 60).due).toBe(1440 + 23 * 60);
    // 22:00, an hour left: tomorrow, three hours after it opens at 06:00.
    expect(dawn(1440 + 22 * 60).due).toBe(2 * 1440 + 6 * 60 + 180);
  });
});
