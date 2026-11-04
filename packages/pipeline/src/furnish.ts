/**
 * Furnishing: after a place's world is written, a model picks real library models
 * for what it contains: a model for each kind of thing, an outfit for each person, a surface
 * for each floor and the walls; and, for a city, the outfits new arrivals choose from, a
 * building for each place, models for what stands on its map and what its streets are lined with.
 *
 * The model only *chooses*, by id, from the catalog code curated. Every choice is checked
 * against the catalog (the right category, a surface fit for its use) and anything else is
 * dropped, so the worst a bad answer can do is leave something drawn from its primitives.
 * Only looks change, and which panel a thing opens: rules, people and money stay as play-tested.
 * Each furnishing is a memoised stage keyed by the spec, the scene and the catalog, so a new
 * library refurnishes and an unchanged one replays with no model call.
 */
import type { ArtifactStore, RecipeIndex } from "@aye/artifacts";
import {
  type ArtifactRef,
  type CitySpec,
  CitySpec as CitySpecSchema,
  type LibraryCatalog,
  type LibraryIndex,
  libraryIndex,
  type Scene,
  type StageRecord,
  viewsOf,
  type WorldSpec,
  WorldSpec as WorldSpecSchema,
} from "@aye/schema";
import { z } from "zod";
import type { Furnisher } from "./providers.ts";
import { json, readJson, runStage, type StageDeps } from "./stage.ts";

/** Bump when what furnishing sends, accepts or applies changes. */
export const FURNISH_VERSION = 6;

/** "No library entry fits": draw it from its primitives. */
export const NONE = "none";

/** What the furnisher is shown for one place. Labels are other models' words: data. */
export interface WorldFurnishRequest {
  place: { name: string; summary: string };
  kinds: { index: number; label: string; note: string; sizeM: [number, number, number] }[];
  people: { index: number; name: string; about: string }[];
  spaces: { index: number; name: string; outdoor: boolean }[];
  /** The city's panels (groups of apps people open), which things here may open. */
  panels: { key: string; name: string }[];
  library: CatalogView;
}

export interface CityFurnishRequest {
  city: { name: string; tagline: string };
  starts: string[];
  /** The places on the map, and the size of their building there (metres). */
  places: {
    index: number;
    name: string;
    blurb: string;
    tags: string[];
    sizeM: [number, number, number];
  }[];
  /** The city's districts, whose streets are filled with ordinary buildings. */
  districts: { index: number; name: string }[];
  /**
   * The kinds seen on the map as themselves (what people travel in, what stands around),
   * with what they are and their real size (metres).
   */
  kinds: { index: number; name: string; about: string; sizeM: [number, number, number] }[];
  library: Pick<CatalogView, "outfits"> & {
    buildings: CatalogView["things"];
    things: CatalogView["things"];
  };
}

interface CatalogView {
  things: {
    id: string;
    label: string;
    tags: string[];
    sizeM: [number, number, number];
    style: string;
  }[];
  outfits: { id: string; label: string; tags: string[] }[];
  surfaces: { id: string; label: string; tags: string[]; use: string }[];
}

const m = (mm: number) => Math.round(mm / 100) / 10;

export function catalogView(catalog: LibraryCatalog): CatalogView {
  return {
    things: catalog.things.map((t) => ({
      id: t.id,
      label: t.label,
      tags: t.tags,
      sizeM: [m(t.sizeMm[0]), m(t.sizeMm[1]), m(t.sizeMm[2])],
      style: t.style,
    })),
    outfits: catalog.outfits.map((o) => ({ id: o.id, label: o.label, tags: o.tags })),
    surfaces: catalog.surfaces.map((s) => ({ id: s.id, label: s.label, tags: s.tags, use: s.use })),
  };
}

/** The answer's shape, with every choice constrained to real ids (or "none"). */
export function worldFurnishSchema(catalog: LibraryCatalog, panels: readonly string[] = []) {
  const ids = (xs: readonly { id: string }[]) => z.enum([NONE, ...xs.map((x) => x.id)]);
  return z.strictObject({
    kinds: z
      .array(
        z.strictObject({
          kind: z.int().min(0),
          asset: ids(catalog.things),
          panel: z.enum([NONE, ...panels]),
        }),
      )
      .max(64),
    people: z
      .array(z.strictObject({ person: z.int().min(0), outfit: ids(catalog.outfits) }))
      .max(16),
    floors: z
      .array(z.strictObject({ space: z.int().min(0), surface: ids(catalog.surfaces) }))
      .max(64),
    walls: ids(catalog.surfaces),
  });
}

export function cityFurnishSchema(catalog: LibraryCatalog) {
  const buildings = catalog.things.filter((t) => t.tags.includes("building"));
  const things = catalog.things.filter((t) => !t.tags.includes("building"));
  return z.strictObject({
    outfits: z.array(z.enum([NONE, ...catalog.outfits.map((o) => o.id)])).max(12),
    places: z
      .array(
        z.strictObject({
          place: z.int().min(0),
          asset: z.enum([NONE, ...buildings.map((b) => b.id)]),
        }),
      )
      .max(64),
    kinds: z
      .array(
        z.strictObject({
          kind: z.int().min(0),
          asset: z.enum([NONE, ...things.map((t) => t.id)]),
        }),
      )
      .max(48),
    districts: z
      .array(
        z.strictObject({
          district: z.int().min(0),
          buildings: z.array(z.enum([NONE, ...buildings.map((b) => b.id)])).max(6),
        }),
      )
      .max(16),
  });
}

/** Anything parse-shaped that looks like an answer; ids are re-checked when applied. */
const LooseWorldAnswer = z.object({
  kinds: z
    .array(
      z.object({ kind: z.int(), asset: z.string().max(64), panel: z.string().max(64).optional() }),
    )
    .max(64),
  people: z.array(z.object({ person: z.int(), outfit: z.string().max(64) })).max(16),
  floors: z.array(z.object({ space: z.int(), surface: z.string().max(64) })).max(64),
  walls: z.string().max(64),
});
type WorldAnswer = z.infer<typeof LooseWorldAnswer>;
const LooseCityAnswer = z.object({
  outfits: z.array(z.string().max(64)).max(12),
  places: z
    .array(z.object({ place: z.int(), asset: z.string().max(64) }))
    .max(64)
    .default([]),
  kinds: z
    .array(z.object({ kind: z.int(), asset: z.string().max(64) }))
    .max(48)
    .default([]),
  districts: z
    .array(z.object({ district: z.int(), buildings: z.array(z.string().max(64)).max(12) }))
    .max(16)
    .default([]),
});

export interface FurnishDeps {
  furnisher: Furnisher;
  store: ArtifactStore;
  index: RecipeIndex;
  catalog: LibraryCatalog;
  /** The city's panel keys and names, for things that open one. */
  panels?: readonly { key: string; label: string }[];
  signal?: AbortSignal;
  onStage?: StageDeps["onStage"];
}

export interface FurnishResult<S> {
  spec: S;
  /** How many choices landed (things, people, surfaces). */
  chosen: number;
  stages: StageRecord[];
  cached: number;
}

const put = async (store: ArtifactStore, value: unknown): Promise<ArtifactRef> =>
  store.put(json(value).bytes, "application/json");

/** Apply a world answer: only ids of the right category, only where nothing was chosen yet. */
export function applyWorldAnswer(
  spec: WorldSpec,
  scene: Scene,
  answer: WorldAnswer,
  library: LibraryIndex,
  panels: ReadonlySet<string> = new Set(),
): { spec: WorldSpec; chosen: number } {
  let chosen = 0;
  const kinds = spec.kinds.map((k, i) => {
    const a = answer.kinds.find((x) => x.kind === i);
    let next = k;
    if (!k.asset && a?.asset && library.thing(a.asset)) {
      chosen++;
      next = { ...next, asset: a.asset };
    }
    if (!k.panel && a?.panel && panels.has(a.panel)) {
      chosen++;
      next = { ...next, panel: a.panel };
    }
    return next;
  });
  const people = spec.people.map((p, i) => {
    const pick = answer.people.find((a) => a.person === i)?.outfit;
    if (p.outfit || !pick || !library.outfit(pick)) return p;
    chosen++;
    return { ...p, outfit: pick };
  });
  const floorOk = (id: string) => {
    const s = library.surface(id);
    return s !== undefined && s.use !== "wall";
  };
  const ground = scene.spaces.map((space, i) => {
    const current = spec.ground.find((g) => g.space === space.id);
    const pick = answer.floors.find((f) => f.space === i)?.surface;
    const colour = current?.colour ?? (space.ceilingMm === null ? "#a9a59c" : "#e4ddd0");
    if (current?.surface || !pick || !floorOk(pick)) return current ?? { space: space.id, colour };
    chosen++;
    return { space: space.id, colour, surface: pick };
  });
  const wall = library.surface(answer.walls);
  const walls =
    spec.walls.surface || !wall || wall.use === "floor"
      ? spec.walls
      : { ...spec.walls, surface: wall.id };
  if (walls !== spec.walls) chosen++;
  return { spec: WorldSpecSchema.parse({ ...spec, kinds, people, ground, walls }), chosen };
}

/** Choose library models, outfits and surfaces for a place's world. */
export async function furnishWorld(
  spec: WorldSpec,
  scene: Scene,
  deps: FurnishDeps,
): Promise<FurnishResult<WorldSpec>> {
  const signal = deps.signal ?? new AbortController().signal;
  const library = libraryIndex(deps.catalog);
  if (
    deps.catalog.things.length + deps.catalog.outfits.length + deps.catalog.surfaces.length ===
    0
  ) {
    return { spec, chosen: 0, stages: [], cached: 0 };
  }
  const sizeOf = new Map<string, [number, number, number]>();
  for (const t of spec.things) {
    const o = scene.objects.find((x) => x.id === t.object);
    if (o && !sizeOf.has(t.kind)) sizeOf.set(t.kind, [m(o.size.w), m(o.size.h), m(o.size.d)]);
  }
  const request: WorldFurnishRequest = {
    place: { name: spec.name, summary: spec.summary },
    kinds: spec.kinds.map((k, index) => ({
      index,
      label: k.label,
      note: k.note,
      sizeM: sizeOf.get(k.key) ?? [1, 1, 1],
    })),
    people: spec.people.map((p, index) => ({ index, name: p.name, about: p.about })),
    spaces: scene.spaces.map((s, index) => ({
      index,
      name: s.name,
      outdoor: s.ceilingMm === null,
    })),
    panels: (deps.panels ?? []).map((p) => ({ key: p.key, name: p.label })),
    library: catalogView(deps.catalog),
  };
  const [requestRef, catalogRef] = await Promise.all([
    put(deps.store, request),
    put(deps.store, deps.catalog),
  ]);
  const result = await runStage<"answer">(
    {
      stage: "furnish-world",
      version: FURNISH_VERSION,
      model: deps.furnisher.model,
      prompt: deps.furnisher.prompt,
      inputs: { request: requestRef.hash, catalog: catalogRef.hash },
      params: { effort: deps.furnisher.effort },
    },
    {
      store: deps.store,
      index: deps.index,
      signal,
      ...(deps.onStage ? { onStage: deps.onStage } : {}),
    },
    async (seed) => {
      const schema = worldFurnishSchema(
        deps.catalog,
        request.panels.map((p) => p.key),
      );
      const raw = await deps.furnisher.furnishWorld(request, schema, {
        store: deps.store,
        seed,
        signal,
      });
      const parsed = LooseWorldAnswer.safeParse(raw);
      if (!parsed.success) throw new Error("furnisher: output rejected");
      return { answer: json(parsed.data) };
    },
  );
  const answer = LooseWorldAnswer.parse(await readJson(deps.store, result.outputs.answer));
  const panelKeys = new Set(request.panels.map((p) => p.key));
  const applied = applyWorldAnswer(spec, scene, answer, library, panelKeys);
  return { ...applied, stages: [result.record], cached: result.cached ? 1 : 0 };
}

/**
 * Choose the outfits new arrivals in a city pick from, a library building for each place on
 * the map, and models for its scenery and for what its travellers ride in. Only what isn't
 * chosen yet is filled in.
 */
export async function furnishCity(
  city: CitySpec,
  deps: FurnishDeps,
): Promise<FurnishResult<CitySpec>> {
  const signal = deps.signal ?? new AbortController().signal;
  const library = libraryIndex(deps.catalog);
  const view = catalogView(deps.catalog);
  const buildings = view.things.filter((t) => t.tags.includes("building"));
  const things = view.things.filter((t) => !t.tags.includes("building"));
  const { places, districts } = viewsOf(city);
  // Kinds seen on the map as themselves: what people travel in, what stands around.
  const seen = city.kinds.filter((k) => k.look && !k.traits.place);
  const todo =
    (city.outfits.length === 0 && view.outfits.length > 0) ||
    (buildings.length > 0 && places.some((p) => !p.look?.asset)) ||
    (things.length > 0 && seen.some((k) => !k.look?.asset)) ||
    (buildings.length > 0 && districts.some((d) => d.fill.length === 0));
  if (!todo) return { spec: city, chosen: 0, stages: [], cached: 0 };
  const request: CityFurnishRequest = {
    city: { name: city.name, tagline: city.tagline },
    starts: city.starts.map((s) => `${s.label}: ${s.blurb}`),
    places: places.map((p, index) => ({
      index,
      name: p.name,
      blurb: p.blurb,
      tags: p.tags,
      sizeM: [p.sizeM[0], p.heightM, p.sizeM[1]],
    })),
    kinds: seen.map((k, index) => ({
      index,
      name: k.name,
      about: k.about,
      sizeM: k.look?.sizeM ?? [1, 1, 1],
    })),
    districts: districts.map((d, index) => ({ index, name: d.name })),
    library: { outfits: view.outfits, buildings, things },
  };
  const [requestRef, catalogRef] = await Promise.all([
    put(deps.store, request),
    put(deps.store, deps.catalog),
  ]);
  const result = await runStage<"answer">(
    {
      stage: "furnish-city",
      version: FURNISH_VERSION,
      model: deps.furnisher.model,
      prompt: deps.furnisher.cityPrompt,
      inputs: { request: requestRef.hash, catalog: catalogRef.hash },
      params: { effort: deps.furnisher.effort },
    },
    {
      store: deps.store,
      index: deps.index,
      signal,
      ...(deps.onStage ? { onStage: deps.onStage } : {}),
    },
    async (seed) => {
      const raw = await deps.furnisher.furnishCity(request, cityFurnishSchema(deps.catalog), {
        store: deps.store,
        seed,
        signal,
      });
      const parsed = LooseCityAnswer.safeParse(raw);
      if (!parsed.success) throw new Error("furnisher: output rejected");
      return { answer: json(parsed.data) };
    },
  );
  const answer = LooseCityAnswer.parse(await readJson(deps.store, result.outputs.answer));
  let chosen = 0;
  const outfits =
    city.outfits.length > 0
      ? city.outfits
      : [...new Set(answer.outfits.filter((id) => library.outfit(id)))].slice(0, 12);
  if (outfits !== city.outfits) chosen += outfits.length;
  const isBuilding = (id: string) => library.thing(id)?.tags.includes("building") === true;
  const pickedPlace = new Map<string, string>();
  places.forEach((p, i) => {
    const pick = answer.places.find((a) => a.place === i)?.asset;
    if (p.look?.asset || !pick || !isBuilding(pick)) return;
    pickedPlace.set(p.key, pick);
  });
  const pickedKind = new Map<string, string>();
  seen.forEach((k, i) => {
    const pick = answer.kinds.find((a) => a.kind === i)?.asset;
    if (k.look?.asset || !pick || !library.thing(pick) || isBuilding(pick)) return;
    pickedKind.set(k.key, pick);
  });
  const pickedFill = new Map<string, string[]>();
  districts.forEach((d, i) => {
    if (d.fill.length > 0) return;
    const picks = (answer.districts.find((a) => a.district === i)?.buildings ?? []).filter(
      isBuilding,
    );
    const fill = [...new Set(picks)].slice(0, 6);
    if (fill.length > 0) pickedFill.set(d.key, fill);
  });
  chosen += pickedPlace.size + pickedKind.size + pickedFill.size;
  const kinds = city.kinds.map((k) => {
    const asset = pickedKind.get(k.key);
    return asset && k.look ? { ...k, look: { ...k.look, asset } } : k;
  });
  const items = city.items.map((i) => {
    const asset = pickedPlace.get(i.key);
    const fill = pickedFill.get(i.key);
    const place = places.find((p) => p.key === i.key);
    let next = i;
    if (asset && place) {
      next = { ...next, look: { ...(place.look ?? { sizeM: [1, 1, 1], solids: [] }), asset } };
    }
    if (fill) next = { ...next, traits: { ...next.traits, area: { ...next.traits.area, fill } } };
    return next;
  });
  return {
    spec: CitySpecSchema.parse({ ...city, outfits, kinds, items }),
    chosen,
    stages: [result.record],
    cached: result.cached ? 1 : 0,
  };
}
