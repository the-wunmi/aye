import { describe, expect, it } from "vitest";
import { nextBill, settleBills } from "../src/city-spec.ts";
import { sampleCity } from "../src/fixtures.ts";
import {
  CitySpec,
  cityIssues,
  Icon,
  isOpen,
  moverServes,
  moversOf,
  placesOf,
  propsOf,
  trip,
  tripPacePermille,
  viewsOf,
} from "../src/index.ts";
import { ClientMessage } from "../src/realm.ts";
import { emptyCost, NeedDef } from "../src/world-spec.ts";

describe("the city's bills", () => {
  const rent = { name: "Rent", amount: 1_000, everyDays: 3 };

  it("doesn't bill someone the day they turn up, or for time they were away", () => {
    expect(settleBills([rent], { day: -1, owes: 0 }, 2, 5_000)).toMatchObject({
      billed: { day: 2, owes: 0 },
      paid: 0,
    });
    expect(settleBills([rent], { day: 2, owes: 0 }, 30, 5_000)).toMatchObject({
      billed: { day: 30, owes: 0 },
      paid: 1_000,
    });
  });

  it("takes what the wallet holds, and what's short is owed, paid first from earnings", () => {
    const short = settleBills([rent], { day: 2, owes: 0 }, 3, 400);
    expect(short).toMatchObject({ paid: 400, billed: { owes: 600 } });
    expect(settleBills([rent], short.billed, 3, 250)).toMatchObject({
      paid: 250,
      billed: { owes: 350 },
      fell: [],
    });
    expect(settleBills([rent], { day: 3, owes: 350 }, 3, 0).paid).toBe(0);
  });

  it("can come in instead, and only for those with what it takes", () => {
    const keke = {
      name: "Keke earnings",
      amount: 800,
      everyDays: 1,
      pays: true,
      when: { mark: "owns_keke", atLeast: 1 },
    };
    const has = () => 1;
    expect(settleBills([keke], { day: 2, owes: 0 }, 3, 0, has)).toMatchObject({
      earned: 800,
      paid: 0,
    });
    expect(settleBills([keke], { day: 2, owes: 0 }, 3, 0)).toMatchObject({ earned: 0, fell: [] });
    // What comes in goes to what's owed first.
    expect(settleBills([keke, rent], { day: 2, owes: 0 }, 3, 0, has)).toMatchObject({
      earned: 800,
      paid: 800,
      billed: { owes: 200 },
    });
    expect(nextBill([keke], 3)).toBeNull();
  });

  it("says what's next", () => {
    expect(nextBill([rent], 4)).toEqual({ bill: rent, day: 6 });
    expect(nextBill([], 4)).toBeNull();
  });

  it("can't be touched by a client", () => {
    expect(
      ClientMessage.safeParse({ t: "do", cmd: { type: "charge", agent: "x", amount: -5 } }).success,
    ).toBe(false);
  });
});

describe("what running out of a need costs", () => {
  const need = (payPermille: number) => ({
    key: "hunger",
    label: "Hunger",
    decayPerHour: 60,
    whenEmpty: { payPermille, walkPermille: 500, feeling: "Starving" },
  });

  it("charges the harshest of what's empty, and says how the worst feels", () => {
    const soft = {
      ...need(800),
      key: "fun",
      whenEmpty: { payPermille: 800, walkPermille: 900, feeling: "Bored" },
    };
    const hard = {
      ...need(400),
      whenEmpty: { payPermille: 400, walkPermille: 500, feeling: "Dead" },
    };
    expect(emptyCost([soft, hard], () => 0)).toEqual({
      payPermille: 400,
      walkPermille: 500,
      feeling: "Dead",
    });
    expect(emptyCost([soft, hard], (n) => (n.key === "fun" ? 0 : 500)).feeling).toBe("Bored");
    expect(emptyCost([soft, hard], () => 500)).toEqual({
      payPermille: 1000,
      walkPermille: 1000,
      feeling: null,
    });
  });

  it("can slow someone down but can't strand them", () => {
    expect(NeedDef.safeParse(need(250)).success).toBe(true);
    expect(NeedDef.safeParse(need(0)).success).toBe(false);
    expect(NeedDef.safeParse(need(2_000)).success).toBe(false);
  });
});

describe("city specs", () => {
  it("the sample city is valid", () => {
    expect(cityIssues(sampleCity)).toEqual([]);
  });

  it("names every broken reference in words a model can act on", () => {
    const broken = {
      ...sampleCity,
      items: sampleCity.items.map((i) =>
        i.key === "your_flat"
          ? {
              ...i,
              where: { ...i.where, district: "nowhere" },
              traits: { place: { private: false } },
            }
          : i.key === "bridge_road"
            ? { ...i, kind: "teleporter" }
            : i,
      ),
      ui: {
        ...sampleCity.ui,
        place: [
          {
            region: "top" as const,
            widgets: [
              {
                type: "button" as const,
                label: "Go",
                icon: "\u{1F5FA}",
                intent: { do: "open_app" as const, app: "ghost" },
              },
            ],
          },
        ],
      },
    };
    const issues = cityIssues(broken);
    expect(issues).toContain('place "your_flat" is in unknown district "nowhere"');
    expect(issues).toContain('item "bridge_road" is of unknown kind "teleporter"');
    expect(issues).toContain('start "fresh_start" home "your_flat" must be a private place');
    expect(issues).toContain('place top widget 0 opens unknown app "ghost"');
    expect(CitySpec.safeParse(broken).success).toBe(false);
  });

  it("icons are one emoji and nothing else", () => {
    for (const ok of [
      "\u{1F3E0}",
      "\u{1F3D9}\u{FE0F}",
      "\u{1F468}\u{1F3FE}\u{200D}\u{1F373}",
      "\u{1F1F3}\u{1F1EC}",
    ]) {
      expect(Icon.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ["home", "<b>", "\u{1F3E0}x", "", "javascript:", "\u{202E}\u{1F3E0}"]) {
      expect(Icon.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("opening hours wrap past midnight", () => {
    expect(isOpen({ from: 1200, to: 120 }, 1300)).toBe(true);
    expect(isOpen({ from: 1200, to: 120 }, 60)).toBe(true);
    expect(isOpen({ from: 1200, to: 120 }, 600)).toBe(false);
    expect(isOpen(null, 600)).toBe(true);
  });

  it("trips cost a flag-fall plus distance, and take at least a minute", () => {
    const [home, spot] = placesOf(sampleCity);
    const [walk, bus] = moversOf(sampleCity);
    if (!home || !spot || !walk || !bus) throw new Error("fixture");
    const byFoot = trip(walk, home, spot);
    expect(byFoot.fare).toBe(0);
    const byBus = trip(bus, home, spot);
    expect(byBus.minutes).toBeLessThan(byFoot.minutes);
    expect(byBus.fare).toBe(20_000 + Math.floor((5_000 * byBus.metres) / 1000));
    expect(trip(walk, home, home).minutes).toBe(1);
  });
});

describe("panels", () => {
  it("are named by the city's model; references to them are checked", () => {
    const bad = {
      ...sampleCity,
      ui: {
        ...sampleCity.ui,
        map: [{ region: "bottom" as const, widgets: [{ type: "panel" as const, panel: "nope" }] }],
        panels: [
          {
            key: "mobile",
            label: "Mobile",
            icon: "\u{1F4F1}",
            form: "handheld" as const,
            apps: ["ghost"],
          },
        ],
      },
    };
    const issues = cityIssues(bad);
    expect(issues).toContain('device "mobile" has unknown app "ghost"'.replace("device", "panel"));
    expect(issues.some((i) => i.includes('unknown panel "nope"'))).toBe(true);
  });
});

describe("kinds and items", () => {
  it("are read through one view per trait, with each item's overrides", () => {
    const v = viewsOf(sampleCity);
    expect(v.places.map((p) => p.key)).toEqual(["your_flat", "mama_s_spot"]);
    // The kind's hours and footprint, the item's own look and district.
    expect(v.places[1]?.hours).toEqual({ from: 360, to: 1380 });
    expect(v.places[1]?.district).toBe("island");
    expect(v.places[0]?.look?.solids.length).toBe(3);
    expect(v.movers.map((m) => [m.key, m.holds, m.way])).toEqual([
      ["walk", 0, "road"],
      ["bus", 40, "road"],
    ]);
    expect(v.districts.map((d) => d.key)).toEqual(["mainland", "island"]);
    expect(v.water.map((w) => w.key)).toEqual(["the_lagoon"]);
    expect(v.lines.map((l) => [l.key, l.widthM])).toEqual([["bridge_road", 20]]);
    // A mover with a look is also a prop where its items stand (parked buses).
    expect(propsOf(sampleCity).map((p) => [p.key, p.spots.length])).toEqual([["parked_buses", 2]]);
  });

  it("refuses kinds with no traits, overrides a kind can't take, and unbounded attributes", () => {
    const city = {
      ...sampleCity,
      kinds: [...sampleCity.kinds, { ...sampleCity.kinds[0]!, key: "nothing", traits: {} }],
      items: sampleCity.items.map((i) =>
        i.key === "the_lagoon" ? { ...i, traits: { place: { private: true } } } : i,
      ),
    };
    const issues = cityIssues(city);
    expect(issues).toContain('kind "nothing" has no traits');
    expect(issues).toContain('item "the_lagoon" sets place but its kind "lagoon" isn\'t one');
    const attrs = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`a${i}`, i]));
    const many = {
      ...sampleCity,
      kinds: [{ ...sampleCity.kinds[0]!, attrs }, ...sampleCity.kinds.slice(1)],
    };
    expect(CitySpec.safeParse(many).success).toBe(false);
  });
});

describe("tripPacePermille", () => {
  // Two places 20 km apart; walking at 5 km/h and a motorbike at 40.
  const walkKind = sampleCity.kinds.find((k) => k.key === "walk")!;
  const city = {
    kinds: [
      ...sampleCity.kinds.filter((k) => k.key !== "bus"),
      {
        ...walkKind,
        key: "bike",
        traits: { mover: { ...walkKind.traits.mover!, speedKmh: 40 } },
      },
    ],
    items: sampleCity.items.map((i) =>
      i.key === "your_flat"
        ? { ...i, where: { ...i.where, at: [0, 0] as [number, number] } }
        : i.key === "mama_s_spot"
          ? { ...i, where: { ...i.where, at: [20_000, 0] as [number, number] } }
          : i,
    ),
  };
  const [a, b] = placesOf(city) as [
    ReturnType<typeof placesOf>[number],
    ReturnType<typeof placesOf>[number],
  ];
  const [walk, bike] = moversOf(city) as [
    ReturnType<typeof moversOf>[number],
    ReturnType<typeof moversOf>[number],
  ];

  it("caps the slowest trip across the city at the real seconds a world allows", () => {
    const pace = tripPacePermille(city, { ticksPerRealSecond: 10, tripMaxRealSec: 60 });
    expect(pace).toBeLessThan(1000);
    // 60 real seconds at 10 ticks a second: ten city minutes, at most.
    const onFoot = trip(walk, a, b, pace);
    expect(onFoot.minutes).toBeLessThanOrEqual(10);
    // Every mode by the same factor: the motorbike is still faster; fares don't change.
    const ride = trip(bike, a, b, pace);
    expect(ride.minutes).toBeLessThan(onFoot.minutes);
    expect(onFoot.fare).toBe(trip(walk, a, b).fare);
  });

  it("leaves trips as in life when they're short enough, or the world says so", () => {
    expect(tripPacePermille(city, { ticksPerRealSecond: 10, tripMaxRealSec: 0 })).toBe(1000);
    expect(tripPacePermille(city, { ticksPerRealSecond: 60, tripMaxRealSec: 3600 })).toBe(1000);
    // Worlds from before the setting get its default.
    expect(tripPacePermille(city, { ticksPerRealSecond: 10 })).toBeLessThan(1000);
  });

  it("a way around goes only where it says, except the free one, which goes everywhere", () => {
    const fare = { base: 100, perKm: 0 };
    const boat = { serves: ["jetty", "beach"], fare };
    expect(moverServes(boat, "jetty", "beach")).toBe(true);
    expect(moverServes(boat, "market", "beach")).toBe(false);
    expect(moverServes(boat, "jetty", "market")).toBe(false);
    expect(moverServes(boat, null, "beach")).toBe(true);
    expect(moverServes({ serves: [], fare }, "market", "beach")).toBe(true);
    expect(moverServes({ serves: ["jetty"], fare: { base: 0, perKm: 0 } }, "a", "b")).toBe(true);
  });
});
