import { MemoryArtifactStore, MemoryRecipeIndex } from "@aye/artifacts";
import {
  type CitySpec,
  districtsOf,
  LAND_KINDS,
  landIssues,
  linesOf,
  networkIssues,
  placesOf,
  propsOf,
  ROAD_CLASSES,
  waterOf,
} from "@aye/schema";
import { sampleCity } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import {
  addLines,
  areaOf,
  buildLand,
  buildNetwork,
  groundCity,
  inWater,
  LandAnswer,
  type Locator,
  type MapSource,
  misplacedPlaces,
  OverpassAnswer,
  regionsAround,
  seaRings,
} from "../src/index.ts";

// A 5×5 grid of streets 0.002° apart (~220 m) around 6.45 N, 3.39 E (Lagos Island).
function overpassGrid() {
  const elements: unknown[] = [];
  const id = (r: number, c: number) => 1000 + r * 5 + c;
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      elements.push({ type: "node", id: id(r, c), lat: 6.45 + r * 0.002, lon: 3.39 + c * 0.002 });
    }
  }
  let way = 1;
  for (let r = 0; r < 5; r++) {
    elements.push({
      type: "way",
      id: way++,
      nodes: [0, 1, 2, 3, 4].map((c) => id(r, c)),
      tags: {
        highway: r === 2 ? "primary" : "tertiary",
        name: `Street ${r}`,
        ...(r === 0 ? { oneway: "yes" } : {}),
      },
    });
  }
  for (let c = 0; c < 5; c++) {
    elements.push({
      type: "way",
      id: way++,
      nodes: [0, 1, 2, 3, 4].map((r) => id(r, c)),
      tags: { highway: "secondary", maxspeed: "30 mph", lanes: "4" },
    });
  }
  // A footpath (not a road for traffic) and a road off on its own (not connected).
  elements.push({ type: "way", id: 99, nodes: [id(0, 0), id(4, 4)], tags: { highway: "footway" } });
  elements.push({ type: "node", id: 5000, lat: 6.47, lon: 3.42 });
  elements.push({ type: "node", id: 5001, lat: 6.471, lon: 3.421 });
  elements.push({ type: "way", id: 98, nodes: [5000, 5001], tags: { highway: "tertiary" } });
  // A one-way spur out of the grid with no way back: a trap, not part of the network.
  elements.push({ type: "node", id: 6000, lat: 6.459, lon: 3.399 });
  elements.push({
    type: "way",
    id: 97,
    nodes: [id(4, 4), 6000],
    tags: { highway: "tertiary", oneway: "yes" },
  });
  return { version: 0.6, elements };
}

const box = { south: 6.448, west: 3.388, north: 6.46, east: 3.4 };

const square = (lat: number, lon: number, d: number) => [
  { lat, lon },
  { lat, lon: lon + d },
  { lat: lat + d, lon: lon + d },
  { lat: lat + d, lon },
  { lat, lon },
];
/** A coast across the south (the sea below it), a lake, a park with a hole, a tiny pond. */
function overpassLand() {
  return {
    elements: [
      // The coastline runs east (water on its right: the south), in two ways.
      {
        type: "way",
        id: 11,
        tags: { natural: "coastline" },
        geometry: [
          { lat: 6.445, lon: 3.3 },
          { lat: 6.445, lon: 3.39 },
        ],
      },
      {
        type: "way",
        id: 12,
        tags: { natural: "coastline" },
        geometry: [
          { lat: 6.445, lon: 3.39 },
          { lat: 6.445, lon: 3.5 },
        ],
      },
      { type: "way", id: 20, tags: { natural: "water" }, geometry: square(6.452, 3.385, 0.002) },
      { type: "way", id: 21, tags: { natural: "water" }, geometry: square(6.45, 3.381, 0.0001) },
      { type: "way", id: 22, tags: { amenity: "school" }, geometry: square(6.45, 3.39, 0.002) },
      {
        type: "relation",
        id: 30,
        tags: { type: "multipolygon", leisure: "park" },
        members: [
          // The outer ring in two halves, one of them backwards.
          { type: "way", role: "outer", geometry: square(6.455, 3.39, 0.004).slice(0, 3) },
          { type: "way", role: "outer", geometry: square(6.455, 3.39, 0.004).slice(2).reverse() },
          { type: "way", role: "inner", geometry: square(6.456, 3.391, 0.001) },
        ],
      },
    ],
  };
}
/** A ferry across the grid, a light railway with a station beside it, and a line too far away. */
function overpassLines() {
  return {
    elements: [
      { type: "node", id: 7001, lat: 6.4502, lon: 3.3898 },
      { type: "node", id: 7002, lat: 6.4581, lon: 3.3982 },
      { type: "way", id: 70, nodes: [7001, 7002], tags: { route: "ferry", name: "Ferry" } },
      { type: "node", id: 7101, lat: 6.451, lon: 3.3905 },
      { type: "node", id: 7102, lat: 6.454, lon: 3.3905 },
      { type: "node", id: 7103, lat: 6.457, lon: 3.3905 },
      { type: "node", id: 7110, lat: 6.4541, lon: 3.3907, tags: { railway: "station" } },
      { type: "node", id: 7111, lat: 6.457, lon: 3.3905 },
      { type: "way", id: 71, nodes: [7101, 7102, 7103], tags: { railway: "light_rail" } },
      // Far off, with a station but no road within reach.
      { type: "node", id: 7201, lat: 6.6, lon: 3.6, tags: { railway: "station" } },
      { type: "node", id: 7202, lat: 6.61, lon: 3.6 },
      { type: "way", id: 72, nodes: [7201, 7202], tags: { railway: "rail" } },
    ],
  };
}

const landBox = { south: 6.44, west: 3.38, north: 6.46, east: 3.4 };

describe("buildNetwork", () => {
  it("makes junction-to-junction links with real lanes, speeds and one-ways", () => {
    const net = buildNetwork(OverpassAnswer.parse(overpassGrid()), box);
    expect(net).not.toBeNull();
    expect(networkIssues(net!)).toEqual([]);
    // 25 junctions; 5 streets × 4 links + 5 avenues × 4 links; the loner, the one-way trap
    // and the footway gone.
    expect(net!.nodes.length / 2).toBe(25);
    expect(net!.links.length / 7).toBe(40);
    const rows = Array.from({ length: 40 }, (_, l) => net!.links.slice(l * 7, l * 7 + 7));
    // "4" lanes both ways → 2 each way; 30 mph → 48 km/h.
    expect(rows.some((r) => r[2] === 2 && r[3] === 48)).toBe(true);
    expect(rows.filter((r) => r[4] === 1)).toHaveLength(4);
    expect(net!.names).toContain("Street 2");
    expect(net!.attribution).toMatch(/OpenStreetMap/);
  });

  it("is deterministic and refuses answers that aren't Overpass", () => {
    const a = buildNetwork(OverpassAnswer.parse(overpassGrid()), box);
    const b = buildNetwork(OverpassAnswer.parse(overpassGrid()), box);
    expect(a).toEqual(b);
    expect(OverpassAnswer.safeParse({ elements: [{ type: "way", id: -1 }] }).success).toBe(false);
  });
});

describe("addLines", () => {
  it("joins ferries and railways to the roads at their stops, and drops what it can't reach", () => {
    const roads = buildNetwork(OverpassAnswer.parse(overpassGrid()), box)!;
    const net = addLines(roads, OverpassAnswer.parse(overpassLines()), box);
    expect(networkIssues(net)).toEqual([]);
    const rows = Array.from({ length: net.links.length / 7 }, (_, l) =>
      net.links.slice(l * 7, l * 7 + 7),
    );
    const cls = (c: string) => rows.filter((r) => r[5] === ROAD_CLASSES.indexOf(c as never));
    expect(cls("ferry")).toHaveLength(1);
    // The track splits at its station (snapped from beside it): two pieces.
    expect(cls("rail")).toHaveLength(2);
    // Two ferry terminals and one station, each walked to from a road junction.
    expect(cls("access")).toHaveLength(3);
    for (const r of cls("access")) expect(r[0]).toBeLessThan(roads.nodes.length / 2);
    // The roads are as they were, first.
    expect(net.links.slice(0, roads.links.length)).toEqual(roads.links);
    expect(addLines(roads, OverpassAnswer.parse(overpassLines()), box)).toEqual(net);
  });
});

describe("buildLand", () => {
  const extent: [number, number] = [2_208, 2_211];

  it("draws the sea from its coastline, lakes, and parks with their holes", () => {
    const land = buildLand(LandAnswer.parse(overpassLand()), landBox, extent);
    expect(landIssues(land)).toEqual([]);
    const kinds = land.kinds.map((k) => LAND_KINDS[k]);
    // The park and its hole; then the sea and the lake. The pond is too small, the school
    // isn't ground cover.
    expect(kinds).toEqual(["green", "green", "water", "water"]);
    expect(land.holes).toEqual([0, 1, 0, 0]);
    // The sea is everything south of 6.445: about 2.2 km × 0.55 km.
    const ring = (r: number) => {
      const out: [number, number][] = [];
      for (let k = land.ringAt[r]!; k < land.ringAt[r + 1]!; k++) {
        out.push([land.points[k * 2]!, land.points[k * 2 + 1]!]);
      }
      return out;
    };
    expect(areaOf(ring(2))).toBeGreaterThan(1_100_000);
    expect(areaOf(ring(2))).toBeLessThan(1_350_000);
    expect(ring(2).every(([, z]) => z >= 1_600)).toBe(true);
    expect(buildLand(LandAnswer.parse(overpassLand()), landBox, extent)).toEqual(land);
  });

  it("closes the sea on the water's side, whichever way the coast runs", () => {
    const east = seaRings(
      [
        [
          [0, 500],
          [1000, 500],
        ],
      ],
      1000,
      1000,
    );
    expect(east[0]).toContainEqual([1000, 1000]);
    expect(east[0]).not.toContainEqual([0, 0]);
    const west = seaRings(
      [
        [
          [1000, 500],
          [0, 500],
        ],
      ],
      1000,
      1000,
    );
    expect(west[0]).toContainEqual([0, 0]);
    expect(areaOf(west[0]!)).toBe(500_000);
  });

  it("refuses answers that aren't Overpass", () => {
    expect(LandAnswer.safeParse({ elements: [{ type: "way", id: "x" }] }).success).toBe(false);
  });
});

describe("misplacedPlaces", () => {
  const where = {
    real: true,
    city: { lat: 51.5, lon: -0.1 },
    districts: [
      { key: "brixton", lat: 51.46, lon: -0.11 },
      { key: "hackney", lat: 51.55, lon: -0.06 },
    ],
    places: [
      { key: "shop", lat: 51.462, lon: -0.112 },
      { key: "pub", lat: 51.463, lon: -0.11 },
      { key: "edge", lat: 51.505, lon: -0.085 },
    ],
  };

  it("names a place clearly nearer another district, not one on the boundary", () => {
    expect(
      misplacedPlaces(where, [
        { key: "shop", district: "hackney" },
        { key: "pub", district: "brixton" },
        { key: "edge", district: "hackney" },
      ]),
    ).toEqual([{ place: "shop", district: "hackney", nearest: "brixton" }]);
  });

  it("can't judge a place whose district it wasn't told about", () => {
    expect(misplacedPlaces(where, [{ key: "shop", district: "unknown" }])).toEqual([]);
  });
});

describe("regionsAround", () => {
  it("splits the map between centres, each region holding its own centre", () => {
    const regions = regionsAround(
      [
        [100, 100],
        [900, 100],
        [500, 900],
      ],
      [1000, 1000],
    );
    expect(regions).toHaveLength(3);
    for (const r of regions) expect(r.length).toBeGreaterThanOrEqual(3);
  });
});

describe("groundCity", () => {
  // The sample city, with its bus running on the water (so its ferries are fetched too).
  const city: CitySpec = {
    ...sampleCity,
    kinds: sampleCity.kinds.map((k) =>
      k.key === "bus" && k.traits.mover
        ? { ...k, traits: { ...k.traits, mover: { ...k.traits.mover, way: "water" as const } } }
        : k,
    ),
  };
  const where = (real: boolean) => ({
    real,
    city: { lat: 6.454, lon: 3.394 },
    places: [
      ...placesOf(sampleCity).map((p, i) => ({
        key: p.key,
        lat: 6.451 + i * 0.004,
        lon: 3.391 + i * 0.004,
      })),
      { key: "nowhere", lat: 7.5, lon: 3.39 },
    ],
    districts: districtsOf(sampleCity).map((d, i) => ({
      key: d.key,
      lat: 6.452 + i * 0.004,
      lon: 3.393,
    })),
  });
  const providers = (real: boolean, wet = false) => {
    const calls = { locate: 0, fetch: 0 };
    const locator: Locator = {
      model: { provider: "test", model: "locator", version: "1" },
      prompt: "locate",
      effort: "low",
      async locate() {
        calls.locate++;
        const w = where(real);
        // A place put a little out to sea (south of the coast at 6.445).
        if (wet) w.places[1] = { ...w.places[1]!, lat: 6.441 };
        return w;
      },
    };
    const maps: MapSource = {
      ref: { provider: "test", model: "osm", version: "1" },
      async fetch(query) {
        calls.fetch++;
        const answer = query.includes("coastline")
          ? overpassLand()
          : query.includes("ferry")
            ? overpassLines()
            : overpassGrid();
        return new TextEncoder().encode(JSON.stringify(answer));
      },
    };
    return { locator, maps, calls };
  };

  it("lays a real city on its real roads, at true scale", async () => {
    const { locator, maps } = providers(true);
    const r = await groundCity(city, {
      locator,
      maps,
      store: new MemoryArtifactStore(),
      index: new MemoryRecipeIndex(),
    });
    const spec: CitySpec = r.spec;
    expect(spec.real?.network).toBe(r.networkRef?.hash);
    // And what covers its ground.
    expect(spec.real?.land).toBe(r.landRef?.hash);
    expect(r.land?.kinds.length).toBeGreaterThan(0);
    // The sketch's roads and water give way to the real network and land cover.
    expect(linesOf(spec)).toEqual([]);
    expect(waterOf(spec)).toEqual([]);
    // The two places sit ~630 m apart diagonally, as they really are.
    const [a, b] = placesOf(spec).map((p) => p.at);
    const metres = Math.hypot(a![0] - b![0], a![1] - b![1]);
    expect(metres).toBeGreaterThan(500);
    expect(metres).toBeLessThan(800);
    // East is +x, south is +z.
    expect(b![0]).toBeGreaterThan(a![0]);
    expect(b![1]).toBeLessThan(a![1]);
    // A way to get around on the water, and the ferry it rides, joined to the roads.
    expect(r.network!.links.filter((_, k) => k % 7 === 5)).toContain(ROAD_CLASSES.indexOf("ferry"));
    // Every district is a region of the map; props have no true spot, so stand nowhere.
    expect(districtsOf(spec).every((d) => d.polygon.length >= 3)).toBe(true);
    expect(propsOf(spec)).toEqual([]);
  });

  it("leaves a made-up city sketched, and replays with no call or fetch", async () => {
    const { locator, maps, calls } = providers(false);
    const store = new MemoryArtifactStore();
    const index = new MemoryRecipeIndex();
    const r = await groundCity(city, { locator, maps, store, index });
    expect(r.spec).toBe(city);
    expect(calls.fetch).toBe(0);
    const real = providers(true);
    const deps = { locator: real.locator, maps: real.maps, store, index: new MemoryRecipeIndex() };
    await groundCity(city, deps);
    await groundCity(city, deps);
    expect(real.calls).toEqual({ locate: 1, fetch: 3 });
  });

  it("moves a place a model put in the water onto land, at the nearest road", async () => {
    const { locator, maps } = providers(true, true);
    const r = await groundCity(city, {
      locator,
      maps,
      store: new MemoryArtifactStore(),
      index: new MemoryRecipeIndex(),
    });
    const moved = placesOf(r.spec)[1]!;
    expect(r.issues.some((i) => i.includes("was in the water"))).toBe(true);
    expect(inWater(r.land!, moved.at)).toBe(false);
    // It stands on a junction of the network.
    const nodes = r.network!.nodes;
    const onNode = Array.from({ length: nodes.length / 2 }, (_, v) => v).some(
      (v) => nodes[v * 2] === moved.at[0] && nodes[v * 2 + 1] === moved.at[1],
    );
    expect(onNode).toBe(true);
  });
});
