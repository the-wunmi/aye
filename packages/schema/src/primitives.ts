/**
 * Primitive value types shared by every schema.
 *
 * Conventions:
 * - Lengths are integer millimetres. Integers hash canonically, never drift, and give
 *   ±2,147 km of range in an int32 — enough for a town, precise enough for a door threshold.
 * - Space is right-handed, Y-up (matches three.js). The floor plane is (x, z).
 * - Angles are integer degrees in [0, 360).
 * - Money is integer minor units (kobo, cents) with an ISO-4217 currency on the owning world.
 * - Ratios and needs are integer permille (0..1000).
 */
import { z } from "zod";

/**
 * Hard upper bounds on every collection and string. All input is untrusted (users, clients,
 * and model output alike), so nothing unbounded may reach storage, the sim or the renderer.
 */
export const LIMITS = {
  /** ±100 km from the place origin. Far beyond any single capture. */
  coordMm: 100_000_000,
  polygonVertices: 512,
  label: 200,
  text: 2_000,
  levels: 32,
  spaces: 1_000,
  walls: 5_000,
  openings: 2_000,
  levelChanges: 1_000,
  objects: 10_000,
  portals: 64,
  edits: 50_000,
  attributes: 32,
  jsonDepthBytes: 8_192,
} as const;

/** Short human-facing text. Rendered as text only, never as HTML. */
export const Label = z.string().max(LIMITS.label);

export const Millimetres = z
  .int()
  .min(-LIMITS.coordMm)
  .max(LIMITS.coordMm)
  .describe("Length in integer millimetres");
export const PositiveMillimetres = z.int().positive().max(LIMITS.coordMm);
export const Degrees = z.int().min(0).max(359).describe("Angle in integer degrees, [0, 360)");
export const Permille = z.int().min(0).max(1000).describe("Ratio in integer permille, 0..1000");
export const MinorUnits = z
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)
  .describe("Money in integer minor units of the world currency");
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, "ISO-4217 currency code");
export const SimMinutes = z
  .int()
  .nonnegative()
  .max(60 * 24 * 365)
  .describe("Duration in simulated minutes");
export const Timestamp = z.iso.datetime({ offset: true });

/** Floor-plane point `[x, z]` in millimetres. */
export const Vec2 = z.tuple([Millimetres, Millimetres]);
/** World-space point `[x, y, z]` in millimetres; y is up. */
export const Vec3 = z.tuple([Millimetres, Millimetres, Millimetres]);
/** Simple polygon on the floor plane, counter-clockwise, without a repeated closing vertex. */
export const Polygon = z.array(Vec2).min(3).max(LIMITS.polygonVertices);

/** Axis-aligned extents in the object's local frame: width (x), depth (z), height (y). */
export const Size3 = z.object({
  w: PositiveMillimetres,
  d: PositiveMillimetres,
  h: PositiveMillimetres,
});

/**
 * Where an object is on its level: its footprint's centre, the height of its bottom above the
 * floor (0 for what stands on it; a shelf on a wall is higher), plus yaw about +Y.
 */
export const Transform = z.object({
  position: Vec3,
  yawDeg: Degrees,
});

/**
 * Lowercase dotted identifier for catalog data, e.g. `core.bed` or `ng.buka_counter`.
 * The first segment is the namespace of the catalog pack that defines it.
 */
export const CatalogKey = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/, "namespaced catalog key, e.g. core.bed");

/** Free-form JSON value, used for opaque parameters that are hashed canonically. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const JsonValue: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string().max(LIMITS.text),
    z.number().refine(Number.isFinite, "must be finite"),
    z.boolean(),
    z.null(),
    z.array(JsonValue).max(256),
    z.record(z.string().max(64), JsonValue),
  ]),
);
/** Bounded JSON: also capped by serialised size so deep or wide payloads cannot slip through. */
export const Json: z.ZodType<Json> = JsonValue.refine(
  (v) => JSON.stringify(v).length <= LIMITS.jsonDepthBytes,
  `JSON value larger than ${LIMITS.jsonDepthBytes} bytes`,
);

export type Vec2 = z.infer<typeof Vec2>;
export type Vec3 = z.infer<typeof Vec3>;
export type Polygon = z.infer<typeof Polygon>;
export type Size3 = z.infer<typeof Size3>;
export type Transform = z.infer<typeof Transform>;
export type CatalogKey = z.infer<typeof CatalogKey>;
