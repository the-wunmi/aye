/**
 * Anchoring a place's local frame to the real world.
 *
 * A place's scene lives in its own local metric frame (millimetres). The optional GeoAnchor
 * maps that frame's origin onto WGS84 so places can be laid out on a map, connected to
 * neighbours, and later aligned with open map data (e.g. OpenStreetMap) for planning work.
 */
import { z } from "zod";
import { Degrees } from "./primitives.ts";

/**
 * How much location detail is kept. Homes default to `area` so a shared world never leaks
 * an exact address; only the owner's private copy may hold `exact`.
 */
export const GeoPrecision = z.enum(["exact", "street", "area", "city", "none"]);
export type GeoPrecision = z.infer<typeof GeoPrecision>;

export const GeoAnchor = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** Bearing of the local −Z axis, clockwise from true north. 0 means −Z points north. */
  bearingDeg: Degrees,
  precision: GeoPrecision,
});
export type GeoAnchor = z.infer<typeof GeoAnchor>;
