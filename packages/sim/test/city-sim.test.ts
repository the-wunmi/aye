/** City life on sketched roads: the road graph, people's days and the traffic they make. */
import { describe, expect, it } from "vitest";
import { buildRoadGraph, type CityLayout, type CityPopulation, CitySim } from "../src/city-sim.ts";

/** A small grid town: three roads each way, a home district west, work east. */
const grid: CityLayout = {
  districts: [
    {
      key: "west",
      polygon: [
        [0, 0],
        [1000, 0],
        [1000, 3000],
        [0, 3000],
      ],
    },
    {
      key: "east",
      polygon: [
        [2000, 0],
        [3000, 0],
        [3000, 3000],
        [2000, 3000],
      ],
    },
  ],
  places: [
    { key: "office", at: [2500, 1500] },
    { key: "market", at: [1500, 500] },
  ],
  roads: [
    ...[500, 1500, 2500].map((z) => ({
      widthM: 9,
      points: [
        [0, z],
        [3000, z],
      ] as [number, number][],
    })),
    ...[500, 1500, 2500].map((x) => ({
      widthM: 9,
      points: [
        [x, 0],
        [x, 3000],
      ] as [number, number][],
    })),
  ],
  movers: [
    { key: "walk", speedKmh: 5, holds: 0, way: "road", reach: null },
    { key: "car", speedKmh: 40, holds: 2, way: "road", reach: null },
  ],
};
const commuters = (count: number, mode = "car"): CityPopulation => ({
  groups: [
    {
      key: "workers",
      count,
      home: "west",
      routine: [
        { at: 7 * 60, place: "office", mode },
        { at: 17 * 60, place: null, mode },
      ],
    },
  ],
});

describe("buildRoadGraph", () => {
  it("joins roads where they cross", () => {
    const g = buildRoadGraph(grid.roads);
    // 3×3 crossings plus 12 road ends; each road split into 4 pieces.
    expect(g.x.length).toBe(9 + 12);
    expect(g.a.length).toBe(6 * 4);
  });

  it("joins a road that stops just short of another (a T-junction)", () => {
    const g = buildRoadGraph([
      {
        widthM: 8,
        points: [
          [0, 0],
          [1000, 0],
        ],
      },
      {
        widthM: 8,
        points: [
          [500, 30],
          [500, 800],
        ],
      },
    ]);
    const near = [...g.x.keys()].filter((v) => g.x[v] === 500 && Math.abs((g.z[v] ?? 0) - 0) <= 40);
    expect(near.length).toBe(1);
  });
});

describe("CitySim", () => {
  it("is deterministic: same city, people and seed, same day", () => {
    const a = new CitySim(grid, commuters(800), 42);
    const b = new CitySim(grid, commuters(800), 42);
    a.runTo(1440);
    for (let i = 0; i < 1440; i++) b.step();
    expect(a.hash()).toBe(b.hash());
    const c = new CitySim(grid, commuters(800), 43);
    c.runTo(1440);
    expect(c.hash()).not.toBe(a.hash());
  });

  it("goes to work in the morning and home in the evening", () => {
    const sim = new CitySim(grid, commuters(200), 1);
    sim.runTo(6 * 60);
    expect(sim.stats().travelling).toBe(0);
    sim.runTo(7 * 60 + 10);
    expect(sim.stats().onRoads).toBeGreaterThan(0);
    sim.runTo(12 * 60);
    expect(sim.stats().travelling).toBe(0);
    const xz = new Float32Array(sim.agents * 2);
    const kind = new Uint8Array(sim.agents);
    const dir = new Float32Array(sim.agents * 2);
    sim.positions(xz, kind, dir);
    // Everyone is at the office's nearest junction (east side).
    for (let i = 0; i < sim.agents; i++) expect(xz[i * 2]).toBeGreaterThan(2000);
    sim.runTo(23 * 60);
    sim.positions(xz, kind, dir);
    for (let i = 0; i < sim.agents; i++) expect(xz[i * 2]).toBeLessThan(1000 + 1);
  });

  it("holds traffic up in queues as roads fill, but not people on foot", () => {
    const busy = (n: number, mode: string) => {
      const sim = new CitySim(grid, commuters(n, mode), 5);
      let worst = 1000;
      for (let m = 0; m < 9 * 60; m++) {
        sim.step();
        worst = Math.min(worst, sim.stats().flowPermille);
      }
      return { worst, peak: sim };
    };
    expect(busy(50, "car").worst).toBeGreaterThan(950);
    // flowPermille: the share of road travellers moving (not waiting in a queue).
    expect(busy(20_000, "car").worst).toBeLessThan(900);
    expect(busy(20_000, "walk").worst).toBe(1000);
  });

  it("fills a road only to what it holds, bar the few stuck long enough to squeeze on", () => {
    const sim = new CitySim(grid, commuters(40_000), 9);
    let checks = 0;
    let over = 0;
    for (let m = 0; m < 10 * 60; m++) {
      sim.step();
      for (let e = 0; e < sim.load.length; e++) {
        checks++;
        const cap = Math.max(sim.edgeCap[e] as number, sim.scale);
        if ((sim.load[e] as number) > cap) over++;
      }
    }
    expect(over / checks).toBeLessThan(0.05);
  });

  it("never locks: a town with far more traffic than roads still clears by the small hours", () => {
    const people = 200_000;
    const sim = new CitySim(grid, commuters(people), 9);
    let busiest = 0;
    for (let m = 0; m < 1439; m++) {
      sim.step();
      busiest = Math.max(busiest, sim.stats().onRoads);
    }
    expect(busiest).toBeGreaterThan(people / 2);
    expect(sim.stats().onRoads).toBeLessThan(people / 10);
    expect(sim.report().trips).toBeGreaterThan(people);
  });

  it("stands fewer agents for a big city, each counting for several people", () => {
    const sim = new CitySim(grid, commuters(30_000), 1);
    expect(sim.agents).toBeLessThanOrEqual(3_000);
    expect(sim.scale * sim.agents).toBeGreaterThanOrEqual(30_000);
  });
});
