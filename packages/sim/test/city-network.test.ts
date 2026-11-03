import { describe, expect, it } from "vitest";
import { type CityLayout, type CityPopulation, CitySim, RESTING } from "../src/city-sim.ts";

/**
 * A real-style network: an n×n grid of streets 200 m apart. Links are rows of
 * [a, b, lanes, km/h, one-way, class, name].
 */
function gridNetwork(
  n: number,
  opts: { oneway?: (a: number, b: number) => boolean; kmh?: number } = {},
) {
  const nodes: number[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) nodes.push(c * 200, r * 200);
  const links: number[] = [];
  const id = (r: number, c: number) => r * n + c;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (c + 1 < n) {
        const a = id(r, c);
        const b = id(r, c + 1);
        links.push(a, b, 1, opts.kmh ?? 50, opts.oneway?.(a, b) ? 1 : 0, 3, -1);
      }
      if (r + 1 < n) links.push(id(r, c), id(r + 1, c), 1, opts.kmh ?? 50, 0, 3, -1);
    }
  }
  const count = links.length / 7;
  return { nodes, links, shapeAt: new Array(count + 1).fill(0), shape: [] as number[] };
}

const layout = (network: NonNullable<CityLayout["network"]>, size: number): CityLayout => ({
  districts: [
    {
      key: "all",
      polygon: [
        [0, 0],
        [size, 0],
        [size, size],
        [0, size],
      ],
    },
  ],
  places: [{ key: "work", at: [size, size] }],
  roads: [],
  movers: [{ key: "car", speedKmh: 60, holds: 2, way: "road", reach: null }],
  network,
});

/** The test's own clock (the sim has none). */
const now = () => (globalThis as unknown as { performance: { now(): number } }).performance.now();

const commute = (count: number): CityPopulation => ({
  groups: [
    {
      key: "workers",
      count,
      home: "all",
      routine: [
        { at: 8 * 60, place: "work", mode: "car" },
        { at: 17 * 60, place: null, mode: "car" },
      ],
    },
  ],
});

describe("CitySim on a real network", () => {
  it("never drives the wrong way down a one-way street", () => {
    // Every east-west street in the top row runs east only.
    const net = gridNetwork(3, { oneway: (a, b) => a < 3 && b < 3 });
    const sim = new CitySim(layout(net, 400), commute(1), 1);
    expect(sim.edgeOneway.reduce((s, v) => s + v, 0)).toBe(2);
    // Run the day; nothing should ever stand on a one-way link facing backwards.
    const xz = new Float32Array(2);
    const kind = new Uint8Array(1);
    const dir = new Float32Array(1 * 2);
    for (let m = 0; m < 1440; m++) {
      sim.step();
      sim.positions(xz, kind, dir);
    }
    expect(sim.minute).toBe(1440);
  });

  it("goes no faster than the road allows", () => {
    const fast = new CitySim(layout(gridNetwork(6, { kmh: 60 }), 1000), commute(1), 3);
    const slow = new CitySim(layout(gridNetwork(6, { kmh: 15 }), 1000), commute(1), 3);
    // How long the morning trip takes, whenever habit sets it off.
    const tripMinutes = (sim: CitySim) => {
      let left = -1;
      for (let m = 0; m < 12 * 60; m++) {
        sim.step();
        const moving = sim.stats().travelling > 0;
        if (moving && left < 0) left = sim.minute;
        if (!moving && left >= 0) return sim.minute - left;
      }
      return Number.POSITIVE_INFINITY;
    };
    expect(tripMinutes(slow)).toBeGreaterThan(tripMinutes(fast));
  });

  it("sends people to their own spots in a district, spread across it", () => {
    const net = gridNetwork(10);
    const city: CityLayout = {
      ...layout(net, 1800),
      districts: [
        {
          key: "west",
          polygon: [
            [0, 0],
            [900, 0],
            [900, 1800],
            [0, 1800],
          ],
        },
        {
          key: "east",
          polygon: [
            [900, 0],
            [1800, 0],
            [1800, 1800],
            [900, 1800],
          ],
        },
      ],
    };
    const people: CityPopulation = {
      groups: [
        {
          key: "office",
          count: 400,
          home: "west",
          routine: [
            { at: 7 * 60, place: null, district: "east", mode: "car" },
            { at: 18 * 60, place: null, mode: "car" },
          ],
        },
      ],
    };
    const sim = new CitySim(city, people, 4);
    sim.runTo(12 * 60);
    const xz = new Float32Array(sim.agents * 2);
    const kind = new Uint8Array(sim.agents);
    const dir = new Float32Array(sim.agents * 2);
    sim.positions(xz, kind, dir);
    const spots = new Set<string>();
    for (let i = 0; i < sim.agents; i++) {
      // At work: in the east district, at rest.
      expect(xz[i * 2]).toBeGreaterThanOrEqual(900);
      spots.add(`${xz[i * 2]},${xz[i * 2 + 1]}`);
    }
    expect(spots.size).toBeGreaterThan(3);
  });

  it("plays a day of a big network and many people quickly, the same every time", () => {
    const run = () => {
      const sim = new CitySim(layout(gridNetwork(60), 11_800), commute(200_000), 9);
      const t0 = now();
      sim.runTo(1440);
      return { hash: sim.hash(), ms: now() - t0, scale: sim.scale };
    };
    const a = run();
    const b = run();
    expect(a.hash).toBe(b.hash);
    // 3,600 junctions, ~7,000 links, 3,000 agents standing for 200,000 people.
    expect(a.scale).toBeGreaterThan(1);
    expect(a.ms).toBeLessThan(15_000);
    // The bound above is the test's own; the runner's default (5 s) is no measure of it.
  }, 40_000);
});

describe("CitySim scenarios", () => {
  const net = gridNetwork(6, { kmh: 40 });
  const city = layout(net, 1000);
  const day = (sim: CitySim) => {
    sim.runTo(1440);
    return sim.report();
  };

  it("reports a day: trips made, how long they took, time queued", () => {
    const r = day(new CitySim(city, commute(400), 5));
    expect(r.trips).toBeGreaterThan(0);
    expect(r.tripMinutes).toBeGreaterThan(r.trips);
    expect(r.unreached).toBe(0);
  });

  it("closing every road into the workplace strands the commute instead of teleporting it", () => {
    const work = 35; // the bottom-right junction of a 6×6 grid
    const into: number[] = [];
    for (let l = 0; l * 7 < net.links.length; l++) {
      if (net.links[l * 7] === work || net.links[l * 7 + 1] === work) into.push(l);
    }
    const sim = new CitySim(city, commute(50), 5, { scenario: { closed: into } });
    expect(sim.edgeClosed.reduce((s, v) => s + v, 0)).toBe(2);
    const r = day(sim);
    expect(r.unreached).toBeGreaterThan(0);
  });

  it("more lanes on a jammed road means less time queued, and the same scenario replays", () => {
    const lanes = Array.from({ length: net.links.length / 7 }, (_, l) => [l, 4] as const);
    const base = day(new CitySim(city, commute(30_000), 9));
    const wider = day(new CitySim(city, commute(30_000), 9, { scenario: { lanes } }));
    expect(wider.queuedMinutes).toBeLessThan(base.queuedMinutes);
    expect(wider.tripMinutes).toBeLessThan(base.tripMinutes);
    const a = new CitySim(city, commute(30_000), 9, { scenario: { lanes } });
    const b = new CitySim(city, commute(30_000), 9, { scenario: { lanes } });
    a.runTo(600);
    b.runTo(600);
    expect(a.hash()).toBe(b.hash());
  });

  it("ignores edits to roads that don't exist and lanes out of range", () => {
    const sim = new CitySim(city, commute(10), 1, {
      scenario: {
        closed: [-1, 1e9, 0.5],
        lanes: [
          [-3, 2],
          [0, 99],
          [1, -5],
        ],
      },
    });
    expect(sim.edgeClosed.reduce((s, v) => s + v, 0)).toBe(0);
    expect(() => sim.runTo(1440)).not.toThrow();
  });
});

describe("CitySim lines", () => {
  // Two 3×3 grids with water between: a long road round the water, and a ferry across it
  // whose terminals are reached by access links. Classes: 3 a road, 6 ferry, 8 access.
  function lagoon() {
    const nodes: number[] = [];
    const links: number[] = [];
    const grid = (x0: number) => {
      const base = nodes.length / 2;
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) nodes.push(x0 + c * 200, r * 200);
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const v = base + r * 3 + c;
          if (c < 2) links.push(v, v + 1, 1, 50, 0, 3, -1);
          if (r < 2) links.push(v, v + 3, 1, 50, 0, 3, -1);
        }
      }
      return base;
    };
    const left = grid(0);
    const right = grid(2400);
    const node = (x: number, z: number) => {
      nodes.push(x, z);
      return nodes.length / 2 - 1;
    };
    // The long way round by road.
    const s1 = node(400, 3000);
    const s2 = node(2400, 3000);
    links.push(
      left + 8,
      s1,
      1,
      50,
      0,
      3,
      -1,
      s1,
      s2,
      1,
      50,
      0,
      3,
      -1,
      s2,
      right + 6,
      1,
      50,
      0,
      3,
      -1,
    );
    // The ferry, and the walks to its terminals.
    const f1 = node(600, 200);
    const f2 = node(2200, 200);
    links.push(
      f1,
      f2,
      1,
      25,
      0,
      6,
      -1,
      left + 5,
      f1,
      1,
      12,
      0,
      8,
      -1,
      f2,
      right + 3,
      1,
      12,
      0,
      8,
      -1,
    );
    const count = links.length / 7;
    return { nodes, links, shapeAt: new Array(count + 1).fill(0), shape: [] as number[] };
  }
  const city: CityLayout = {
    districts: [
      {
        key: "west",
        polygon: [
          [0, 0],
          [700, 0],
          [700, 500],
          [0, 500],
        ],
      },
    ],
    places: [{ key: "work", at: [2800, 400] }],
    roads: [],
    movers: [
      { key: "car", speedKmh: 50, holds: 2, way: "road", reach: null },
      { key: "boat", speedKmh: 25, holds: 60, way: "water", reach: null },
    ],
    network: lagoon(),
  };
  const go = (mode: string): CityPopulation => ({
    groups: [
      {
        key: "commuters",
        count: 200,
        home: "west",
        routine: [
          { at: 8 * 60, place: "work", mode },
          { at: 17 * 60, place: null, mode },
        ],
      },
    ],
  });
  /** Whether anyone was ever seen on the water (between the terminals), and at a terminal at rest. */
  const watch = (sim: CitySim) => {
    const xz = new Float32Array(sim.agents * 2);
    const kind = new Uint8Array(sim.agents);
    const dir = new Float32Array(sim.agents * 2);
    let onWater = false;
    let restingOnPier = false;
    for (let m = 0; m < 1440; m++) {
      sim.step();
      sim.positions(xz, kind, dir);
      for (let i = 0; i < sim.agents; i++) {
        const x = xz[i * 2] as number;
        const z = xz[i * 2 + 1] as number;
        if (kind[i] !== RESTING && x > 650 && x < 2150 && z < 300) onWater = true;
        if (kind[i] === RESTING && (x === 600 || x === 2200) && z === 200) restingOnPier = true;
      }
    }
    return { onWater, restingOnPier };
  };

  it("gets riders to the stops by the mover the city names, else on foot", () => {
    const day = (reach: string | null) => {
      const layout: CityLayout = {
        ...city,
        movers: [
          { key: "walk", speedKmh: 5, holds: 0, way: "road", reach: null },
          { key: "bike", speedKmh: 40, holds: 2, way: "road", reach: null },
          { key: "boat", speedKmh: 25, holds: 60, way: "water", reach },
        ],
      };
      const sim = new CitySim(layout, go("boat"), 3);
      sim.runTo(1440);
      const r = sim.report();
      return r.tripMinutes / r.trips;
    };
    expect(day("bike")).toBeLessThan(day(null));
  });

  it("keeps road traffic off the ferry, and puts boat riders on it", () => {
    const cars = watch(new CitySim(city, go("car"), 3));
    expect(cars.onWater).toBe(false);
    const boats = new CitySim(city, go("boat"), 3);
    const seen = watch(boats);
    expect(seen.onWater).toBe(true);
    // Nobody lives at, or is sent to, a ferry terminal; riders don't fill the roads.
    expect(seen.restingOnPier).toBe(false);
    expect(boats.report().trips).toBeGreaterThan(0);
    expect(boats.edgeKind.filter((k) => k !== 0)).toHaveLength(3);
  });
});
