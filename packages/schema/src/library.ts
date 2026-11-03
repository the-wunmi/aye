/**
 * The asset library: real 3D models and surface textures a model may *choose* for what it
 * wrote. Primitives stay the fallback and the source of truth for
 * state-specific looks; an asset only changes how a thing, a person or a surface is drawn.
 *
 * The catalog is curated by code (`pnpm library:fetch`), never by a model: every entry is an
 * openly licensed (CC0) file we fetched, pinned by SHA-256 and measured. A model only ever
 * refers to an entry by id, and every id it writes is checked against this catalog, so a spec
 * can't point at a file, a URL or a path. Labels and tags describe what an entry looks like
 * (vocabulary for choosing), not what anything in a world *is* or does: a world can still be
 * anything, and when nothing in the library fits, it is drawn from its primitives.
 */
import { z } from "zod";
import { Label } from "./primitives.ts";

/** A library entry's id: lower snake case, stable across fetches. */
export const AssetId = z.string().regex(/^[a-z][a-z0-9_]{1,47}$/, "asset id, e.g. plastic_chair");
export type AssetId = z.infer<typeof AssetId>;

/** A path under the library root: no traversal, no scheme, only our file types. */
const LibraryPath = z
  .string()
  .max(120)
  .regex(/^[a-z0-9_]+(\/[a-z0-9_]+)*\.(glb|jpg)$/, "a library-relative file path");

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const Tag = z.string().regex(/^[a-z][a-z0-9 -]{0,23}$/);

const Provenance = z.object({
  /** Where it was fetched from (for credits and re-fetching). */
  source: z.url({ protocol: /^https$/ }),
  author: Label,
  licence: z.literal("CC0-1.0"),
});

/** A model of a thing: furniture, appliances, vehicles, plants, stalls. */
export const ThingAsset = Provenance.extend({
  id: AssetId,
  category: z.literal("thing"),
  label: Label.min(1),
  tags: z.array(Tag).max(8),
  file: LibraryPath,
  sha256: Sha256,
  /** Its own size as drawn, front facing +z: width (x), height (y), depth (z), in mm. */
  sizeMm: z.tuple([z.int().min(1), z.int().min(1), z.int().min(1)]),
  /** Photoreal (textured) or low-poly (flat colours): models keep a place consistent. */
  style: z.enum(["photoreal", "lowpoly"]),
});
export type ThingAsset = z.infer<typeof ThingAsset>;

/**
 * A rigged person (an outfit on a shared skeleton). Its materials are named; `slots` says
 * which take a person's own colours, so one outfit suits anyone.
 */
export const OutfitAsset = Provenance.extend({
  id: AssetId,
  category: z.literal("outfit"),
  label: Label.min(1),
  tags: z.array(Tag).max(8),
  file: LibraryPath,
  sha256: Sha256,
  heightMm: z.int().min(900).max(2400),
  slots: z.object({
    skin: z.array(Label).max(4),
    hair: z.array(Label).max(4),
    top: z.array(Label).max(4),
    bottom: z.array(Label).max(4),
  }),
});
export type OutfitAsset = z.infer<typeof OutfitAsset>;

/** A tiling texture for floors, ground and walls. */
export const SurfaceAsset = Provenance.extend({
  id: AssetId,
  category: z.literal("surface"),
  label: Label.min(1),
  tags: z.array(Tag).max(8),
  /** Colour map. */
  file: LibraryPath,
  sha256: Sha256,
  /** How much floor or wall one repeat of the texture covers, in mm. */
  tileMm: z.int().min(100).max(30_000),
  /** Painted surfaces take the spec's colour; natural ones (wood, tiles, sand) keep theirs. */
  tintable: z.boolean(),
  use: z.enum(["floor", "wall", "both"]),
});
export type SurfaceAsset = z.infer<typeof SurfaceAsset>;

/** Shared animations for every outfit (they share one skeleton): clip names → purpose. */
export const AnimationSet = Provenance.extend({
  file: LibraryPath,
  sha256: Sha256,
  clips: z.object({
    idle: Label,
    walk: Label,
    run: Label,
    interact: Label,
    wave: Label,
  }),
});
export type AnimationSet = z.infer<typeof AnimationSet>;

export const LibraryCatalog = z.object({
  format: z.literal("aye.library"),
  version: z.literal(1),
  things: z.array(ThingAsset).max(400),
  outfits: z.array(OutfitAsset).max(64),
  surfaces: z.array(SurfaceAsset).max(64),
  animations: AnimationSet.nullable(),
});
export type LibraryCatalog = z.infer<typeof LibraryCatalog>;

/** Fast lookups by id, so specs can be checked against the catalog. */
export interface LibraryIndex {
  catalog: LibraryCatalog;
  thing(id: string): ThingAsset | undefined;
  outfit(id: string): OutfitAsset | undefined;
  surface(id: string): SurfaceAsset | undefined;
}

export function libraryIndex(catalog: LibraryCatalog): LibraryIndex {
  const things = new Map(catalog.things.map((a) => [a.id, a]));
  const outfits = new Map(catalog.outfits.map((a) => [a.id, a]));
  const surfaces = new Map(catalog.surfaces.map((a) => [a.id, a]));
  return {
    catalog,
    thing: (id) => things.get(id),
    outfit: (id) => outfits.get(id),
    surface: (id) => surfaces.get(id),
  };
}
