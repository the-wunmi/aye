/**
 * Kinds, traits and items: what a city is made of, defined by the model that
 * writes it, run by code that knows only physics.
 *
 * A **kind** is a type the model declares for its city: a name, what it is, a look, and the
 * **traits** it has. Traits are code's whole vocabulary for what anything on the map can do:
 * be a place people go into, move people along a network, cover an area, run as a line, or
 * stand as a prop. Each trait is a bundle of bounded numbers with one interpreter in code.
 * Code never knows what a danfo, a palm or a market is; the model says "a danfo is a mover
 * on the road network at 30 km/h holding 14, and looks like this".
 *
 * An **item** is an instance of a kind somewhere on the map ("Balogun Market" of the kind
 * "Market"), and may override its kind's look and trait parameters.
 *
 * Attributes (`attrs`) are free-form fields the model declares for its own use: bounded,
 * display-only or read by models, never interpreted by code.
 *
 * Code reads a city only through the views at the bottom (`placesOf`, `moversOf`, ...): one
 * per trait, each giving every item or kind that has it, with overrides applied.
 */
import { z } from "zod";
import { AssetId } from "./library.ts";
import { Label } from "./primitives.ts";
import { WAYS } from "./road-network.ts";
import { Solid, SpecKey } from "./world-spec.ts";

export const KIND_BOUNDS = {
  kinds: 48,
  items: 160,
  attrs: 12,
  attrText: 120,
  /** Shapes in a look. */
  shapes: 32,
  /** Spots one item scatters its kind across (trees along a street). */
  spots: 80,
  polygon: 24,
  linePoints: 16,
  tags: 4,
  fill: 6,
  sizeM: 400,
  heightM: 250,
  speedKmh: { min: 2, max: 150 },
  holds: 150,
  fare: 10_000_000,
  widthM: { min: 3, max: 80 },
  /** Metres across the largest map (a real city). */
  mapM: 80_000,
} as const;

const Colour = z.string().regex(/^#[0-9a-f]{6}$/, "colour as #rrggbb");
const Text = (max: number) => z.string().max(max);
const Metre = z.int().min(0).max(KIND_BOUNDS.mapM);
const Point = z.tuple([Metre, Metre]);
const MinuteOfDay = z.int().min(0).max(1439);
const Size = z.int().min(1).max(KIND_BOUNDS.sizeM);

/** Opening or running hours in city time; `to` may be past midnight. Null: always. */
export const Hours = z.object({ from: MinuteOfDay, to: MinuteOfDay }).nullable();
export type Hours = z.infer<typeof Hours>;

/** Is something with these hours open at this minute of the day? */
export function isOpen(hours: Hours, minuteOfDay: number): boolean {
  if (!hours) return true;
  const { from, to } = hours;
  if (from === to) return true;
  return from < to
    ? minuteOfDay >= from && minuteOfDay < to
    : minuteOfDay >= from || minuteOfDay < to;
}

/**
 * How something looks: solids in a box of its size (metres: x, y up, z), or a library model
 * fitted to that box. A mover's front faces +x, the way it goes; anything else's faces +z.
 */
export const Look = z.object({
  sizeM: z.tuple([Size, Size, Size]),
  solids: z.array(Solid).max(KIND_BOUNDS.shapes),
  asset: AssetId.optional(),
});
export type Look = z.infer<typeof Look>;

// ── Traits: code's vocabulary ─────────────────────────────────────────────────────────

/** Somewhere people go into: built as its own place (scene and world). */
export const PlaceTrait = z.object({
  hours: Hours,
  /** One copy per player (a home): nobody else walks into yours. */
  private: z.boolean(),
  /** Words apps filter by ("food", "work"). */
  tags: z.array(SpecKey).max(KIND_BOUNDS.tags),
  /** Its building's footprint (width, depth) and height, metres. */
  footprintM: z.tuple([Size, Size]),
  heightM: z.int().min(2).max(KIND_BOUNDS.heightM),
  /** What it's like inside, in words: what the place is built from. Display only. */
  build: Text(600),
  /** What someone has to have to get in: a place worth working towards. Never a home. */
  asks: z
    .array(z.object({ mark: SpecKey, atLeast: z.int().min(1).max(1_000) }))
    .max(3)
    .optional(),
});
export type PlaceTrait = z.infer<typeof PlaceTrait>;

/** Moves people along a network: a way to get around the city. */
export const MoverTrait = z.object({
  /** The network it runs on. */
  way: z.enum(WAYS),
  speedKmh: z.int().min(KIND_BOUNDS.speedKmh.min).max(KIND_BOUNDS.speedKmh.max),
  /** People one of it carries, driver included; 0: people on foot (no vehicle). */
  holds: z.int().min(0).max(KIND_BOUNDS.holds),
  /** Minor units: flag-fall, and per kilometre. */
  fare: z.object({
    base: z.int().min(0).max(KIND_BOUNDS.fare),
    perKm: z.int().min(0).max(KIND_BOUNDS.fare),
  }),
  hours: Hours,
  /**
   * For a line (water, rail): the kind riders reach its stops by, on the roads. Null: on
   * foot, by the city's free way to get around.
   */
  reach: SpecKey.nullable(),
  /** The places it goes, by key; empty: everywhere. Never limits the city's free way around. */
  serves: z.array(SpecKey).max(KIND_BOUNDS.items).default([]),
  /** What going this way takes out of you, per hour of the trip, on top of the time passing. */
  tires: z
    .array(z.object({ need: SpecKey, perHour: z.int().min(1).max(1_000) }))
    .max(3)
    .default([]),
});
export type MoverTrait = z.infer<typeof MoverTrait>;

/**
 * Can this take someone from one place to another? A free way around goes everywhere, so nobody
 * with no money is ever stuck. `from` null: they aren't anywhere yet.
 */
export function moverServes(
  mover: Pick<MoverTrait, "serves" | "fare">,
  from: string | null,
  to: string,
): boolean {
  if (mover.serves.length === 0 || (mover.fare.base === 0 && mover.fare.perKm === 0)) return true;
  return mover.serves.includes(to) && (from === null || mover.serves.includes(from));
}

/** Covers an area of the map: land people live in (a district), or water nothing crosses. */
export const AreaTrait = z.object({
  /** Nothing is built on it and nobody walks or drives across it (water). */
  blocks: z.boolean(),
  /** Library buildings its streets are lined with on the map (looks only). */
  fill: z.array(AssetId).max(KIND_BOUNDS.fill),
});
export type AreaTrait = z.infer<typeof AreaTrait>;

/** Runs along a line people travel on (a sketched city's road). */
export const LineTrait = z.object({
  widthM: z.int().min(KIND_BOUNDS.widthM.min).max(KIND_BOUNDS.widthM.max),
});
export type LineTrait = z.infer<typeof LineTrait>;

/** Stands on the map as it looks, wherever its items put it (trees, stalls, parked buses). */
export const PropTrait = z.object({});
export type PropTrait = z.infer<typeof PropTrait>;

export const Traits = z.object({
  place: PlaceTrait.optional(),
  mover: MoverTrait.optional(),
  area: AreaTrait.optional(),
  line: LineTrait.optional(),
  prop: PropTrait.optional(),
});
export type Traits = z.infer<typeof Traits>;
export const TRAITS = ["place", "mover", "area", "line", "prop"] as const;
export type TraitName = (typeof TRAITS)[number];

/** The model's own fields: display-only or model-only, never interpreted by code. */
export const Attrs = z
  .record(SpecKey, z.union([Text(KIND_BOUNDS.attrText), z.int(), z.boolean()]))
  .refine((a) => Object.keys(a).length <= KIND_BOUNDS.attrs, "too many attributes");
export type Attrs = z.infer<typeof Attrs>;

export const Kind = z.object({
  key: SpecKey,
  name: Label.min(1),
  /** What it is, in a line. Display only. */
  about: Text(200),
  icon: z.string().min(1).max(32),
  colour: Colour,
  look: Look.nullable(),
  traits: Traits,
  attrs: Attrs.default({}),
});
export type Kind = z.infer<typeof Kind>;

/** Where an item is: a point, spots scattered, an area, or a line. */
export const Where = z.object({
  district: SpecKey.nullable(),
  at: Point.nullable(),
  spots: z.array(Point).max(KIND_BOUNDS.spots).default([]),
  polygon: z.array(Point).max(KIND_BOUNDS.polygon).default([]),
  line: z.array(Point).max(KIND_BOUNDS.linePoints).default([]),
});
export type Where = z.infer<typeof Where>;

export const Item = z.object({
  key: SpecKey,
  kind: SpecKey,
  name: Label.min(1),
  /** One line about this one. Display only. */
  blurb: Text(200),
  icon: z.string().min(1).max(32).optional(),
  colour: Colour.optional(),
  /** Its own look instead of its kind's (a place's own building). */
  look: Look.optional(),
  /** Its own trait parameters over its kind's (a market's own hours). */
  traits: z
    .object({
      place: PlaceTrait.partial().optional(),
      mover: MoverTrait.partial().optional(),
      area: AreaTrait.partial().optional(),
      line: LineTrait.partial().optional(),
    })
    .default({}),
  where: Where,
  attrs: Attrs.default({}),
});
export type Item = z.infer<typeof Item>;

// ── Views: how code reads a city ──────────────────────────────────────────────────────

interface Spec {
  kinds: readonly Kind[];
  items: readonly Item[];
}

/** A place people go into: an item with the place trait, overrides applied. */
export interface CityPlace {
  key: string;
  kind: string;
  name: string;
  icon: string;
  blurb: string;
  district: string;
  at: [number, number];
  /** Footprint (width, depth) of its building, metres. */
  sizeM: [number, number];
  heightM: number;
  colour: string;
  tags: string[];
  hours: Hours;
  private: boolean;
  /** What someone has to have to get in. */
  asks?: { mark: string; atLeast: number }[];
  description: string;
  look: Look | null;
}

/** A way to get around: a kind with the mover trait. */
export interface CityMover extends MoverTrait {
  key: string;
  label: string;
  icon: string;
  colour: string;
  look: Look | null;
}

/** Something drawn standing on the map at one or more spots. */
export interface CityProp {
  key: string;
  name: string;
  look: Look;
  spots: [number, number][];
}

export interface CityArea {
  key: string;
  name: string;
  colour: string;
  polygon: [number, number][];
  blocks: boolean;
  fill: string[];
}

export interface CityLine {
  key: string;
  name: string;
  widthM: number;
  points: [number, number][];
}

export interface CityViews {
  places: CityPlace[];
  movers: CityMover[];
  props: CityProp[];
  /** Land areas people live in (districts). */
  districts: CityArea[];
  /** Areas nothing crosses (water). */
  water: CityArea[];
  lines: CityLine[];
}

const cache = new WeakMap<object, CityViews>();

/** A trait's parameters: the kind's, with whatever the item sets over them. */
function merged<T extends object>(
  base: T | undefined,
  over: { [K in keyof T]?: T[K] | undefined } | undefined,
): T | undefined {
  if (!base) return undefined;
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Every trait view of a city (computed once per spec object). */
export function viewsOf(city: Spec): CityViews {
  const hit = cache.get(city);
  if (hit) return hit;
  const kinds = new Map(city.kinds.map((k) => [k.key, k]));
  const places: CityPlace[] = [];
  const props: CityProp[] = [];
  const districts: CityArea[] = [];
  const water: CityArea[] = [];
  const lines: CityLine[] = [];
  for (const item of city.items) {
    const kind = kinds.get(item.kind);
    if (!kind) continue;
    const look = item.look ?? kind.look;
    const colour = item.colour ?? kind.colour;
    const place = merged(kind.traits.place, item.traits.place);
    if (place && item.where.at) {
      places.push({
        key: item.key,
        kind: kind.key,
        name: item.name,
        icon: item.icon ?? kind.icon,
        blurb: item.blurb,
        district: item.where.district ?? "",
        at: item.where.at,
        sizeM: place.footprintM,
        heightM: place.heightM,
        colour,
        tags: place.tags,
        hours: place.hours,
        private: place.private,
        ...(place.asks ? { asks: place.asks } : {}),
        description: place.build,
        look,
      });
    }
    const area = merged(kind.traits.area, item.traits.area);
    if (area && item.where.polygon.length >= 3) {
      const a = {
        key: item.key,
        name: item.name,
        colour,
        polygon: item.where.polygon,
        blocks: area.blocks,
        fill: area.fill,
      };
      (area.blocks ? water : districts).push(a);
    }
    const line = merged(kind.traits.line, item.traits.line);
    if (line && item.where.line.length >= 2) {
      lines.push({ key: item.key, name: item.name, widthM: line.widthM, points: item.where.line });
    }
    // Anything with a look that isn't a place, an area or a line stands where it's put.
    if (!place && !area && !line && look) {
      const spots = [...(item.where.at ? [item.where.at] : []), ...item.where.spots];
      if (spots.length > 0) props.push({ key: item.key, name: item.name, look, spots });
    }
  }
  const movers: CityMover[] = city.kinds.flatMap((k) =>
    k.traits.mover
      ? [
          {
            ...k.traits.mover,
            key: k.key,
            label: k.name,
            icon: k.icon,
            colour: k.colour,
            look: k.look,
          },
        ]
      : [],
  );
  const views = { places, movers, props, districts, water, lines };
  cache.set(city, views);
  return views;
}

export const placesOf = (city: Spec) => viewsOf(city).places;
export const moversOf = (city: Spec) => viewsOf(city).movers;
export const propsOf = (city: Spec) => viewsOf(city).props;
export const districtsOf = (city: Spec) => viewsOf(city).districts;
export const waterOf = (city: Spec) => viewsOf(city).water;
export const linesOf = (city: Spec) => viewsOf(city).lines;

/** Problems in how a city's kinds and items fit together. */
export function kindIssues(city: Spec): string[] {
  const issues: string[] = [];
  const kinds = new Map<string, Kind>();
  for (const k of city.kinds) {
    if (kinds.has(k.key)) issues.push(`kind "${k.key}" is defined twice`);
    kinds.set(k.key, k);
    if (!TRAITS.some((t) => k.traits[t])) issues.push(`kind "${k.key}" has no traits`);
    const reach = k.traits.mover?.reach;
    if (reach != null && !kinds.has(reach) && !city.kinds.some((o) => o.key === reach)) {
      issues.push(`kind "${k.key}" is reached by unknown kind "${reach}"`);
    }
  }
  const seen = new Set<string>();
  const areas = new Set(
    city.items
      .filter((i) => kinds.get(i.kind)?.traits.area && !kinds.get(i.kind)?.traits.area?.blocks)
      .map((i) => i.key),
  );
  for (const item of city.items) {
    if (seen.has(item.key)) issues.push(`item "${item.key}" is defined twice`);
    seen.add(item.key);
    const kind = kinds.get(item.kind);
    if (!kind) {
      issues.push(`item "${item.key}" is of unknown kind "${item.kind}"`);
      continue;
    }
    for (const t of ["place", "mover", "area", "line"] as const) {
      if (item.traits[t] && !kind.traits[t]) {
        issues.push(`item "${item.key}" sets ${t} but its kind "${kind.key}" isn't one`);
      }
    }
    if (kind.traits.place && !item.where.at) issues.push(`place "${item.key}" has no position`);
    if (kind.traits.place && item.where.district && !areas.has(item.where.district)) {
      issues.push(`place "${item.key}" is in unknown district "${item.where.district}"`);
    }
    if (kind.traits.area && item.where.polygon.length < 3) {
      issues.push(`area "${item.key}" needs a polygon of 3 or more points`);
    }
    if (kind.traits.line && item.where.line.length < 2) {
      issues.push(`line "${item.key}" needs 2 or more points`);
    }
  }
  return issues;
}
