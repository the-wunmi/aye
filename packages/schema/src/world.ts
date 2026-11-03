/**
 * Worlds: a playable city, its places, and the settings they share.
 *
 * A world's city spec (written by a model, see city-spec.ts) says what the city is: its map,
 * travel, needs, interface. Each place on it is built separately (scene + world spec) and
 * pinned here to an exact revision, so someone else editing their place never silently changes
 * your world.
 */
import { z } from "zod";
import { ArtifactHash } from "./artifact.ts";
import { TRIP_MAX_REAL_SEC } from "./city-spec.ts";
import { PlaceId, UserId, WorldId } from "./ids.ts";
import { CurrencyCode, PositiveMillimetres, Timestamp } from "./primitives.ts";
import { SpecKey } from "./world-spec.ts";

/** A place built for the city, under the key the city spec gives it. */
export const WorldPlace = z.object({
  key: SpecKey,
  placeId: PlaceId,
  revision: ArtifactHash,
});
export type WorldPlace = z.infer<typeof WorldPlace>;

/** How a world's simulation runs. What happens in it comes from its specs. */
/** The default longest someone being played spends on themselves, real seconds. */
export const ACTION_MAX_REAL_SEC = 60;
/** What the realm plays needs filling at: enough that upkeep leaves most of a day for living. */
export const NEED_FILL_PERMILLE = 3000;

export const WorldSettings = z.object({
  /** Seed for every random draw in this world's simulation. */
  seed: z.int().nonnegative(),
  /** Navigation grid resolution. 100 mm resolves door widths and kerbs. */
  gridCellMm: PositiveMillimetres,
  /** Simulated wall-clock start, e.g. 06:00 on day 1. */
  startMinuteOfDay: z.int().min(0).max(1439),
  /**
   * Shared worlds run in real time at this many simulated seconds per real second (one tick
   * is one simulated second). 30: a day is 48 real minutes, so nobody waits long for morning.
   * People still walk at their body's speed in real time, so crossing a room takes simulated
   * minutes.
   */
  ticksPerRealSecond: z.int().min(1).max(60).default(30),
  /**
   * The longest a trip between places may take, real seconds: every way to get around is
   * sped up by one factor so the slowest of them, across the city's farthest two places,
   * takes no longer (their order stays true). 0: trips take as long as in life.
   */
  tripMaxRealSec: z.int().min(0).max(3600).default(TRIP_MAX_REAL_SEC),
  /**
   * The longest anything takes someone being played, real seconds: a night's sleep or a long
   * shift shouldn't be minutes watching a bar (see `heldActionTicks`). 0: as long as in life.
   */
  actionMaxRealSec: z.int().min(0).max(3600).default(ACTION_MAX_REAL_SEC),
  /**
   * How much more a need fills for people here than the world's numbers say, permille. A city
   * day is 48 real minutes and needs run down by its clock, but someone can only do one thing
   * at a time, so at life's rates upkeep would take all of their day. Absent: as written.
   */
  needFillPermille: z.int().min(1000).max(5000).optional(),
});
export type WorldSettings = z.infer<typeof WorldSettings>;

/**
 * How many ticks something takes someone being played. It's shortened to `actionMaxRealSec` and
 * does the same for you in all: the sim speeds up its effects to match, so a long shift pays the
 * same and tires you the same in a minute of watching. Your body is what limits how much you can
 * work, not your patience. What takes you away keeps its full length: that would skip the trip.
 */
export function heldActionTicks(
  action: { durationMin: number; leaves?: unknown; income?: number },
  settings: { ticksPerRealSecond: number; actionMaxRealSec?: number },
): number {
  const full = action.durationMin * 60;
  // Going somewhere keeps its length; being paid to be out is a shift like any other.
  if (action.leaves && !action.income) return full;
  // Worlds made before the setting existed get its default.
  const maxRealSec = settings.actionMaxRealSec ?? ACTION_MAX_REAL_SEC;
  if (maxRealSec <= 0) return full;
  return Math.min(full, Math.max(1, maxRealSec * settings.ticksPerRealSecond));
}

export const WorldStatus = z.enum(["building", "ready", "failed"]);
export type WorldStatus = z.infer<typeof WorldStatus>;

export const WorldVisibility = z.enum(["private", "public"]);
export type WorldVisibility = z.infer<typeof WorldVisibility>;

export const World = z.object({
  id: WorldId,
  ownerId: UserId,
  name: z.string().min(1).max(120),
  currency: CurrencyCode,
  visibility: WorldVisibility,
  status: WorldStatus,
  /** The city spec, once written. */
  city: ArtifactHash.nullable(),
  places: z.array(WorldPlace).max(1_000),
  settings: WorldSettings,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type World = z.infer<typeof World>;
