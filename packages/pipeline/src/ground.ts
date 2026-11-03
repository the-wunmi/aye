/**
 * Grounding a city in the real world: a real city (Lagos, Accra) is laid on its
 * real roads, at true scale, so its life can be read like a real one's.
 *
 *   locate  a model says where the city, its places and its districts really are (lat/lon).
 *           Untrusted: bounded, and anything over MAX_KM from the centre is dropped.
 *   roads   OpenStreetMap's main roads for the box around them (Overpass), stored as fetched:
 *           the map is frozen at its first fetch, so replays are byte for byte.
 *   land    OpenStreetMap's water and land use for the same box (`buildLand`), frozen the
 *           same way; a map without it still works (just its roads on plain ground).
 *   lines   its ferry routes and passenger railways, if any way to get around uses them,
 *           joined to the roads at their stops (`addLines`); frozen the same way.
 *   build   code: the network (`buildNetwork`), each place where it really is, districts as
 *           the regions nearest their real centres. Sketched roads, water and scenery go (the
 *           network and the places are the map now).
 *
 * Every step is a memoised stage: a replay makes no model call and no fetch.
 */
import type { ArtifactStore, RecipeIndex } from "@aye/artifacts";
import {
  type ArtifactRef,
  CITY_BOUNDS,
  type CitySpec,
  CitySpec as CitySpecSchema,
  districtsOf,
  KIND_BOUNDS,
  LAND_KINDS,
  LAST_ROAD_CLASS,
  type LandCover,
  type ModelRef,
  moversOf,
  placesOf,
  type RoadNetwork,
  RoadNetwork as RoadNetworkSchema,
  type StageRecord,
} from "@aye/schema";
import { z } from "zod";
import { buildLand, LandAnswer, landQuery } from "./land.ts";
import {
  addLines,
  buildNetwork,
  type GeoBox,
  linesQuery,
  OverpassAnswer,
  overpassQuery,
  projectOnto,
} from "./osm.ts";
import type { ProviderContext } from "./providers.ts";
import { json, readJson, runStage, type StageDeps } from "./stage.ts";

/** Bump when what grounding sends, accepts or how it builds the city changes. */
export const GROUND_VERSION = 4;
/** Bump when what the lines stage asks for changes. */
export const LINES_VERSION = 1;
/** Bump when what the land stage asks for or how it builds the cover changes. */
export const LAND_VERSION = 1;

/** Nothing of a city is further than this from its centre (a metro area, not a country). */
const MAX_KM = 30;
/** A place is only misplaced when it's clearly nearer another district, not on a boundary. */
const MISPLACED_RATIO = 1.5;

/** Room around the places, so the roads between and around them are there too. */
const MARGIN_KM = 2;

const Lat = z.number().min(-85).max(85);
const Lon = z.number().min(-180).max(180);
export const Located = z.strictObject({
  /** Whether this is a real place on Earth (else it stays sketched). */
  real: z.boolean(),
  city: z.strictObject({ lat: Lat, lon: Lon }),
  places: z.array(z.strictObject({ key: z.string().max(64), lat: Lat, lon: Lon })).max(64),
  districts: z.array(z.strictObject({ key: z.string().max(64), lat: Lat, lon: Lon })).max(24),
});
export type Located = z.infer<typeof Located>;

export interface LocateRequest {
  city: { name: string; tagline: string };
  places: { key: string; name: string; blurb: string; district: string }[];
  districts: { key: string; name: string }[];
  /** Places an earlier answer put nearer another district than their own, by key. */
  misplaced?: { place: string; district: string; nearest: string }[];
}

/** The places an answer put clearly nearer another district's centre than their own. */
export function misplacedPlaces(
  where: Located,
  places: readonly { key: string; district: string }[],
): { place: string; district: string; nearest: string }[] {
  const out: { place: string; district: string; nearest: string }[] = [];
  for (const place of places) {
    const at = where.places.find((p) => p.key === place.key);
    const own = where.districts.find((d) => d.key === place.district);
    if (!at || !own) continue;
    const ownKm = kmBetween(at, own);
    let nearest = own;
    let nearestKm = ownKm;
    for (const d of where.districts) {
      const km = kmBetween(at, d);
      if (km < nearestKm) {
        nearest = d;
        nearestKm = km;
      }
    }
    if (nearest !== own && ownKm > nearestKm * MISPLACED_RATIO) {
      out.push({ place: place.key, district: place.district, nearest: nearest.key });
    }
  }
  return out;
}

/** Knows where real places are (a model). */
export interface Locator {
  readonly model: ModelRef;
  readonly prompt: string;
  readonly effort: string;
  locate(request: LocateRequest, ctx: ProviderContext): Promise<unknown>;
}

/** Fetches OpenStreetMap data for an Overpass query (server-side: it reaches the internet). */
export interface MapSource {
  /** Which data this is (what the fetched answer depends on), for recipes. */
  readonly ref: ModelRef;
  fetch(query: string, signal: AbortSignal): Promise<Uint8Array>;
}

export interface GroundDeps {
  locator: Locator;
  maps: MapSource;
  store: ArtifactStore;
  index: RecipeIndex;
  signal?: AbortSignal;
  onStage?: StageDeps["onStage"];
}

export interface GroundResult {
  /** The city laid on its real roads, or as it was if it isn't a real place. */
  spec: CitySpec;
  network: RoadNetwork | null;
  networkRef: ArtifactRef | null;
  land: LandCover | null;
  landRef: ArtifactRef | null;
  issues: string[];
  stages: StageRecord[];
  cached: number;
}

const KM_LAT = 110.574;
const kmLon = (lat: number) => 111.32 * Math.cos((lat * Math.PI) / 180);
const kmBetween = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.hypot((a.lat - b.lat) * KM_LAT, (a.lon - b.lon) * kmLon((a.lat + b.lat) / 2));

type Pt = [number, number];

/** The part of a convex polygon on `p`'s side of the bisector between p and q. */
function clipTowards(poly: Pt[], p: Pt, q: Pt): Pt[] {
  const mx = (p[0] + q[0]) / 2;
  const mz = (p[1] + q[1]) / 2;
  const nx = q[0] - p[0];
  const nz = q[1] - p[1];
  const side = (v: Pt) => (v[0] - mx) * nx + (v[1] - mz) * nz; // < 0: p's side
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Pt;
    const b = poly[(i + 1) % poly.length] as Pt;
    const sa = side(a);
    const sb = side(b);
    if (sa <= 0) out.push(a);
    if (sa < 0 !== sb < 0) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** Is a point in water (a water ring of the land cover, and not in one of its holes)? */
export function inWater(land: LandCover, [x, z]: Pt): boolean {
  const water = LAND_KINDS.indexOf("water");
  let inside = false;
  for (let r = 0; r < land.kinds.length; r++) {
    if (land.kinds[r] !== water) continue;
    const from = land.ringAt[r] as number;
    const to = land.ringAt[r + 1] as number;
    let hit = false;
    for (let i = from, j = to - 1; i < to; j = i++) {
      const xi = land.points[i * 2] as number;
      const zi = land.points[i * 2 + 1] as number;
      const xj = land.points[j * 2] as number;
      const zj = land.points[j * 2 + 1] as number;
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    }
    // An island (a hole) takes back what its water ring gave.
    if (hit) inside = land.holes[r] !== 1;
  }
  return inside;
}

/** The road junction (not a ferry pier or a station) nearest a point. */
function nearestRoadNode(network: RoadNetwork, [x, z]: Pt): Pt {
  const roads = new Set<number>();
  for (let l = 0; l * 7 < network.links.length; l++) {
    if ((network.links[l * 7 + 5] as number) > LAST_ROAD_CLASS) continue;
    roads.add(network.links[l * 7] as number);
    roads.add(network.links[l * 7 + 1] as number);
  }
  let best: Pt = [x, z];
  let bestD = Number.POSITIVE_INFINITY;
  for (const v of roads) {
    const nx = network.nodes[v * 2] as number;
    const nz = network.nodes[v * 2 + 1] as number;
    const d = (nx - x) ** 2 + (nz - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = [nx, nz];
    }
  }
  return best;
}

/** Districts as the regions nearest each centre (Voronoi), inside the map. */
export function regionsAround(centres: readonly Pt[], extent: Pt): Pt[][] {
  const box: Pt[] = [
    [0, 0],
    [extent[0], 0],
    [extent[0], extent[1]],
    [0, extent[1]],
  ];
  return centres.map((c, i) => {
    let poly = box;
    centres.forEach((o, j) => {
      if (j !== i && (o[0] !== c[0] || o[1] !== c[1])) poly = clipTowards(poly, c, o);
    });
    return poly.map(([x, z]) => [Math.round(x), Math.round(z)] as Pt);
  });
}

export async function groundCity(city: CitySpec, deps: GroundDeps): Promise<GroundResult> {
  const signal = deps.signal ?? new AbortController().signal;
  const stageDeps: StageDeps = {
    store: deps.store,
    index: deps.index,
    signal,
    ...(deps.onStage ? { onStage: deps.onStage } : {}),
  };
  const stages: StageRecord[] = [];
  let cached = 0;
  const issues: string[] = [];
  const asIs = (): GroundResult => ({
    spec: city,
    network: null,
    networkRef: null,
    land: null,
    landRef: null,
    issues,
    stages,
    cached,
  });

  const cityPlaces = placesOf(city);
  const cityDistricts = districtsOf(city);

  // ── Where is it? ───────────────────────────────────────────────────────────────────────
  const request: LocateRequest = {
    city: { name: city.name, tagline: city.tagline },
    places: cityPlaces.map((p) => ({
      key: p.key,
      name: p.name,
      blurb: p.blurb,
      district: p.district,
    })),
    districts: cityDistricts.map((d) => ({ key: d.key, name: d.name })),
  };
  const locate = async (asked: LocateRequest): Promise<Located> => {
    const requestRef = await deps.store.put(json(asked).bytes, "application/json");
    const located = await runStage<"located">(
      {
        stage: "locate-city",
        version: GROUND_VERSION,
        model: deps.locator.model,
        prompt: deps.locator.prompt,
        inputs: { request: requestRef.hash },
        params: { effort: deps.locator.effort },
      },
      stageDeps,
      async (seed) => {
        const raw = await deps.locator.locate(asked, { store: deps.store, seed, signal });
        const parsed = Located.safeParse(raw);
        if (!parsed.success) throw new Error("locator: output rejected");
        return { located: json(parsed.data) };
      },
    );
    stages.push(located.record);
    if (located.cached) cached++;
    return Located.parse(await readJson(deps.store, located.outputs.located));
  };
  let where = await locate(request);
  if (!where.real) return asIs();
  // A place in the wrong district is a wrong map: code says which, the model decides where.
  const misplaced = misplacedPlaces(where, request.places);
  if (misplaced.length > 0) {
    const again = await locate({ ...request, misplaced });
    if (again.real && misplacedPlaces(again, request.places).length < misplaced.length) {
      where = again;
    }
    for (const m of misplacedPlaces(where, request.places)) {
      issues.push(`place "${m.place}" is nearer district "${m.nearest}" than "${m.district}".`);
    }
  }
  const near = <T extends { lat: number; lon: number; key: string }>(xs: T[], what: string) =>
    xs.filter((x) => {
      const ok = kmBetween(x, where.city) <= MAX_KM;
      if (!ok)
        issues.push(`${what} "${x.key}" was placed over ${MAX_KM} km from the city; left out.`);
      return ok;
    });
  const places = near(
    where.places.filter((p) => cityPlaces.some((c) => c.key === p.key)),
    "place",
  );
  const districts = near(
    where.districts.filter((d) => cityDistricts.some((c) => c.key === d.key)),
    "district",
  );
  if (places.length === 0) {
    issues.push("none of the city's places could be found; it stays sketched.");
    return asIs();
  }

  // ── Its roads ──────────────────────────────────────────────────────────────────────────
  const lats = [...places, ...districts].map((p) => p.lat);
  const lons = [...places, ...districts].map((p) => p.lon);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const box: GeoBox = {
    south: Math.min(...lats) - MARGIN_KM / KM_LAT,
    north: Math.max(...lats) + MARGIN_KM / KM_LAT,
    west: Math.min(...lons) - MARGIN_KM / kmLon(midLat),
    east: Math.max(...lons) + MARGIN_KM / kmLon(midLat),
  };
  const query = overpassQuery(box);
  const queryRef = await deps.store.put(new TextEncoder().encode(query), "text/plain");
  const fetched = await runStage<"answer">(
    {
      stage: "osm-roads",
      version: GROUND_VERSION,
      model: deps.maps.ref,
      prompt: null,
      inputs: { query: queryRef.hash },
      params: {},
    },
    stageDeps,
    async () => ({
      answer: { bytes: await deps.maps.fetch(query, signal), mediaType: "application/json" },
    }),
  );
  stages.push(fetched.record);
  if (fetched.cached) cached++;
  const answer = OverpassAnswer.safeParse(await readJson(deps.store, fetched.outputs.answer));
  if (!answer.success) {
    issues.push("the map data came back in a shape we don't read; it stays sketched.");
    return asIs();
  }
  const roads = buildNetwork(answer.data, box);
  if (!roads) {
    issues.push("no main roads were found there; it stays sketched.");
    return asIs();
  }
  // Its ferries and railways, joined to the roads at their stops (only if some way to get
  // around travels on them).
  let network = roads;
  if (moversOf(city).some((m) => m.way !== "road")) {
    try {
      const q = linesQuery(box);
      const qRef = await deps.store.put(new TextEncoder().encode(q), "text/plain");
      const lines = await runStage<"answer">(
        {
          stage: "osm-lines",
          version: LINES_VERSION,
          model: deps.maps.ref,
          prompt: null,
          inputs: { query: qRef.hash },
          params: {},
        },
        stageDeps,
        async () => ({
          answer: { bytes: await deps.maps.fetch(q, signal), mediaType: "application/json" },
        }),
      );
      stages.push(lines.record);
      if (lines.cached) cached++;
      const parsed = OverpassAnswer.safeParse(await readJson(deps.store, lines.outputs.answer));
      if (parsed.success) network = addLines(roads, parsed.data, box);
      else issues.push("the ferry and rail lines came back in a shape we don't read; roads only.");
    } catch (e) {
      if (signal.aborted) throw e;
      issues.push("the ferry and rail lines couldn't be fetched; roads only.");
    }
  }
  const networkRef = await deps.store.put(
    json(RoadNetworkSchema.parse(network)).bytes,
    "application/json",
  );

  // ── What covers the ground ─────────────────────────────────────────────────────────────
  let land: LandCover | null = null;
  let landRef: ArtifactRef | null = null;
  try {
    const lq = landQuery(box);
    const lqRef = await deps.store.put(new TextEncoder().encode(lq), "text/plain");
    const cover = await runStage<"answer">(
      {
        stage: "osm-land",
        version: LAND_VERSION,
        model: deps.maps.ref,
        prompt: null,
        inputs: { query: lqRef.hash },
        params: {},
      },
      stageDeps,
      async () => ({
        answer: { bytes: await deps.maps.fetch(lq, signal), mediaType: "application/json" },
      }),
    );
    stages.push(cover.record);
    if (cover.cached) cached++;
    const parsed = LandAnswer.safeParse(await readJson(deps.store, cover.outputs.answer));
    if (parsed.success) {
      land = buildLand(parsed.data, box, network.extentM);
      landRef = await deps.store.put(json(land).bytes, "application/json");
    } else issues.push("the land cover came back in a shape we don't read; roads only.");
  } catch (e) {
    if (signal.aborted) throw e;
    issues.push("the land cover couldn't be fetched; roads only.");
  }

  // ── The city on them ───────────────────────────────────────────────────────────────────
  const extent: Pt = [network.extentM[0], network.extentM[1]];
  const at = new Map(
    places.map((p) => {
      const pt = projectOnto(network, p.lat, p.lon);
      // A model's coordinates can land a beach bar in the sea: on land, at the nearest road.
      if (land && inWater(land, pt)) {
        issues.push(`place "${p.key}" was in the water; moved to the nearest road.`);
        return [p.key, nearestRoadNode(network, pt)];
      }
      return [p.key, pt];
    }),
  );
  const fallback = projectOnto(network, where.city.lat, where.city.lon);
  for (const p of cityPlaces) {
    if (!at.has(p.key)) issues.push(`place "${p.key}" couldn't be found; put at the centre.`);
  }
  // Districts: their real centres if known, else the middle of their places.
  const centres: Pt[] = cityDistricts.map((d) => {
    const known = districts.find((x) => x.key === d.key);
    if (known) return projectOnto(network, known.lat, known.lon);
    const mine = cityPlaces.filter((p) => p.district === d.key).map((p) => at.get(p.key));
    const pts = mine.filter((p): p is Pt => p !== undefined);
    if (pts.length === 0) return fallback;
    return [
      Math.round(pts.reduce((s, p) => s + p[0], 0) / pts.length),
      Math.round(pts.reduce((s, p) => s + p[1], 0) / pts.length),
    ];
  });
  const regions = regionsAround(centres, extent);
  const clampPt = ([x, z]: Pt): Pt => [
    Math.max(0, Math.min(CITY_BOUNDS.realMapM, Math.round(x))),
    Math.max(0, Math.min(CITY_BOUNDS.realMapM, Math.round(z))),
  ];
  // Places where they really are, districts as regions round their real centres. The sketch's
  // roads and water give way to the real network and land cover, and what stood at sketched
  // spots has nowhere true to stand.
  const placeKeys = new Set(cityPlaces.map((p) => p.key));
  const regionOf = new Map(cityDistricts.map((d, i) => [d.key, regions[i] ?? []]));
  const kindOf = new Map(city.kinds.map((k) => [k.key, k]));
  const items = city.items.flatMap((item) => {
    const kind = kindOf.get(item.kind);
    if (kind?.traits.line || kind?.traits.area?.blocks) return [];
    if (placeKeys.has(item.key)) {
      return [{ ...item, where: { ...item.where, at: clampPt(at.get(item.key) ?? fallback) } }];
    }
    const region = regionOf.get(item.key);
    if (region) {
      const polygon = region.slice(0, KIND_BOUNDS.polygon).map(clampPt);
      return [{ ...item, where: { ...item.where, polygon } }];
    }
    return [{ ...item, where: { ...item.where, at: null, spots: [] } }];
  });
  const spec = CitySpecSchema.parse({
    ...city,
    items,
    real: {
      origin: network.origin,
      extentM: network.extentM,
      network: networkRef.hash,
      ...(landRef ? { land: landRef.hash } : {}),
    },
  });
  return { spec, network, networkRef, land, landRef, issues, stages, cached };
}
