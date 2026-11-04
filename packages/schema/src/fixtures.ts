/**
 * Hand-authored sample data for tests across packages: a small Lagos flat (geometry) and a
 * world spec for it, written the way a model would write one. Not used by the app, which
 * plays places the harness builds. Contains real constraints on purpose: a 180 mm front step,
 * a 700 mm bathroom door, power that cuts out and a generator that has to be started.
 */
import { CitySpec } from "./city-spec.ts";
import { Scene, type Scene as SceneT } from "./scene.ts";
import { WorldSettings } from "./world.ts";
import type { PersonLook } from "./world-spec.ts";
import { type KindDef, type Shape, WorldSpec } from "./world-spec.ts";

const object = (
  id: string,
  label: string,
  spaceId: string | null,
  [x, z]: [number, number],
  yawDeg: number,
  [w, d, h]: [number, number, number],
) => ({
  id,
  label,
  levelId: "lvl_ground",
  spaceId,
  transform: { position: [x, 0, z] as [number, number, number], yawDeg },
  size: { w, d, h },
  evidence: null,
});

const rect = (x0: number, z0: number, x1: number, z1: number): [number, number][] => [
  [x0, z0],
  [x1, z0],
  [x1, z1],
  [x0, z1],
];

const space = (
  id: string,
  name: string,
  polygon: [number, number][],
  extra: { floorOffsetMm?: number; ceilingMm?: number | null } = {},
) => ({
  id,
  levelId: "lvl_ground",
  name,
  polygon,
  floorOffsetMm: extra.floorOffsetMm ?? 0,
  ceilingMm: extra.ceilingMm === undefined ? 2700 : extra.ceilingMm,
});

const wall = (id: string, a: [number, number], b: [number, number]) => ({
  id,
  levelId: "lvl_ground",
  a,
  b,
  thicknessMm: 150,
  heightMm: 2700,
});

const opening = (
  id: string,
  kind: "door" | "doorway",
  wallId: string,
  at: [number, number],
  yawDeg: number,
  clearWidthMm: number,
  connects: [string | null, string | null],
  thresholdMm = 0,
) => ({
  id,
  levelId: "lvl_ground",
  kind,
  wallId,
  at,
  yawDeg,
  clearWidthMm,
  heightMm: 2100,
  sillMm: 0,
  thresholdMm,
  connects,
});

/** Two-bedroom-ish ground-floor flat with a front yard, about 8 m × 6 m plus yard. */
export const sampleFlat: SceneT = Scene.parse({
  format: "aye.scene",
  schemaVersion: 1,
  levels: [
    {
      id: "lvl_ground",
      name: "Ground floor",
      elevationMm: 0,
      footprint: rect(0, -3000, 8000, 6000),
    },
  ],
  spaces: [
    space("spc_yard", "Front yard", rect(0, -3000, 8000, 0), {
      floorOffsetMm: -180,
      ceilingMm: null,
    }),
    space("spc_living", "Parlour", rect(0, 0, 5000, 3500)),
    space("spc_kitchen", "Kitchen", rect(5000, 0, 8000, 3500)),
    space("spc_bedroom", "Bedroom", rect(0, 3500, 4000, 6000)),
    space("spc_bath", "Bathroom", rect(4000, 3500, 6000, 6000)),
    space("spc_store", "Store", rect(6000, 3500, 8000, 6000)),
  ],
  walls: [
    wall("wal_front", [0, 0], [8000, 0]),
    wall("wal_east", [8000, 0], [8000, 6000]),
    wall("wal_back", [8000, 6000], [0, 6000]),
    wall("wal_west", [0, 6000], [0, 0]),
    wall("wal_kitchen", [5000, 0], [5000, 3500]),
    wall("wal_mid", [0, 3500], [8000, 3500]),
    wall("wal_bed", [4000, 3500], [4000, 6000]),
    wall("wal_bath", [6000, 3500], [6000, 6000]),
  ],
  openings: [
    opening("opn_front", "door", "wal_front", [2500, 0], 0, 900, ["spc_yard", "spc_living"], 25),
    opening("opn_kitchen", "doorway", "wal_kitchen", [5000, 1750], 90, 900, [
      "spc_living",
      "spc_kitchen",
    ]),
    opening("opn_bedroom", "door", "wal_mid", [3200, 3500], 0, 800, ["spc_living", "spc_bedroom"]),
    opening("opn_bath", "door", "wal_mid", [4600, 3500], 0, 700, ["spc_living", "spc_bath"], 15),
    opening("opn_store", "door", "wal_mid", [7000, 3500], 0, 750, ["spc_kitchen", "spc_store"]),
  ],
  levelChanges: [
    {
      id: "lch_frontstep",
      kind: "step",
      fromLevelId: "lvl_ground",
      toLevelId: "lvl_ground",
      from: [2500, -400],
      to: [2500, 0],
      widthMm: 1200,
      riseMm: 180,
      stepCount: 1,
      hasHandrail: false,
    },
  ],
  objects: [
    object(
      "obj_bed",
      "Double bed with ankara spread",
      "spc_bedroom",
      [1100, 5250],
      90,
      [1400, 2000, 550],
    ),
    object("obj_wardrobe", "Built-in wardrobe", "spc_bedroom", [3300, 5650], 0, [1200, 600, 2000]),
    object(
      "obj_sofa",
      "Brown leather three-seater",
      "spc_living",
      [1200, 3000],
      180,
      [1900, 900, 850],
    ),
    object("obj_telly", "Wall-mounted TV", "spc_living", [1200, 300], 0, [1100, 300, 700]),
    object("obj_chair", "Rattan armchair", "spc_living", [3800, 1500], 270, [500, 500, 900]),
    object("obj_fan", "Standing fan", "spc_living", [350, 1600], 0, [450, 450, 1300]),
    object("obj_cooker", "Four-burner gas cooker", "spc_kitchen", [6000, 400], 0, [600, 600, 900]),
    object("obj_ksink", "Kitchen sink", "spc_kitchen", [6800, 300], 0, [600, 500, 850]),
    object("obj_fridge", "Fridge", "spc_kitchen", [7500, 400], 0, [600, 650, 1700]),
    object("obj_shelf", "High spice shelf", "spc_kitchen", [7750, 2500], 270, [900, 350, 1800]),
    object("obj_shower", "Shower tray", "spc_bath", [4500, 5500], 0, [900, 900, 2100]),
    object("obj_toilet", "Toilet", "spc_bath", [5600, 5600], 180, [400, 700, 750]),
    object("obj_bsink", "Wash basin", "spc_bath", [5600, 4000], 0, [600, 500, 850]),
    object("obj_gen", "Small petrol generator", "spc_yard", [7000, -2000], 0, [700, 550, 550]),
  ],
  portals: [
    {
      id: "prt_street",
      levelId: "lvl_ground",
      at: [2500, -3000],
      yawDeg: 0,
      widthMm: 2000,
      label: "Street",
    },
  ],
  entry: "prt_street",
});

export const sampleSettings = WorldSettings.parse({
  seed: 1,
  gridCellMm: 100,
  startMinuteOfDay: 6 * 60,
});

const box = (colour: string, when: Shape["when"] = []): Shape => ({
  shape: "box",
  centre: [0, 500, 0],
  size: [1000, 1000, 1000],
  rotateDeg: [0, 0, 0],
  colour,
  glow: false,
  when,
});

/** A kind with one simple use; most of the flat is like this. */
const simple = (
  key: string,
  label: string,
  colour: string,
  use: { key: string; label: string; minutes: number; needs: [string, number][] } | null,
  extra: Partial<KindDef> = {},
): KindDef => ({
  key,
  label,
  solid: true,
  vars: [],
  actions: use
    ? [
        {
          key: use.key,
          label: use.label,
          durationMin: use.minutes,
          capacity: 1,
          cost: 0,
          income: 0,
          requires: [],
          needs: use.needs.map(([need, perHour]) => ({ need, perHour })),
          sets: [],
          leaves: null,
          pose: "stand",
        },
      ]
    : [],
  supplies: [],
  look: [box(colour)],
  note: "",
  ...extra,
});

const withAction = (kind: KindDef, patch: Partial<KindDef["actions"][number]>): KindDef => ({
  ...kind,
  actions: kind.actions.map((a) => ({ ...a, ...patch })),
});

/** The flat's world, as a model might write it: power cuts, a generator, a wheelchair user. */
export const sampleSpec: WorldSpec = WorldSpec.parse({
  format: "aye.world",
  version: 1,
  scene: "b3:0000000000000000000000000000000000000000000000000000000000000000",
  author: { provider: "fixture", model: "hand-written", version: "1" },
  name: "Sample flat",
  summary: "A two-room ground-floor flat in Lagos with a yard.",
  currency: "NGN",
  // At this pay, money is worth pay / 2,000 need points to someone choosing what to do.
  hourPay: 100_000,
  livedIn: true,
  needs: [
    { key: "hunger", label: "Hunger", decayPerHour: 60 },
    { key: "energy", label: "Energy", decayPerHour: 45 },
    { key: "hygiene", label: "Hygiene", decayPerHour: 35 },
    { key: "bladder", label: "Bladder", decayPerHour: 90 },
    { key: "fun", label: "Fun", decayPerHour: 50 },
    { key: "comfort", label: "Comfort", decayPerHour: 40 },
  ],
  resources: [
    { key: "power", label: "Grid power", supply: { uptimePermille: 550, meanOutageMin: 240 } },
    { key: "water", label: "Tap water", supply: { uptimePermille: 900, meanOutageMin: 120 } },
  ],
  kinds: [
    {
      ...simple("bed", "Bed", "#d9c7a7", {
        key: "sleep",
        label: "Sleep",
        minutes: 420,
        needs: [
          ["energy", 150],
          ["comfort", 30],
        ],
      }),
      actions: [
        {
          key: "sleep",
          label: "Sleep",
          durationMin: 420,
          capacity: 2,
          cost: 0,
          income: 0,
          requires: [],
          needs: [
            { need: "energy", perHour: 150 },
            { need: "comfort", perHour: 30 },
          ],
          sets: [],
          leaves: null,
          pose: "lie",
        },
      ],
    },
    simple("wardrobe", "Wardrobe", "#7a4e2d", {
      key: "dress",
      label: "Get dressed",
      minutes: 10,
      needs: [["comfort", 300]],
    }),
    withAction(
      simple("sofa", "Sofa", "#5a3b2a", {
        key: "sit",
        label: "Sit and rest",
        minutes: 30,
        needs: [
          ["comfort", 300],
          ["energy", 20],
        ],
      }),
      { pose: "sit" },
    ),
    withAction(
      simple("tv", "TV", "#111111", {
        key: "watch",
        label: "Watch TV",
        minutes: 60,
        needs: [
          ["fun", 300],
          ["comfort", 60],
        ],
      }),
      { requires: [{ resource: "power" }], pose: "sit", capacity: 4 },
    ),
    withAction(
      simple("chair", "Chair", "#b08a5a", {
        key: "sit",
        label: "Sit",
        minutes: 30,
        needs: [["comfort", 250]],
      }),
      { pose: "sit" },
    ),
    withAction(
      simple("fan", "Fan", "#c9d6df", {
        key: "cool",
        label: "Cool down",
        minutes: 30,
        needs: [["comfort", 400]],
      }),
      { requires: [{ resource: "power" }], capacity: 4 },
    ),
    withAction(
      simple("cooker", "Gas cooker", "#e6e2da", {
        key: "cook",
        label: "Cook and eat",
        minutes: 45,
        needs: [["hunger", 900]],
      }),
      { cost: 30_000 },
    ),
    withAction(
      simple("sink", "Sink", "#dddddd", {
        key: "wash",
        label: "Wash up",
        minutes: 4,
        needs: [["hygiene", 3000]],
      }),
      { requires: [{ resource: "water" }] },
    ),
    withAction(
      simple("fridge", "Fridge", "#f2f2ef", {
        key: "snack",
        label: "Grab a snack",
        minutes: 10,
        needs: [["hunger", 1500]],
      }),
      { cost: 20_000 },
    ),
    simple("shelf", "Shelf", "#8a6142", null),
    withAction(
      simple("shower", "Shower", "#9fc3cf", {
        key: "shower",
        label: "Shower",
        minutes: 15,
        needs: [
          ["hygiene", 4000],
          ["comfort", 200],
        ],
      }),
      { requires: [{ resource: "water" }] },
    ),
    withAction(
      simple("toilet", "Toilet", "#f4f1ea", {
        key: "use",
        label: "Use the toilet",
        minutes: 10,
        needs: [["bladder", 6000]],
      }),
      { pose: "sit" },
    ),
    {
      key: "generator",
      label: "Generator",
      solid: true,
      vars: [{ key: "running", label: "Running", max: 1, initial: 0 }],
      actions: [
        {
          key: "start",
          label: "Start the generator",
          durationMin: 5,
          capacity: 1,
          cost: 200_000,
          income: 0,
          requires: [{ var: "running", op: "eq", value: 0 }],
          needs: [],
          sets: [{ var: "running", value: 1, forMin: 240 }],
          leaves: null,
          pose: "stand",
        },
      ],
      supplies: [{ resource: "power", when: [{ var: "running", op: "eq", value: 1 }] }],
      look: [
        box("#d4a017"),
        {
          ...box("#555555", [{ var: "running", op: "eq", value: 1 }]),
          centre: [0, 1100, 0],
          size: [200, 200, 200],
        },
      ],
      note: "Backup power during outages, if someone pays for fuel.",
    },
  ],
  things: [
    ["obj_bed", "bed"],
    ["obj_wardrobe", "wardrobe"],
    ["obj_sofa", "sofa"],
    ["obj_telly", "tv"],
    ["obj_chair", "chair"],
    ["obj_fan", "fan"],
    ["obj_cooker", "cooker"],
    ["obj_ksink", "sink"],
    ["obj_fridge", "fridge"],
    ["obj_shelf", "shelf"],
    ["obj_shower", "shower"],
    ["obj_toilet", "toilet"],
    ["obj_bsink", "sink"],
    ["obj_gen", "generator"],
  ].map(([object, kind]) => ({ object, kind, state: [] })),
  people: [
    {
      key: "tolu",
      name: "Tolu",
      about: "Works from home, cooks a lot.",
      colours: { skin: "#5a3825", top: "#2f4b7c", bottom: "#e0a458" },
      body: {
        widthMm: 600,
        stepMm: 220,
        stairs: true,
        slopePermille: 250,
        speedMmPerS: 1300,
        seated: false,
      },
      money: 2_500_000,
      needs: [],
    },
    {
      key: "mama",
      name: "Mama Ronke",
      about: "Tolu's mother, uses a wheelchair.",
      colours: { skin: "#6b4430", top: "#c2562a", bottom: "#2f3a2f" },
      body: {
        widthMm: 815,
        stepMm: 20,
        stairs: false,
        slopePermille: 83,
        speedMmPerS: 1000,
        seated: true,
      },
      money: 800_000,
      needs: [{ need: "energy", start: 600 }],
    },
  ],
  ground: [
    { space: "spc_yard", colour: "#a9a59c" },
    { space: "spc_living", colour: "#e4ddd0" },
    { space: "spc_kitchen", colour: "#e4ddd0" },
    { space: "spc_bedroom", colour: "#c9b18f" },
    { space: "spc_bath", colour: "#dfe6e8" },
    { space: "spc_store", colour: "#cfc8bb" },
  ],
  walls: { colour: "#f1ece2" },
});

/** A hand-built test person (fixtures only: real looks are designed by models). */
export function sampleLook(variant: 0 | 1 | 2 = 0): PersonLook {
  const S = (
    shape: PersonLook["parts"][number]["shapes"][number]["shape"],
    centre: [number, number, number],
    size: [number, number, number],
    colour: PersonLook["parts"][number]["shapes"][number]["colour"],
  ) => ({ shape, centre, size, rotateDeg: [0, 0, 0] as [number, number, number], colour });
  const leg = (x: number) => [
    S("capsule", [x, 450, 0], [130, 880, 130], variant === 1 ? "skin" : "bottom"),
    S("rounded_box", [x, 40, 40], [110, 80, 240], "#2a2522"),
  ];
  const arm = (x: number) => [
    S("capsule", [x, 1150, 0], [100, 600, 100], "top"),
    S("sphere", [x, 830, 0], [85, 85, 85], "skin"),
  ];
  const hair = [
    S("hemisphere", [0, 1690, -10], [250, 140, 260], "hair"),
    S("sphere", [0, 1760, -60], [120, 120, 120], "hair"),
    S("cylinder", [0, 1700, 90], [240, 20, 120], "hair"),
  ][variant];
  return {
    heightMm: 1720,
    parts: [
      { part: "leg_left", shapes: leg(-90) },
      { part: "leg_right", shapes: leg(90) },
      {
        part: "body",
        shapes: [
          S("rounded_box", [0, 1170, 0], [380, 540, 230], "top"),
          S("capsule", [0, 1470, 0], [90, 120, 90], "skin"),
          ...(variant === 1 ? [S("cone", [0, 700, 0], [440, 560, 440], "bottom")] : []),
        ],
      },
      { part: "arm_left", shapes: arm(-245) },
      { part: "arm_right", shapes: arm(245) },
      {
        part: "head",
        shapes: [
          S("sphere", [0, 1610, 0], [230, 260, 240], "skin"),
          S("sphere", [-45, 1630, 105], [34, 34, 34], "#17110d"),
          S("sphere", [45, 1630, 105], [34, 34, 34], "#17110d"),
          ...(hair ? [hair] : []),
        ],
      },
    ],
  };
}

/**
 * A hand-written test city: a private home (instanced per player) and a public spot across a
 * lagoon, a free way to walk and a paid ride, and an interface that shows the essentials.
 */
export const sampleCity: CitySpec = CitySpec.parse({
  format: "aye.city",
  version: 2,
  author: { provider: "fixture", model: "hand-written", version: "1" },
  brief: `b3:${"0".repeat(64)}`,
  name: "Testville",
  tagline: "A small town for tests.",
  icon: "\u{1F3D9}\u{FE0F}",
  currency: "NGN",
  theme: {
    font: "rounded",
    radiusPx: 16,
    colours: {
      bg: "#f6f3ec",
      surface: "#ffffff",
      ink: "#1d1b16",
      muted: "#6b665b",
      accent: "#1a7f4e",
      onAccent: "#ffffff",
      good: "#1a7f4e",
      warn: "#c98a00",
      bad: "#c0392b",
      land: "#cfe3c4",
      water: "#5aa9d6",
      road: "#9a9a96",
      built: "#b9ad97",
      industrial: "#9c8f86",
      green: "#8fc27a",
    },
  },
  needs: sampleSpec.needs.map((n) =>
    n.key === "hunger"
      ? { ...n, whenEmpty: { payPermille: 500, walkPermille: 800, feeling: "Too hungry to focus" } }
      : n,
  ),
  economy: { hourPay: 100_000, bills: [{ name: "Rent", amount: 600_000, everyDays: 3 }] },
  sun: { rises: 380, sets: 1120 },
  words: {
    walking: "Walking",
    idle: "Free",
    onTheWay: "On the way",
    free: "Free",
    openNow: "Open now",
    closedNow: "Closed now",
    alwaysOpen: "Always open",
    running: "Running",
    notRunning: "Not running now",
    cantAfford: "Can't afford",
    notBuilt: "Still being built",
    day: "Day",
  },
  kinds: [
    {
      key: "district",
      name: "District",
      about: "Where people live and work.",
      icon: "\u{1F3D8}\u{FE0F}",
      colour: "#d8e8cf",
      look: null,
      traits: { area: { blocks: false, fill: [] } },
    },
    {
      key: "lagoon",
      name: "Lagoon",
      about: "Water between the mainland and the island.",
      icon: "\u{1F30A}",
      colour: "#5aa9d6",
      look: null,
      traits: { area: { blocks: true, fill: [] } },
    },
    {
      key: "road",
      name: "Road",
      about: "A main road.",
      icon: "\u{1F6E3}\u{FE0F}",
      colour: "#9a9a96",
      look: null,
      traits: { line: { widthM: 20 } },
    },
    {
      key: "flat",
      name: "Flat",
      about: "A home of your own.",
      icon: "\u{1F3E0}",
      colour: "#e8c39e",
      look: null,
      traits: {
        place: {
          hours: null,
          private: true,
          tags: ["home"],
          footprintM: [30, 20],
          heightM: 12,
          build: "A two-bedroom flat with a kitchen, a sitting room and a small generator.",
        },
      },
    },
    {
      key: "food_spot",
      name: "Food spot",
      about: "Somewhere to eat.",
      icon: "\u{1F372}",
      colour: "#d35400",
      look: null,
      traits: {
        place: {
          hours: { from: 360, to: 1380 },
          private: false,
          tags: ["food"],
          footprintM: [24, 18],
          heightM: 6,
          build: "A small food spot with benches, a pot of stew and a fridge of drinks.",
        },
      },
    },
    {
      key: "walk",
      name: "Walk",
      about: "On foot.",
      icon: "\u{1F6B6}",
      colour: "#6b665b",
      look: {
        sizeM: [1, 2, 1],
        solids: [
          {
            shape: "capsule",
            centre: [0, 500, 0],
            size: [600, 1000, 600],
            rotateDeg: [0, 0, 0],
            colour: "#2c3e50",
          },
        ],
      },
      traits: {
        mover: {
          way: "road",
          speedKmh: 5,
          holds: 0,
          fare: { base: 0, perKm: 0 },
          hours: null,
          reach: null,
          serves: [],
          tires: [{ need: "energy", perHour: 200 }],
        },
      },
    },
    {
      key: "bus",
      name: "Bus",
      about: "A city bus.",
      icon: "\u{1F68C}",
      colour: "#c98a00",
      look: {
        sizeM: [10, 3, 3],
        solids: [
          {
            shape: "rounded_box",
            centre: [0, 500, 0],
            size: [1000, 900, 1000],
            rotateDeg: [0, 0, 0],
            colour: "#f1c40f",
          },
        ],
      },
      traits: {
        mover: {
          way: "road",
          speedKmh: 25,
          holds: 40,
          fare: { base: 20_000, perKm: 5_000 },
          hours: { from: 300, to: 1380 },
          reach: null,
          serves: [],
        },
        prop: {},
      },
    },
  ],
  items: [
    {
      key: "mainland",
      kind: "district",
      name: "Mainland",
      blurb: "Busy streets and homes.",
      colour: "#d8e8cf",
      where: {
        district: null,
        at: null,
        polygon: [
          [0, 0],
          [2000, 0],
          [2000, 900],
          [0, 900],
        ],
      },
    },
    {
      key: "island",
      kind: "district",
      name: "Island",
      blurb: "Offices and the waterfront.",
      colour: "#e6e0cc",
      where: {
        district: null,
        at: null,
        polygon: [
          [0, 1300],
          [2000, 1300],
          [2000, 2000],
          [0, 2000],
        ],
      },
    },
    {
      key: "the_lagoon",
      kind: "lagoon",
      name: "The Lagoon",
      blurb: "",
      where: {
        district: null,
        at: null,
        polygon: [
          [0, 900],
          [2000, 900],
          [2000, 1300],
          [0, 1300],
        ],
      },
    },
    {
      key: "bridge_road",
      kind: "road",
      name: "Bridge Road",
      blurb: "",
      where: {
        district: null,
        at: null,
        line: [
          [1000, 200],
          [1000, 1800],
        ],
      },
    },
    {
      key: "your_flat",
      kind: "flat",
      name: "Your flat",
      blurb: "Two rooms, a kitchen and a generator.",
      look: {
        sizeM: [30, 12, 20],
        solids: [
          {
            shape: "box",
            centre: [0, 400, 0],
            size: [1000, 800, 1000],
            rotateDeg: [0, 0, 0],
            colour: "#e8c39e",
          },
          {
            shape: "wedge",
            centre: [0, 900, 0],
            size: [1080, 250, 1080],
            rotateDeg: [0, 0, 0],
            colour: "#a8432c",
          },
          {
            shape: "box",
            centre: [0, 200, 500],
            size: [180, 400, 20],
            rotateDeg: [0, 0, 0],
            colour: "#5b3a26",
          },
        ],
      },
      where: { district: "mainland", at: [600, 400] },
    },
    {
      key: "mama_s_spot",
      kind: "food_spot",
      name: "Mama's spot",
      blurb: "Hot food by the water.",
      look: {
        sizeM: [24, 6, 18],
        solids: [
          {
            shape: "box",
            centre: [0, 350, 0],
            size: [1000, 700, 1000],
            rotateDeg: [0, 0, 0],
            colour: "#d35400",
          },
          {
            shape: "box",
            centre: [0, 700, 600],
            size: [1000, 40, 300],
            rotateDeg: [-15, 0, 0],
            colour: "#f1c40f",
          },
        ],
      },
      where: { district: "island", at: [1400, 1600] },
    },
    {
      key: "parked_buses",
      kind: "bus",
      name: "Parked buses",
      blurb: "",
      where: {
        district: "mainland",
        at: null,
        spots: [
          [900, 300],
          [1100, 700],
        ],
      },
    },
  ],
  starts: [
    {
      key: "fresh_start",
      label: "Fresh start",
      blurb: "A little money and a flat.",
      money: 500_000,
      home: "your_flat",
      aim: {
        title: "A place of your own",
        about: "Out of the shared flat, and into your own.",
        icon: "\u{1F511}",
        reward: 1_000_000,
        steps: [
          { mark: "cooking", atLeast: 2, text: "Learn to cook" },
          { money: 3_000_000, text: "Save the deposit" },
        ],
      },
    },
  ],
  marks: [
    { key: "cooking", label: "Cooking", max: 5, shown: true },
    { key: "groceries", label: "Groceries", max: 9, shown: true },
  ],
  looks: {
    skin: ["#5a3a24", "#8d5524", "#c68642"],
    outfit: ["#1a7f4e", "#2c3e50", "#e67e22", "#ecf0f1"],
    hair: ["#1a1310", "#3a2a1f", "#7a2e8f"],
  },
  characters: [sampleLook(0), sampleLook(1), sampleLook(2)],
  headlines: [{ icon: "\u{1F4F0}", text: "Bridge Road reopens after repairs." }],
  ui: {
    map: [
      { region: "top_left", widgets: [{ type: "brand" }] },
      { region: "top_right", widgets: [{ type: "wallet" }, { type: "clock", style: "digital" }] },
      { region: "bottom", widgets: [{ type: "ticker" }, { type: "trip" }] },
      { region: "bottom_left", widgets: [{ type: "life" }, { type: "plan" }] },
      { region: "right", widgets: [{ type: "threads" }] },
      { region: "bottom_right", widgets: [{ type: "panel", panel: "mobile" }] },
    ],
    place: [
      { region: "top_left", widgets: [{ type: "brand" }, { type: "doing" }] },
      { region: "top_right", widgets: [{ type: "wallet" }, { type: "clock", style: "sun" }] },
      { region: "left", widgets: [{ type: "needs", style: "bars", show: "all" }] },
      { region: "right", widgets: [{ type: "threads" }] },
      { region: "bottom_left", widgets: [{ type: "chat" }] },
      {
        region: "bottom_right",
        widgets: [
          { type: "panel", panel: "mobile" },
          { type: "button", label: "Map", icon: "\u{1F5FA}\u{FE0F}", intent: { do: "map" } },
        ],
      },
    ],
    apps: [
      {
        key: "work",
        label: "Work",
        icon: "\u{1F4BC}",
        colour: "#1a7f4e",
        blocks: [
          { type: "heading", text: "Ways to earn" },
          {
            type: "list",
            source: { from: "actions", filter: "pays", need: null, sort: "best_paid" },
            limit: 10,
            empty: "Nothing pays right now.",
          },
        ],
      },
      {
        key: "ride",
        label: "Ride",
        icon: "\u{1F695}",
        colour: "#c98a00",
        blocks: [{ type: "list", source: { from: "travel" }, limit: 8, empty: "No rides." }],
      },
    ],
    panels: [
      {
        key: "mobile",
        label: "Mobile",
        icon: "\u{1F4F1}",
        form: "handheld",
        apps: ["work", "ride"],
      },
    ],
    tour: [{ title: "Welcome", body: "Tap a place on the map to go there." }],
  },
});
