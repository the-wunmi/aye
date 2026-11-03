/**
 * Branded, prefixed identifiers.
 *
 * Two kinds of id share one format (`<prefix>_<[0-9a-z]+>`):
 * - Root records a person creates (users, worlds, places, captures) get random ids.
 * - Entities produced by the pipeline (levels, spaces, objects…) get ids *derived* from
 *   their provenance (see `@aye/artifacts` deriveId), so re-running a stage yields the same
 *   ids and user edits keyed by id survive regeneration.
 */
import { z } from "zod";

function prefixedId<const P extends string>(prefix: P) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_[0-9a-z]{3,40}$`), `expected id like ${prefix}_xxxxxxxx`)
    .brand<`${P}Id`>();
}

export const ID_PREFIX = {
  user: "usr",
  world: "wld",
  place: "plc",
  capture: "cap",
  level: "lvl",
  space: "spc",
  wall: "wal",
  opening: "opn",
  levelChange: "lch",
  object: "obj",
  portal: "prt",
  character: "chr",
  run: "run",
  message: "msg",
} as const;

export type IdKind = keyof typeof ID_PREFIX;

export const UserId = prefixedId(ID_PREFIX.user);
export const WorldId = prefixedId(ID_PREFIX.world);
export const PlaceId = prefixedId(ID_PREFIX.place);
export const CaptureId = prefixedId(ID_PREFIX.capture);
export const LevelId = prefixedId(ID_PREFIX.level);
export const SpaceId = prefixedId(ID_PREFIX.space);
export const WallId = prefixedId(ID_PREFIX.wall);
export const OpeningId = prefixedId(ID_PREFIX.opening);
export const LevelChangeId = prefixedId(ID_PREFIX.levelChange);
export const ObjectId = prefixedId(ID_PREFIX.object);
export const PortalId = prefixedId(ID_PREFIX.portal);
export const CharacterId = prefixedId(ID_PREFIX.character);
export const RunId = prefixedId(ID_PREFIX.run);

export type UserId = z.infer<typeof UserId>;
export type WorldId = z.infer<typeof WorldId>;
export type PlaceId = z.infer<typeof PlaceId>;
export type CaptureId = z.infer<typeof CaptureId>;
export type LevelId = z.infer<typeof LevelId>;
export type SpaceId = z.infer<typeof SpaceId>;
export type WallId = z.infer<typeof WallId>;
export type OpeningId = z.infer<typeof OpeningId>;
export type LevelChangeId = z.infer<typeof LevelChangeId>;
export type ObjectId = z.infer<typeof ObjectId>;
export type PortalId = z.infer<typeof PortalId>;
export type CharacterId = z.infer<typeof CharacterId>;
export type RunId = z.infer<typeof RunId>;
