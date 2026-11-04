/** The data sources a model-written interface can name, evaluated over a sample city. */
import { placesOf, type RosterEntry, type Source } from "@aye/schema";
import { sampleCity, sampleSpec } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import { money } from "../src/format.ts";
import { bestForNeed, listItems, type SourceContext, visiblePlaces } from "../src/game/sources.ts";

const ctx: SourceContext = {
  bundle: {
    city: sampleCity,
    catalog: {
      mama_s_spot: {
        name: "Mama's spot",
        actions: [
          {
            kind: "stall",
            action: "work",
            label: "Work the stall",
            thing: "Stall",
            cost: 0,
            income: 300_000,
            durationMin: 60,
            needs: [],
          },
          {
            kind: "pot",
            action: "eat",
            label: "Eat stew",
            thing: "Pot",
            cost: 50_000,
            income: 0,
            durationMin: 20,
            needs: [{ need: "hunger", perHour: 900 }],
          },
          {
            kind: "bench",
            action: "rest",
            label: "Rest",
            thing: "Bench",
            cost: 0,
            income: 0,
            durationMin: 30,
            needs: [{ need: "energy", perHour: 200 }],
          },
        ],
      },
    },
    createdAt: new Date().toISOString(),
    settings: {
      seed: 1,
      gridCellMm: 100,
      startMinuteOfDay: 420,
      ticksPerRealSecond: 10,
      actionMaxRealSec: 60,
      tripMaxRealSec: 60,
    },
  },
  here: "your_flat",
  home: "your_flat",
  minute: 600,
  roster: [],
  online: 1,
};

describe("what to do about a need", () => {
  const action = (over: {
    kind: string;
    action: string;
    cost: number;
    durationMin: number;
    perHour: number;
  }) => ({
    label: over.action,
    thing: over.kind,
    income: 0,
    kind: over.kind,
    action: over.action,
    cost: over.cost,
    durationMin: over.durationMin,
    needs: [{ need: "hunger", perHour: over.perHour }],
  });
  // The city's one public place, and the player's own home as somewhere else to go.
  const place = placesOf(sampleCity).find((p) => !p.private)?.key as string;
  const elsewhere = placesOf(sampleCity).find((p) => p.private)?.key as string;
  const withActions = (here: unknown[], there: unknown[] = []): SourceContext =>
    ({
      ...ctx,
      here: place,
      home: elsewhere,
      minute: 720,
      bundle: {
        ...ctx.bundle,
        catalog: {
          [place]: { name: "Here", actions: here },
          [elsewhere]: { name: "There", actions: there },
        },
      },
    }) as SourceContext;
  const sip = action({ kind: "jar", action: "sip", cost: 100, durationMin: 5, perHour: 60 });
  const meal = action({ kind: "pot", action: "meal", cost: 900, durationMin: 30, perHour: 700 });

  it("takes the meal over the sip, even though the sip is cheaper", () => {
    expect(bestForNeed("hunger", withActions([sip, meal]), 5_000)?.title).toBe("meal");
  });

  it("doesn't offer what they can't pay for", () => {
    expect(bestForNeed("hunger", withActions([sip, meal]), 500)?.title).toBe("sip");
    expect(bestForNeed("hunger", withActions([meal]), 500)).toBeUndefined();
  });

  it("counts free things, which is all someone with nothing can use", () => {
    const well = action({ kind: "well", action: "draw", cost: 0, durationMin: 30, perHour: 700 });
    expect(bestForNeed("hunger", withActions([well, meal]), 0)?.title).toBe("draw");
    expect(bestForNeed("hunger", withActions([well, meal]), 5_000)?.title).toBe("draw");
  });

  it("sends them elsewhere only when what's here barely helps", () => {
    const a = bestForNeed("hunger", withActions([sip], [meal]), 5_000);
    expect(a?.place).toBe(elsewhere);
    const decent = action({
      kind: "pot",
      action: "bowl",
      cost: 300,
      durationMin: 30,
      perHour: 400,
    });
    expect(bestForNeed("hunger", withActions([decent], [meal]), 5_000)?.place).toBe(place);
  });
});

describe("earned work on the boards", () => {
  it("says what you lack before sending you there, and lists it last", () => {
    const bundle = {
      city: sampleCity,
      catalog: Object.fromEntries(
        placesOf(sampleCity)
          .filter((p) => !p.private)
          .slice(0, 1)
          .map((p) => [
            p.key,
            {
              name: p.name,
              actions: [
                {
                  kind: "k",
                  action: "earned",
                  label: "Earned",
                  thing: "T",
                  cost: 0,
                  income: 9_000,
                  durationMin: 60,
                  needs: [],
                  asks: [{ mark: sampleCity.marks[0]?.key ?? "", op: "gte" as const, value: 3 }],
                },
                {
                  kind: "k",
                  action: "open",
                  label: "Open",
                  thing: "T",
                  cost: 0,
                  income: 1,
                  durationMin: 60,
                  needs: [],
                },
              ],
            },
          ]),
      ),
    } as unknown as SourceContext["bundle"];
    const ctx = (marks?: Record<string, number>): SourceContext => ({
      bundle,
      here: null,
      home: null,
      minute: 720,
      roster: [],
      online: 0,
      ...(marks ? { marks } : {}),
    });
    const source = { from: "actions", sort: "best_paid", filter: "pays" } as Source;
    const short = listItems(source, ctx({}), 10);
    expect(short.map((i) => i.title)).toEqual(["Open", "Earned"]);
    expect(short[1]?.lacking).toMatch(/^Needs .+ 3$/);
    const enough = listItems(source, ctx({ [sampleCity.marks[0]?.key ?? ""]: 3 }), 10);
    expect(enough[0]?.title).toBe("Earned");
    expect(enough[0]?.lacking).toBeUndefined();
    // Running on empty, the list says what you'd really get.
    const tired = listItems(source, { ...ctx(), payPermille: 500 }, 10);
    const whole = listItems(source, ctx(), 10);
    expect(tired[0]?.badge).not.toBe(whole[0]?.badge);
    // However long the list, what you're working towards stays on it.
    expect(listItems(source, ctx({}), 1).map((i) => i.title)).toEqual(["Open"]);
    const busy = {
      ...bundle,
      catalog: Object.fromEntries(
        Object.entries(bundle.catalog).map(([key, built]) => [
          key,
          {
            ...built,
            actions: [
              ...built.actions,
              ...["More", "Yet more"].map((label) => ({
                ...built.actions[1],
                action: label,
                label,
              })),
            ],
          },
        ]),
      ),
    } as SourceContext["bundle"];
    const long = listItems(source, { ...ctx({}), bundle: busy }, 2);
    expect(long.map((i) => i.title)).toContain("Earned");
    // Work behind a door you can't get through says so, in the place's name.
    const first = placesOf(sampleCity).find((p) => !p.private);
    const barred = {
      ...bundle,
      city: {
        ...sampleCity,
        items: sampleCity.items.map((i) =>
          i.key === first?.key
            ? {
                ...i,
                traits: {
                  ...i.traits,
                  place: {
                    ...i.traits.place,
                    asks: [{ mark: sampleCity.marks[0]?.key ?? "", atLeast: 2 }],
                  },
                },
              }
            : i,
        ),
      },
    } as SourceContext["bundle"];
    const door = listItems(source, { ...ctx({}), bundle: barred }, 10);
    expect(door.every((i) => i.lacking?.endsWith(" 2") || i.lacking?.endsWith(" 3"))).toBe(true);
    expect(door[0]?.lacking).toContain(first?.name ?? "");
    // Not knowing yet isn't lacking.
    expect(listItems(source, ctx(), 10).every((i) => i.lacking === undefined)).toBe(true);
  });
});

describe("interface data sources", () => {
  it("finds ways to earn, best paid first, wherever they are", () => {
    const items = listItems(
      { from: "actions", filter: "pays", need: null, sort: "best_paid" },
      ctx,
      10,
    );
    expect(items.map((i) => i.title)).toEqual(["Work the stall"]);
    expect(items[0]?.place).toBe("mama_s_spot");
    expect(items[0]?.tone).toBe("good");
  });

  it("says when a job's place is closed now, and doesn't make it look ready", () => {
    // 23:30: Mama's spot (06:00-23:00) has shut.
    const late = { ...ctx, minute: 23 * 60 + 30 };
    const [job] = listItems(
      { from: "actions", filter: "pays", need: null, sort: "best_paid" },
      late,
      10,
    );
    expect(job?.detail).toContain(sampleCity.words.closedNow);
    expect(job?.tone).toBe("muted");
    // It still takes you there (to see when it opens), with the job queued.
    expect(job?.act).toEqual({ kind: "stall", action: "work" });
  });

  it("filters by the need an action helps", () => {
    const items = listItems(
      { from: "actions", filter: "any", need: "hunger", sort: "cheapest" },
      ctx,
      10,
    );
    expect(items.map((i) => i.title)).toEqual(["Eat stew"]);
  });

  it("lists places by tag and opening hours, never someone else's home", () => {
    const night = { ...ctx, minute: 60 };
    expect(
      listItems({ from: "places", tag: "food", openNow: false, sort: "name" }, ctx, 10).map(
        (i) => i.id,
      ),
    ).toEqual(["mama_s_spot"]);
    expect(
      listItems({ from: "places", tag: "food", openNow: true, sort: "name" }, night, 10),
    ).toEqual([]);
    const stranger = { ...ctx, home: null };
    expect(visiblePlaces(stranger).map((p) => p.key)).toEqual(["mama_s_spot"]);
  });

  it("shows who is here, and which of them are players", () => {
    const roster: RosterEntry[] = [
      { slot: 0, key: "tolu", person: sampleSpec.people[0]!, player: null, heldBy: "bob" },
      {
        slot: 1,
        key: "pc_x",
        person: { ...sampleSpec.people[0]!, name: "Ada" },
        player: "alice",
        heldBy: null,
      },
    ];
    const withPeople = { ...ctx, roster };
    expect(listItems({ from: "people" }, withPeople, 10).map((i) => i.badge)).toEqual([
      "played by @bob",
      "@alice",
    ]);
    expect(listItems({ from: "players" }, withPeople, 10).map((i) => i.title)).toEqual(["Ada"]);
  });

  it("respects the limit", () => {
    expect(listItems({ from: "travel" }, ctx, 1)).toHaveLength(1);
  });
});

describe("money", () => {
  it("shows part-units in full, and whole amounts without them", () => {
    expect(money(1290, "GBP")).toMatch(/12\.90/);
    expect(money(1300, "GBP")).not.toMatch(/\./);
    expect(money(25000, "GBP")).not.toMatch(/\./);
  });
});
