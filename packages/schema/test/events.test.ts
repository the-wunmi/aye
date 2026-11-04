/** City events: what they change while they last, how they're checked, and the city's clock. */
import { describe, expect, it } from "vitest";
import { sampleCity } from "../src/fixtures.ts";
import {
  type CityEvent,
  CitySpec,
  cityMinuteNow,
  eventIssues,
  moverNow,
  moversOf,
  placeOpen,
  placesOf,
} from "../src/index.ts";

const day2 = 1440;
const event = (over: Partial<CityEvent>): CityEvent => ({
  key: "strike",
  name: "Bus strike",
  about: "Drivers want better pay.",
  icon: "\u{1F6A7}",
  from: day2 + 600,
  to: day2 + 900,
  effects: [{ type: "halted", mover: "bus" }],
  ...over,
});

describe("city events", () => {
  const [, spot] = placesOf(sampleCity);
  const [walk, bus] = moversOf(sampleCity);
  if (!spot || !walk || !bus) throw new Error("fixture");

  it("halt, slow and reprice ways to get around only while they last", () => {
    const events = [
      event({}),
      event({
        key: "fuel",
        name: "Fuel queue",
        from: day2 + 300,
        to: day2 + 1200,
        effects: [
          { type: "slowed", mover: "bus", permille: 500 },
          { type: "fare", mover: "bus", permille: 2000 },
        ],
      }),
    ];
    expect(moverNow(bus, events, day2 + 700).running).toBe(false);
    const queued = moverNow(bus, events, day2 + 400);
    expect(queued).toEqual({
      running: true,
      speedKmh: 12,
      fare: { base: 40_000, perKm: 10_000 },
    });
    // Before and after, as it always is (within its own hours).
    expect(moverNow(bus, events, day2 + 1250)).toEqual({
      running: true,
      speedKmh: 25,
      fare: { base: 20_000, perKm: 5_000 },
    });
    expect(moverNow(walk, events, day2 + 700).running).toBe(true);
  });

  it("close a place over its hours, and not otherwise", () => {
    const shut = [event({ effects: [{ type: "closed", place: spot.key }] })];
    expect(placeOpen(spot, shut, day2 + 700)).toBe(false);
    expect(placeOpen(spot, shut, day2 + 950)).toBe(true);
    // Its own hours still hold: closed before 06:00.
    expect(placeOpen(spot, [], day2 + 120)).toBe(false);
  });

  it("are checked: real targets, sane windows, bounded effects", () => {
    const bad = [
      event({ key: "a", effects: [{ type: "closed", place: "nowhere" }] }),
      event({ key: "a", to: day2 + 100 }),
      event({ key: "b", effects: [{ type: "fare", mover: "teleporter", permille: 900 }] }),
    ];
    const issues = eventIssues(bad, { places: placesOf(sampleCity), movers: moversOf(sampleCity) });
    expect(issues).toContain('event "a" closes "nowhere", which isn\'t a place');
    expect(issues).toContain('event "a" is defined twice');
    expect(issues).toContain('event "a" ends before it starts');
    expect(issues.some((i) => i.includes('"teleporter"'))).toBe(true);
    // A fare can't be made 100 times dearer, and a city with broken events doesn't parse.
    const steep = event({ effects: [{ type: "fare", mover: "bus", permille: 100_000 }] });
    expect(CitySpec.safeParse({ ...sampleCity, events: [steep] }).success).toBe(false);
    expect(CitySpec.safeParse({ ...sampleCity, events: bad }).success).toBe(false);
  });

  it("run on the city's clock", () => {
    const settings = { startMinuteOfDay: 420, ticksPerRealSecond: 10 };
    const t0 = Date.parse("2026-11-01T00:00:00Z");
    expect(cityMinuteNow("2026-11-01T00:00:00Z", settings, t0)).toBe(420);
    // One real minute: ten city minutes.
    expect(cityMinuteNow("2026-11-01T00:00:00Z", settings, t0 + 60_000)).toBe(430);
  });
});
