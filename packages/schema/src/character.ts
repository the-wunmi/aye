/**
 * Characters: the people players live as. Each belongs to one player and one world, and
 * carries its money and needs between places.
 *
 * Who they are (name, look, body, money, needs) is a `PersonDef`, the same shape a place's
 * world spec uses for the people a model writes, so a player's character and a model's
 * people walk the same floors under the same rules. Its money and needs are the live state,
 * saved by the realm server whenever the character leaves a place.
 */
import { z } from "zod";
import { ArtifactHash } from "./artifact.ts";
import { Billed } from "./city-spec.ts";
import { CharacterId, UserId, WorldId } from "./ids.ts";
import { Timestamp } from "./primitives.ts";
import { PersonDef, SpecKey, WORLD_BOUNDS } from "./world-spec.ts";

export const Character = z.object({
  id: CharacterId,
  worldId: WorldId,
  ownerId: UserId,
  person: PersonDef,
  /** The start they chose (city spec), which says where home is. */
  start: SpecKey,
  /** The place they are in or last left, by city key; null before they first arrive. */
  place: SpecKey.nullable(),
  /** A trip under way: where to, and when they get there. Survives disconnecting. */
  transit: z.object({ to: SpecKey, arrivesAt: Timestamp }).nullable().default(null),
  /**
   * Their own vehicle when it's out with them (taken from home; it goes back when they get
   * home). What the world said of it when they set off; display text is the world's words.
   */
  vehicle: z
    .object({
      object: z.string().max(64),
      label: z.string().max(80),
      speedKmh: z.int().min(WORLD_BOUNDS.travelKmh.min).max(WORLD_BOUNDS.travelKmh.max),
    })
    .nullable()
    .default(null),
  /** Their home as they've made it: their own copy of the place, once they've changed it. */
  home: z
    .object({ place: SpecKey, scene: ArtifactHash, spec: ArtifactHash })
    .nullable()
    .default(null),
  /** Where they stand with the city's bills. */
  billed: Billed.default({ day: -1, owes: 0 }),
  updatedAt: Timestamp,
});
export type Character = z.infer<typeof Character>;

/** What a player picks when creating a character. Everything else comes from the city. */
export const NewCharacter = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[\p{L}\p{M}\p{N} .'-]+$/u, "letters, numbers, spaces and . ' -"),
  start: SpecKey,
  /** Which of the city's character looks. */
  look: z.int().min(0).max(31).default(0),
  /** Which of the city's outfits, when it has them. */
  outfit: z.int().min(0).max(31).default(0),
  skin: z.int().min(0).max(31),
  top: z.int().min(0).max(31),
  bottom: z.int().min(0).max(31),
  hair: z.int().min(0).max(31).default(0),
});
export type NewCharacter = z.infer<typeof NewCharacter>;
