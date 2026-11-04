/**
 * Data contracts between pipeline stages and model providers.
 *
 * Everything a model returns is untrusted input: it may be wrong, oversized, or steered by
 * text in the video ("ignore your instructions…" painted on a wall). So every contract is a
 * strict, bounded schema; unknown keys are rejected; numbers are finite and range-limited;
 * free text is length-capped and only ever displayed, never interpreted.
 */
import {
  ArtifactRef,
  CurrencyCode,
  Label,
  LevelChangeKind,
  LIMITS,
  OpeningKind,
  WAYS,
  WORD_KEYS,
  type WordKey,
} from "@aye/schema";
import { z } from "zod";

/** Metres, as models naturally reason about rooms. ±1 km is far beyond any one capture. */
const Metres = z.number().finite().min(-1000).max(1000);
const PositiveMetres = z.number().finite().positive().max(1000);
const PointM = z.tuple([Metres, Metres]);
const ModelKey = z.string().regex(/^[a-z0-9_-]{1,32}$/, "short model-local key");

// ── Frame sampling ──────────────────────────────────────────────────────────────────

export const FrameSet = z.strictObject({
  frames: z
    .array(
      z.strictObject({
        index: z.int().nonnegative().max(1_000_000),
        timeMs: z.int().nonnegative(),
        image: ArtifactRef,
      }),
    )
    .min(1)
    .max(512),
  widthPx: z.int().positive().max(8192),
  heightPx: z.int().positive().max(8192),
});
export type FrameSet = z.infer<typeof FrameSet>;

declare const redacted: unique symbol;
/**
 * Frames with every private box hidden (`pixelRedactor`). Only this type may be handed to model
 * providers after the segmenter, or used for generated assets; the types enforce it at call sites.
 */
export type RedactedFrameSet = FrameSet & { readonly [redacted]: true };

// ── Segmentation and tracking (e.g. SAM 3.x) ───────────────────────────────────────

/**
 * Names for what counts as private. Nothing reads this list at runtime: what gets found is up to
 * the segmenter (`metaSegmenter` asks for faces and license plates).
 */
export const PRIVATE_CLASSES = [
  "person",
  "face",
  "license_plate",
  "screen_content",
  "document",
] as const;
export const PrivateClass = z.enum(PRIVATE_CLASSES);

export const Track = z.strictObject({
  trackId: z.int().nonnegative().max(1_000_000),
  /** Open-vocabulary concept the segmenter was prompted with or returned. */
  concept: Label.min(1),
  private: z.boolean(),
  frameStart: z.int().nonnegative(),
  frameEnd: z.int().nonnegative(),
  /** The segmenter's raw output this detection came from. */
  masks: ArtifactRef,
  /** Best single frame for cropping this object, and its box in pixels [x, y, w, h]. */
  bestFrame: z.int().nonnegative(),
  bbox: z.tuple([
    z.int().nonnegative(),
    z.int().nonnegative(),
    z.int().positive(),
    z.int().positive(),
  ]),
  confidence: z.number().min(0).max(1),
});
export type Track = z.infer<typeof Track>;

export const TrackSet = z.strictObject({ tracks: z.array(Track).max(2_000) });
export type TrackSet = z.infer<typeof TrackSet>;

// ── Scene understanding (e.g. Muse Spark) ───────────────────────────────────────────

/**
 * The layout of a place, from frames or a description: ground, walls, openings, level changes,
 * things and exits. Geometry only; what things are and do is the world spec's job. It does not
 * decide ids. Coordinates are metres in a frame the model chooses, floor plane (x, z), which
 * the assembler normalises.
 */
export const SceneUnderstanding = z.strictObject({
  place: z.strictObject({
    name: z.string().max(120),
    summary: z.string().max(500),
    /** ISO 4217 code of the money used there, as the model judges it. */
    currency: CurrencyCode,
  }),
  spaces: z
    .array(
      z.strictObject({
        key: ModelKey,
        name: Label,
        polygon: z.array(PointM).min(3).max(64),
        floorOffsetM: Metres,
        outdoor: z.boolean(),
      }),
    )
    .min(1)
    .max(64),
  walls: z.array(z.strictObject({ a: PointM, b: PointM, heightM: PositiveMetres })).max(512),
  openings: z
    .array(
      z.strictObject({
        key: ModelKey,
        kind: OpeningKind,
        at: PointM,
        alongDeg: z.number().finite().min(-360).max(360),
        clearWidthM: PositiveMetres,
        thresholdM: z.number().finite().min(0).max(1),
        between: z.tuple([ModelKey.nullable(), ModelKey.nullable()]),
      }),
    )
    .max(256),
  levelChanges: z
    .array(
      z.strictObject({
        key: ModelKey,
        kind: LevelChangeKind,
        from: PointM,
        to: PointM,
        widthM: PositiveMetres,
        riseM: z.number().finite().min(0).max(50),
        steps: z.int().min(0).max(500),
        handrail: z.boolean(),
      }),
    )
    .max(128),
  objects: z
    .array(
      z.strictObject({
        /**
         * The object's number in this answer: its id derives from it, and one that matches a
         * private track is dropped in assembly.
         */
        trackId: z.int().nonnegative().max(1_000_000),
        label: Label.min(1),
        spaceKey: ModelKey.nullable(),
        at: PointM,
        yawDeg: z.number().finite().min(-360).max(360),
        sizeM: z.tuple([PositiveMetres, PositiveMetres, PositiveMetres]),
        /** How far its bottom is above the floor: on a counter, hung on a wall. */
        aboveFloorM: z.number().finite().min(0).max(20).default(0),
      }),
    )
    .max(2_000),
  exits: z
    .array(
      z.strictObject({
        key: ModelKey,
        at: PointM,
        alongDeg: z.number().finite(),
        widthM: PositiveMetres,
        label: Label,
      }),
    )
    .max(16),
});
export type SceneUnderstanding = z.infer<typeof SceneUnderstanding>;

// ── World authoring (e.g. Muse Spark) ───────────────────────────────────────────────

/**
 * What the world author is shown: the place's layout by index (so the model never handles
 * ids), the description it came from, and the money people there use. Labels and the
 * description may come from a video or a user, so prompts quote them as data.
 */
export const WorldBrief = z.strictObject({
  name: z.string().max(120),
  summary: z.string().max(500),
  /** The user's own words, when the place started from a description. */
  description: z.string().max(4_000),
  currency: CurrencyCode,
  /** What an hour of ordinary work pays in its city, minor units (0: not known; judge it). */
  hourPay: z.int().min(0).max(1_000_000_000),
  /** The city it belongs to, in a line, so the place fits (empty for a place on its own). */
  city: z.string().max(300),
  /** A real place someone filmed: it holds only what's really there, and who they say is. */
  filmed: z.boolean().default(false),
  /** What stays with people wherever they go: use these, and add none. */
  marks: z
    .array(
      z.strictObject({ key: z.string().max(32), label: Label, max: z.int(), shown: z.boolean() }),
    )
    .max(16)
    .default([]),
  /**
   * The needs everyone in the city has. When present, the world uses exactly these keys (and
   * may add a few of its own); people carry them from place to place.
   */
  needs: z
    .array(
      z.strictObject({
        key: z.string().max(32),
        label: Label,
        decayPerHour: z.int(),
        whenEmpty: z
          .strictObject({
            payPermille: z.int(),
            walkPermille: z.int(),
            feeling: Label,
          })
          .optional(),
      }),
    )
    .max(12),
  spaces: z
    .array(z.strictObject({ index: z.int().nonnegative(), name: Label, outdoor: z.boolean() }))
    .max(LIMITS.spaces),
  objects: z
    .array(
      z.strictObject({
        index: z.int().nonnegative(),
        label: Label,
        space: Label.nullable(),
        sizeM: z.tuple([PositiveMetres, PositiveMetres, PositiveMetres]),
      }),
    )
    .max(LIMITS.objects),
});
export type WorldBrief = z.infer<typeof WorldBrief>;

/** Wide sanity bounds only; `compileWorld` clamps to `WORLD_BOUNDS` (code decides balance). */
const Int = z.int().min(-1_000_000_000).max(1_000_000_000);
const Name = z.string().max(80);
const Line = z.string().max(300);

/** A test on the thing's own var, or (op "available") on a resource named in `var`. */
export const DraftCondition = z.strictObject({
  var: Name,
  op: z.enum(["eq", "ne", "gte", "lte", "available"]),
  value: Int,
});
export type DraftCondition = z.infer<typeof DraftCondition>;

const DraftPrimitive = z.enum([
  "box",
  "rounded_box",
  "cylinder",
  "sphere",
  "hemisphere",
  "cone",
  "capsule",
  "torus",
  "wedge",
]);

/** One primitive of a look, flat: centre x y z, size w h d, rotation rx ry rz, colour. */
export const DraftSolid = z.strictObject({
  shape: DraftPrimitive,
  x: Int,
  y: Int,
  z: Int,
  w: Int,
  h: Int,
  d: Int,
  rx: Int,
  ry: Int,
  rz: Int,
  colour: z.string().max(16),
  /** Gives off light: lamps, screens, neon, flames. */
  glow: z.boolean(),
});
export type DraftSolid = z.infer<typeof DraftSolid>;

/** A person's primitive, in millimetres from their feet, tagged with the part it moves with. */
export const DraftPersonShape = DraftSolid.extend({
  part: z.enum(["body", "head", "arm_left", "arm_right", "leg_left", "leg_right"]),
});
export type DraftPersonShape = z.infer<typeof DraftPersonShape>;

export const DraftKind = z.strictObject({
  key: Name,
  label: Name,
  solid: z.boolean(),
  /** Carries its owner between the city's places at this km/h; 0 if it doesn't. */
  travelKmh: Int,
  note: Line,
  vars: z.array(z.strictObject({ key: Name, label: Name, max: Int, initial: Int })).max(12),
  actions: z
    .array(
      z.strictObject({
        key: Name,
        label: Name,
        durationMin: Int,
        capacity: Int,
        cost: Int,
        income: Int,
        requires: z.array(DraftCondition).max(8),
        needs: z.array(z.strictObject({ need: Name, perHour: Int })).max(12),
        /** What finishing it does to the marks of whoever did it. */
        marks: z
          .array(z.strictObject({ mark: Name, by: Int }))
          .max(12)
          .default([]),
        /** How it can turn out, one chosen by chance when it finishes; empty: always the same. */
        outcomes: z
          .array(
            z.strictObject({
              weight: Int,
              /** A mark that makes this outcome likelier, and by how much per point; or "". */
              favours: Name,
              perPoint: Int,
              say: z.string().max(160),
              money: Int,
              marks: z.array(z.strictObject({ mark: Name, by: Int })).max(6),
            }),
          )
          .max(4)
          .default([]),
        /** The marks someone needs to start it. */
        asks: z
          .array(z.strictObject({ mark: Name, op: z.enum(["gte", "lte"]), value: Int }))
          .max(8)
          .default([]),
        sets: z.array(z.strictObject({ var: Name, value: Int, forMin: Int })).max(12),
        leaves: z.enum(["no", "alone", "with_thing"]),
        pose: z.enum(["stand", "sit", "lie", "inside"]),
        /** Sitting or lying on the thing itself, not at or beside it. */
        on: z.boolean(),
      }),
    )
    .max(16),
  supplies: z
    .array(z.strictObject({ resource: Name, when: z.array(DraftCondition).max(8) }))
    .max(8),
  look: z
    .array(
      z.strictObject({
        shape: DraftPrimitive,
        x: Int,
        y: Int,
        z: Int,
        w: Int,
        h: Int,
        d: Int,
        rx: Int,
        ry: Int,
        rz: Int,
        colour: z.string().max(16),
        glow: z.boolean(),
        when: z.array(DraftCondition).max(8),
      }),
    )
    .max(40),
});
export type DraftKind = z.infer<typeof DraftKind>;

/**
 * What the world author returns. Shaped for constrained decoding: every field required, flat
 * objects, no maps, no recursion. The model names things and picks numbers; code turns names
 * into keys, objects and spaces back into ids, and every number into a bounded one.
 */
export const WorldDraft = z.strictObject({
  name: Name,
  summary: z.string().max(500),
  /** What an hour of ordinary work pays here, minor units (the brief's, if it gives one). */
  hourPay: Int,
  livedIn: z.boolean(),
  needs: z.array(z.strictObject({ key: Name, label: Name, decayPerHour: Int })).max(24),
  resources: z
    .array(
      z.strictObject({
        key: Name,
        label: Name,
        publicSupply: z.boolean(),
        uptimePermille: Int,
        meanOutageMin: Int,
      }),
    )
    .max(16),
  kinds: z.array(DraftKind).max(96),
  things: z
    .array(
      z.strictObject({
        object: z.int().nonnegative().max(LIMITS.objects),
        kind: Name,
        state: z.array(z.strictObject({ var: Name, value: Int })).max(12),
        /** Whose it is (a person's key), or "" if nobody's in particular. */
        owner: Name,
      }),
    )
    .max(LIMITS.objects),
  people: z
    .array(
      z.strictObject({
        key: Name,
        name: Name,
        about: Line,
        skin: z.string().max(16),
        top: z.string().max(16),
        bottom: z.string().max(16),
        hair: z.string().max(16),
        accent: z.string().max(16),
        heightMm: Int,
        look: z.array(DraftPersonShape).max(64),
        widthMm: Int,
        stepMm: Int,
        stairs: z.boolean(),
        slopePermille: Int,
        speedMmPerS: Int,
        seated: z.boolean(),
        money: Int,
        needs: z.array(z.strictObject({ need: Name, start: Int })).max(24),
      }),
    )
    .max(16),
  ground: z
    .array(
      z.strictObject({
        space: z.int().nonnegative().max(LIMITS.spaces),
        colour: z.string().max(16),
      }),
    )
    .max(LIMITS.spaces),
  wallColour: z.string().max(16),
});
export type WorldDraft = z.infer<typeof WorldDraft>;

// ── City authoring ──────────────────────────────────────────────────────────────────

/** What the city author is shown: someone's words for the city they want to play. */
export const CityBrief = z.strictObject({
  description: z.string().max(4_000),
});
export type CityBrief = z.infer<typeof CityBrief>;

const Hex = z.string().max(16);
const Xz = z.tuple([Int, Int]);

/** A tap target, flat: `target` names an app, place or panel for open_app, show_place, panel. */
export const DraftIntent = z.strictObject({
  do: z.enum(["none", "open_app", "show_place", "map", "panel", "tour"]),
  target: Name,
});

export const DraftWidget = z.strictObject({
  type: z.enum([
    "brand",
    "wallet",
    "doing",
    "resources",
    "ticker",
    "presence",
    "chat",
    "people",
    "feed",
    "panel",
    "life",
    "plan",
    "trip",
    "threads",
    "clock",
    "needs",
    "text",
    "button",
  ]),
  /** clock: digital | sun. needs: bars | rings | chips. */
  style: Name,
  /** needs: all | lowest3. */
  show: z.enum(["all", "lowest3"]),
  text: Line,
  tone: z.enum(["plain", "muted", "accent"]),
  /** button: its label. panel: which panel it opens (by name). */
  label: Name,
  icon: Hex,
  intent: DraftIntent,
});

export const DraftBlock = z.strictObject({
  type: z.enum(["heading", "text", "stat", "list", "button"]),
  text: Line,
  label: Name,
  /** stat: what it shows. */
  value: z.enum(["wallet", "clock", "place", "players_online", "name", "doing", "need"]),
  /** stat value "need", or list source "actions": which need (name), or "". */
  need: Name,
  /** list: what it lists. */
  source: z.enum(["actions", "places", "travel", "people", "players", "headlines", "events"]),
  /** actions: pays | costs | any. */
  filter: z.enum(["pays", "costs", "any"]),
  /** actions: best_paid | cheapest | name. places: nearest | name. */
  sort: Name,
  /** places: only those with this tag, or "". */
  tag: Name,
  openNow: z.boolean(),
  limit: Int,
  empty: Line,
  intent: DraftIntent,
});

const DraftLayout = z
  .array(
    z.strictObject({
      region: z.enum([
        "top",
        "top_left",
        "top_right",
        "left",
        "right",
        "bottom_left",
        "bottom",
        "bottom_right",
      ]),
      widgets: z.array(DraftWidget).max(8),
    }),
  )
  .max(12);

/** A look: a box (metres; a mover's front faces +x) and the solids in it, or null. */
const DraftLook = z
  .strictObject({ lengthM: Int, heightM: Int, widthM: Int, shapes: z.array(DraftSolid).max(32) })
  .nullable();

/** Somewhere people go into, built as its own place. */
const DraftPlace = z.strictObject({
  /** Minutes after midnight; -1 for both means always open. */
  opens: Int,
  closes: Int,
  private: z.boolean(),
  tags: z.array(Name).max(6),
  widthM: Int,
  depthM: Int,
  heightM: Int,
  /** What it's like inside, in words: what the place is built from. */
  inside: z.string().max(800),
  /** A city mark someone needs to get in, and how much of it; "" for open to all. */
  needsMark: Name.default(""),
  needsAtLeast: Int.default(0),
});

/**
 * A kind of thing in the city and what it can do, by trait: be a place, move people (a
 * mover), cover an area, run as a line, or stand on the map as a prop. Null: it can't.
 */
export const DraftCityKind = z.strictObject({
  name: Name,
  about: Line,
  icon: Hex,
  colour: Hex,
  look: DraftLook,
  place: DraftPlace.nullable(),
  mover: z
    .strictObject({
      way: z.enum(WAYS),
      speedKmh: Int,
      /** People one carries, driver included; 0: on foot. */
      holds: Int,
      baseFare: Int,
      farePerKm: Int,
      /** Minutes after midnight it runs; -1 for both means always. */
      from: Int,
      to: Int,
      /** For water or rail: the kind riders reach its stops by ("" on foot). */
      reach: Name,
      /** The names of the places it goes; empty: everywhere. */
      serves: z.array(Name).max(48),
      /** What going this way takes out of you: a need by name, how much per hour of the trip. */
      tires: z
        .array(z.strictObject({ need: Name, perHour: Int }))
        .max(3)
        .default([]),
    })
    .nullable(),
  area: z.strictObject({ blocks: z.boolean() }).nullable(),
  line: z.strictObject({ widthM: Int }).nullable(),
  prop: z.boolean(),
  /** The model's own fields: names and short values, for its own use. Nothing runs on them. */
  attrs: z.array(z.strictObject({ name: Name, value: Line })).max(12),
});
export type DraftCityKind = z.infer<typeof DraftCityKind>;

/** One item of a kind on the map: where it is, and anything of its own over its kind. */
export const DraftCityItem = z.strictObject({
  name: Name,
  kind: Name,
  blurb: Line,
  /** "" for its kind's. */
  icon: z.string().max(32),
  colour: z.string().max(16),
  /** The district (an area item's name) it is in, or "". */
  district: Name,
  /** Its position, or -1 for both if it has none (an area, a line, scattered spots). */
  x: Int,
  z: Int,
  spots: z.array(Xz).max(80),
  polygon: z.array(Xz).max(32),
  line: z.array(Xz).max(24),
  look: DraftLook,
  /** Its own place details over its kind's, or null. */
  place: DraftPlace.nullable(),
  attrs: z.array(z.strictObject({ name: Name, value: Line })).max(12),
});
export type DraftCityItem = z.infer<typeof DraftCityItem>;

/**
 * What the city author returns: a whole city and its interface, flat and decoding-friendly.
 * Places, districts, apps and needs are referred to by name; code derives keys, clamps every
 * number to `CITY_BOUNDS`, checks every colour and icon, and reports what doesn't add up.
 */
export const CityDraft = z.strictObject({
  name: Name,
  tagline: Line,
  icon: Hex,
  currency: z.string().max(8),
  theme: z.strictObject({
    font: z.enum(["rounded", "grotesk", "serif", "mono", "condensed"]),
    radiusPx: Int,
    bg: Hex,
    surface: Hex,
    ink: Hex,
    muted: Hex,
    accent: Hex,
    onAccent: Hex,
    good: Hex,
    warn: Hex,
    bad: Hex,
    land: Hex,
    water: Hex,
    road: Hex,
    built: Hex,
    industrial: Hex,
    green: Hex,
  }),
  needs: z
    .array(
      z.strictObject({
        name: Name,
        decayPerHour: Int,
        /** What running out costs: null if nothing. */
        whenEmpty: z
          .strictObject({ payPermille: Int, walkPermille: Int, feeling: Name })
          .nullable()
          .default(null),
      }),
    )
    .max(16),
  /** What stays with people here wherever they go. */
  marks: z
    .array(z.strictObject({ name: Name, max: Int, shown: z.boolean() }))
    .max(24)
    .default([]),
  /** What an hour of ordinary work pays here, minor units. */
  hourPay: Int,
  /** What everyone here has to keep paying. */
  bills: z
    .array(
      z.strictObject({
        name: Name,
        amount: Int,
        everyDays: Int,
        /** It comes in rather than goes out. */
        pays: z.boolean().default(false),
        /** Only for someone with this much of a mark; "" for everyone. */
        whenMark: Name.default(""),
        whenAtLeast: Int.default(0),
      }),
    )
    .max(8)
    .default([]),
  /** When it gets light and dark here: minutes after midnight. */
  sunrise: Int,
  sunset: Int,
  /** The few words the interface needs, in the city's voice (see `WORD_KEYS`). */
  words: z.strictObject(
    Object.fromEntries(WORD_KEYS.map((k) => [k, Name])) as Record<WordKey, typeof Name>,
  ),
  /** What someone waiting for this city reads, in order, as it's built. */
  buildingLines: z.array(Line).max(6),
  /** The kinds of things this city is made of, each with the traits it has. */
  kinds: z.array(DraftCityKind).max(48),
  /** Everything on the map: items of those kinds, by kind name. */
  items: z.array(DraftCityItem).max(160),
  starts: z
    .array(
      z.strictObject({
        name: Name,
        blurb: Line,
        money: Int,
        home: Name,
        /** What someone starting this way is working towards. */
        aim: z
          .strictObject({
            title: Name,
            about: Line,
            icon: z.string().max(32),
            reward: Int,
            /** Each step: a mark and how much of it, or (mark "") an amount of money. */
            steps: z.array(z.strictObject({ mark: Name, atLeast: Int, text: Line })).max(12),
          })
          .nullable()
          .default(null),
      }),
    )
    .max(8),
  skinTones: z.array(Hex).max(16),
  outfitColours: z.array(Hex).max(16),
  hairColours: z.array(Hex).max(16),
  characters: z
    .array(z.strictObject({ name: Name, heightMm: Int, look: z.array(DraftPersonShape).max(64) }))
    .max(10),
  headlines: z.array(z.strictObject({ icon: Hex, text: Line })).max(16),
  map: DraftLayout,
  place: DraftLayout,
  apps: z
    .array(
      z.strictObject({
        name: Name,
        icon: Hex,
        colour: Hex,
        blocks: z.array(DraftBlock).max(16),
      }),
    )
    .max(12),
  /** The screens people here use, each carrying some of the apps (by name). */
  panels: z
    .array(
      z.strictObject({
        name: Name,
        icon: Hex,
        form: z.enum(["handheld", "wide", "wall"]),
        apps: z.array(Name).max(12),
      }),
    )
    .max(6),
  tour: z.array(z.strictObject({ title: Name, body: Line })).max(8),
});
export type CityDraft = z.infer<typeof CityDraft>;
export type DraftWidget = z.infer<typeof DraftWidget>;
export type DraftBlock = z.infer<typeof DraftBlock>;
export type DraftIntent = z.infer<typeof DraftIntent>;

// ── Looking at looks ────────────────────────────────────────────────────────────────

/** What a look critic returns: per numbered tile, how recognisable it is and what to fix. */
export const LookReview = z.strictObject({
  tiles: z
    .array(
      z.strictObject({
        index: z.int().min(0).max(200),
        /** 0 = unrecognisable, 10 = obvious at a glance. */
        score: Int,
        fixes: z.array(Line).max(6),
      }),
    )
    .max(200),
});
export type LookReview = z.infer<typeof LookReview>;

/** A redesigned look of solids (a building, scenery): the complete look, not a diff. */
export const SolidsRedesign = z.strictObject({ shapes: z.array(DraftSolid).max(40) });
/** A redesigned thing look: solids that may show only in some states. */
export const ThingRedesign = z.strictObject({
  shapes: z.array(DraftSolid.extend({ when: z.array(DraftCondition).max(8) })).max(40),
});
/** A redesigned person: the whole figure. */
export const PersonRedesign = z.strictObject({
  heightMm: Int,
  shapes: z.array(DraftPersonShape).max(64),
});
