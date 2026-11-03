/**
 * What covers a real city's ground (OpenStreetMap, ODbL): its water (the sea, lagoons,
 * rivers) and its land use (built-up, industry, green), so a real city's map shows where it
 * is wet and where it is built instead of a blank plain under its roads.
 *
 * Its own content-addressed artifact the city points to (it can be megabytes), on the same
 * metre frame as the road network: metres east and south of the north-west corner. The kinds
 * are OpenStreetMap's own vocabulary, grouped for drawing; they say what the ground is, never
 * what a world does with it. Every array is bounded.
 */
import { z } from "zod";

export const LAND_COVER_FORMAT = "aye.land";

/** What a ring covers, in drawing order (later kinds are drawn over earlier ones). */
export const LAND_KINDS = ["built", "industrial", "green", "water"] as const;
export type LandKind = (typeof LAND_KINDS)[number];

export const LAND_BOUNDS = {
  extentM: 80_000,
  rings: 60_000,
  points: 800_000,
} as const;

export const LandCover = z.strictObject({
  format: z.literal(LAND_COVER_FORMAT),
  version: z.literal(1),
  source: z.literal("openstreetmap"),
  /** Shown wherever it is drawn: the licence requires it. */
  attribution: z.literal("© OpenStreetMap contributors (ODbL)"),
  origin: z.strictObject({
    lat: z.number().min(-85).max(85),
    lon: z.number().min(-180).max(180),
  }),
  extentM: z.tuple([
    z.int().min(100).max(LAND_BOUNDS.extentM),
    z.int().min(100).max(LAND_BOUNDS.extentM),
  ]),
  /** Per ring: its kind (an index into LAND_KINDS). */
  kinds: z
    .array(
      z
        .int()
        .min(0)
        .max(LAND_KINDS.length - 1),
    )
    .max(LAND_BOUNDS.rings),
  /** Per ring: 1 if it is a hole in the last ring before it that isn't (an island). */
  holes: z.array(z.int().min(0).max(1)).max(LAND_BOUNDS.rings),
  /** Per ring, where its points start in `points` (x, z pairs); one more than rings. */
  ringAt: z.array(z.int().min(0)).max(LAND_BOUNDS.rings + 1),
  points: z.array(z.int().min(0).max(LAND_BOUNDS.extentM)).max(LAND_BOUNDS.points * 2),
});
export type LandCover = z.infer<typeof LandCover>;

/** Problems a land cover's structure has (rings that don't line up with their points). */
export function landIssues(l: LandCover): string[] {
  const issues: string[] = [];
  const rings = l.kinds.length;
  if (l.holes.length !== rings) issues.push("holes must have one entry per ring");
  if (l.ringAt.length !== rings + 1) issues.push("ringAt must have one entry per ring, plus one");
  for (let r = 0; r < l.ringAt.length - 1; r++) {
    if ((l.ringAt[r + 1] as number) - (l.ringAt[r] as number) < 3) {
      issues.push(`ring ${r} has fewer than 3 points`);
      break;
    }
  }
  if ((l.ringAt[l.ringAt.length - 1] ?? 0) * 2 !== l.points.length) {
    issues.push("ringAt must end where points do");
  }
  if (l.points.length % 2 !== 0) issues.push("points come in x, z pairs");
  if (l.holes[0] === 1) issues.push("the first ring can't be a hole");
  return issues;
}
