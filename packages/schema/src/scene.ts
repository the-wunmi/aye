/**
 * The scene graph: the geometry of one place, from a description or a recording.
 *
 * A Scene is immutable data: where the ground, walls, openings, level changes and things are,
 * in the place's local frame, in millimetres, Y-up. It is edited through EditOps (place.ts).
 * Everything else (what things are, their state, what people can do, how it all looks) is in
 * the place's world spec, keyed by the ids here.
 *
 * Structure is explicit rather than a mesh because physics reasons about it: a 180 mm step at
 * the front door stops a wheelchair; a wall mesh would not say so.
 */
import { z } from "zod";
import { ArtifactRef } from "./artifact.ts";
import {
  CaptureId,
  LevelChangeId,
  LevelId,
  ObjectId,
  OpeningId,
  PortalId,
  SpaceId,
  WallId,
} from "./ids.ts";
import {
  Degrees,
  Label,
  LIMITS,
  Millimetres,
  Permille,
  Polygon,
  PositiveMillimetres,
  Size3,
  Transform,
  Vec2,
} from "./primitives.ts";

export const Level = z.object({
  id: LevelId,
  name: Label,
  elevationMm: Millimetres,
  footprint: Polygon,
});
export type Level = z.infer<typeof Level>;

/**
 * Walkable ground: a room, a road, a market floor. What it is and how it looks belong to the
 * place's world spec (written by a model); the scene only knows where it is and how high.
 */
export const Space = z.object({
  id: SpaceId,
  levelId: LevelId,
  /** Human description, e.g. "Front yard" or "Danfo park". Display only. */
  name: Label,
  polygon: Polygon,
  /** Floor height relative to the level elevation, e.g. a sunken living room or a raised kerb. */
  floorOffsetMm: Millimetres,
  /** Null for outdoor spaces. */
  ceilingMm: PositiveMillimetres.nullable(),
});
export type Space = z.infer<typeof Space>;

export const Wall = z.object({
  id: WallId,
  levelId: LevelId,
  a: Vec2,
  b: Vec2,
  thicknessMm: PositiveMillimetres,
  heightMm: PositiveMillimetres,
});
export type Wall = z.infer<typeof Wall>;

export const OpeningKind = z.enum(["door", "doorway", "gate", "window"]);
export type OpeningKind = z.infer<typeof OpeningKind>;

export const Opening = z.object({
  id: OpeningId,
  levelId: LevelId,
  kind: OpeningKind,
  /** The wall it sits in, or null for free-standing gates and gaps. */
  wallId: WallId.nullable(),
  /** Centre of the opening on the floor plane. */
  at: Vec2,
  yawDeg: Degrees,
  /** Narrowest clear width when fully open. */
  clearWidthMm: PositiveMillimetres,
  heightMm: PositiveMillimetres,
  /** Bottom of the opening above floor; 0 for doors, ~900 for windows. */
  sillMm: Millimetres.nonnegative(),
  /** Raised lip a wheel must roll over. */
  thresholdMm: Millimetres.nonnegative(),
  /** The spaces on either side; null means outside the scene (e.g. a portal side). */
  connects: z.tuple([SpaceId.nullable(), SpaceId.nullable()]),
});
export type Opening = z.infer<typeof Opening>;

export const LevelChangeKind = z.enum(["step", "stairs", "ramp", "kerb", "lift"]);
export type LevelChangeKind = z.infer<typeof LevelChangeKind>;

/**
 * A change in floor height that agents may or may not be able to cross. `from` is the
 * bottom edge centre, `to` the top edge centre; run length is their distance.
 */
export const LevelChange = z.object({
  id: LevelChangeId,
  kind: LevelChangeKind,
  fromLevelId: LevelId,
  toLevelId: LevelId,
  from: Vec2,
  to: Vec2,
  widthMm: PositiveMillimetres,
  riseMm: Millimetres.nonnegative(),
  stepCount: z.int().nonnegative().max(500),
  hasHandrail: z.boolean(),
});
export type LevelChange = z.infer<typeof LevelChange>;

/** A way in and out of the place. Where it leads isn't here: travel comes from the city spec. */
export const Portal = z.object({
  id: PortalId,
  levelId: LevelId,
  at: Vec2,
  yawDeg: Degrees,
  widthMm: PositiveMillimetres,
  label: Label,
});
export type Portal = z.infer<typeof Portal>;

/** Where in the source video an object was seen. Links generated content back to reality. */
export const Evidence = z.object({
  captureId: CaptureId,
  trackId: z.int().nonnegative().max(1_000_000),
  frameStart: z.int().nonnegative().max(10_000_000),
  frameEnd: z.int().nonnegative().max(10_000_000),
  confidence: Permille,
  mask: ArtifactRef.nullable(),
});
export type Evidence = z.infer<typeof Evidence>;

/**
 * A thing in the place: where it is, how big, and where it was seen. What kind of thing it is,
 * whether it is solid, what state it is in and what people can do with it are all in the
 * place's world spec, keyed by this id.
 */
export const SceneObject = z.object({
  id: ObjectId,
  /** Human description from the capture or the brief, e.g. "yellow danfo bus". */
  label: Label,
  levelId: LevelId,
  spaceId: SpaceId.nullable(),
  transform: Transform,
  size: Size3,
  evidence: Evidence.nullable(),
});
export type SceneObject = z.infer<typeof SceneObject>;

export const SCENE_FORMAT = "aye.scene" as const;
export const SCENE_SCHEMA_VERSION = 1 as const;

const SceneShape = z.object({
  format: z.literal(SCENE_FORMAT),
  schemaVersion: z.literal(SCENE_SCHEMA_VERSION),
  levels: z.array(Level).min(1).max(LIMITS.levels),
  spaces: z.array(Space).max(LIMITS.spaces),
  walls: z.array(Wall).max(LIMITS.walls),
  openings: z.array(Opening).max(LIMITS.openings),
  levelChanges: z.array(LevelChange).max(LIMITS.levelChanges),
  objects: z.array(SceneObject).max(LIMITS.objects),
  portals: z.array(Portal).max(LIMITS.portals),
  /** Where new characters appear; usually the front door portal. */
  entry: PortalId.nullable(),
});

/** Scene with referential integrity: unique ids and every reference resolves. */
export const Scene = SceneShape.superRefine((scene, ctx) => {
  const seen = new Set<string>();
  const collections = [
    ["levels", scene.levels],
    ["spaces", scene.spaces],
    ["walls", scene.walls],
    ["openings", scene.openings],
    ["levelChanges", scene.levelChanges],
    ["objects", scene.objects],
    ["portals", scene.portals],
  ] as const;
  for (const [name, items] of collections) {
    items.forEach((item, index) => {
      if (seen.has(item.id)) {
        ctx.addIssue({
          code: "custom",
          path: [name, index, "id"],
          message: `duplicate id ${item.id}`,
        });
      }
      seen.add(item.id);
    });
  }

  const levels = new Set<string>(scene.levels.map((l) => l.id));
  const spaces = new Set<string>(scene.spaces.map((s) => s.id));
  const walls = new Set<string>(scene.walls.map((w) => w.id));
  const portals = new Set<string>(scene.portals.map((p) => p.id));
  const ref = (ok: boolean, path: (string | number)[], what: string) => {
    if (!ok) ctx.addIssue({ code: "custom", path, message: `unknown ${what}` });
  };

  scene.spaces.forEach((s, i) => {
    ref(levels.has(s.levelId), ["spaces", i, "levelId"], "level");
  });
  scene.walls.forEach((w, i) => {
    ref(levels.has(w.levelId), ["walls", i, "levelId"], "level");
  });
  scene.portals.forEach((p, i) => {
    ref(levels.has(p.levelId), ["portals", i, "levelId"], "level");
  });
  scene.openings.forEach((o, i) => {
    ref(levels.has(o.levelId), ["openings", i, "levelId"], "level");
    if (o.wallId !== null) ref(walls.has(o.wallId), ["openings", i, "wallId"], "wall");
    o.connects.forEach((s, j) => {
      if (s !== null) ref(spaces.has(s), ["openings", i, "connects", j], "space");
    });
  });
  scene.levelChanges.forEach((c, i) => {
    ref(levels.has(c.fromLevelId), ["levelChanges", i, "fromLevelId"], "level");
    ref(levels.has(c.toLevelId), ["levelChanges", i, "toLevelId"], "level");
  });
  scene.objects.forEach((o, i) => {
    ref(levels.has(o.levelId), ["objects", i, "levelId"], "level");
    if (o.spaceId !== null) ref(spaces.has(o.spaceId), ["objects", i, "spaceId"], "space");
  });
  if (scene.entry !== null) ref(portals.has(scene.entry), ["entry"], "portal");
});
export type Scene = z.infer<typeof Scene>;
