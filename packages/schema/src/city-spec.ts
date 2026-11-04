/**
 * City specs: a whole playable city, written by a model. What the city is made of (kinds the
 * model declares, with traits code runs, and items of them on the map), the needs
 * everyone here has, its economy, sun and words, how a new arrival starts out, what the news
 * says, and the game's interface itself:
 * its theme, what the HUD shows and where, its apps, and the panels that group them (which
 * the model names: a phone, a laptop, a notice board, whatever this city has).
 *
 * The interface is data, never code or markup. A model composes it from a closed set of
 * widgets and blocks; anything that shows game data binds to a generic query ("actions that
 * pay", "places open now") the client evaluates. So any city a model writes renders safely,
 * and no world noun ("jobs", "NEPA", "danfo") lives in code: those are the model's words.
 *
 * Places are described here and built separately (scene + world spec); a city
 * references them by key. Private places (a home) are instanced per player.
 */
import { z } from "zod";
import { ArtifactHash, ModelRef } from "./artifact.ts";
import { CityEvent, EVENT_BOUNDS, eventIssues } from "./city-events.ts";
import {
  type CityMover,
  type CityPlace,
  Item,
  KIND_BOUNDS,
  Kind,
  kindIssues,
  viewsOf,
} from "./city-kinds.ts";
import { AssetId } from "./library.ts";
import { Population } from "./population.ts";
import { CurrencyCode, Label } from "./primitives.ts";
import { MarkDef, NeedDef, PersonLook, SpecKey } from "./world-spec.ts";

export const CITY_BOUNDS = {
  /** A sketched city's map is a square this many metres across, origin at a corner. */
  mapM: 4_000,
  /** A real city's map can reach this far (it is as big as the city is). */
  realMapM: 80_000,
  starts: 6,
  /** The most steps in what someone is working towards. */
  aimSteps: 6,
  /** Marks a city can have: leaves room in a place for its people. */
  marks: 16,
  /** Bills a city can have, and the longest between them, in city days. */
  bills: 4,
  billEveryDays: 14,
  looks: 12,
  headlines: 12,
  apps: 10,
  panels: 4,
  blocksPerApp: 12,
  widgetsPerRegion: 5,
  tour: 6,
  characterLooks: 8,
  money: 1_000_000_000,
  radiusPx: 28,
} as const;

const Colour = z.string().regex(/^#[0-9a-f]{6}$/, "colour as #rrggbb");
const Text = (max: number) => z.string().max(max);
const MinuteOfDay = z.int().min(0).max(1439);

/**
 * One emoji (with its modifiers, joiners and flags): icons are text, so they need no assets,
 * scale with type, and can't carry anything but a picture.
 */
export const Icon = z
  .string()
  .min(1)
  .max(32)
  .regex(
    /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\u{FE0F}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u{200D}\p{Extended_Pictographic}|\u{20E3})*$/u,
    "a single emoji",
  );
export type Icon = z.infer<typeof Icon>;

// ── Theme ──────────────────────────────────────────────────────────────────────────────

export const FontStyle = z.enum(["rounded", "grotesk", "serif", "mono", "condensed"]);
export type FontStyle = z.infer<typeof FontStyle>;

export const Theme = z.object({
  font: FontStyle,
  radiusPx: z.int().min(0).max(CITY_BOUNDS.radiusPx),
  colours: z.object({
    bg: Colour,
    surface: Colour,
    ink: Colour,
    muted: Colour,
    accent: Colour,
    onAccent: Colour,
    good: Colour,
    warn: Colour,
    bad: Colour,
    land: Colour,
    water: Colour,
    road: Colour,
    /** What covers a real city's ground, drawn over its districts. */
    built: Colour,
    industrial: Colour,
    green: Colour,
  }),
});
export type Theme = z.infer<typeof Theme>;

// ── How a new arrival starts, and the news ────────────────────────────────────────────

/** How a new arrival can start out: money, and the private place they wake up in. */
export const StartDef = z.object({
  key: SpecKey,
  label: Label.min(1),
  blurb: Text(200),
  money: z.int().min(0).max(CITY_BOUNDS.money),
  home: SpecKey,
  /** What someone starting this way is working towards, over many days. */
  aim: z
    .object({
      title: Label.min(1),
      about: Text(200),
      icon: Icon,
      reward: z.int().min(0).max(CITY_BOUNDS.money),
      steps: z
        .array(
          z.union([
            z.object({ mark: SpecKey, atLeast: z.int().min(1), text: Text(160) }),
            z.object({ money: z.int().min(1), text: Text(160) }),
          ]),
        )
        .min(1)
        .max(CITY_BOUNDS.aimSteps),
    })
    .optional(),
});
export type StartDef = z.infer<typeof StartDef>;

export const Headline = z.object({ icon: Icon, text: Text(160) });

// ── Economy, sun and words ─────────────────────────────────────────────────────────────

/** Something everyone here has to keep paying (rent, a stall fee, school fees). */
export const Bill = z.object({
  name: z.string().min(1).max(80),
  /** What it costs each time, minor units. */
  amount: z.int().min(1).max(CITY_BOUNDS.money),
  /** Every how many city days it falls due. */
  everyDays: z.int().min(1).max(CITY_BOUNDS.billEveryDays),
  /** It comes in rather than goes out: what something you own earns you. */
  pays: z.boolean().optional(),
  /** Only for someone with this much of a mark: what they've taken on, or built up. */
  when: z.object({ mark: SpecKey, atLeast: z.int().min(1).max(1_000) }).optional(),
});
export type Bill = z.infer<typeof Bill>;

/** What money is worth here: how much people want it depends on what work pays. */
export const Economy = z.object({
  /** What an hour of ordinary work pays here, minor units. */
  hourPay: z.int().min(1).max(CITY_BOUNDS.money),
  bills: z.array(Bill).max(CITY_BOUNDS.bills).default([]),
});
export type Economy = z.infer<typeof Economy>;

/** Where someone stands with the city's bills: saved with them, changed only by the server. */
export const Billed = z.object({
  /** The city day (from 0) last settled; -1 before they've ever been billed. */
  day: z.int().min(-1),
  /** What they still owe, minor units: what they earn goes here first. */
  owes: z.int().min(0),
});
export type Billed = z.infer<typeof Billed>;

/**
 * Settle up on city day `today`: what's fallen due since `billed.day` joins what's owed, and
 * as much as the wallet holds is paid. Someone is billed from the day after they first turn
 * up, and each bill at most once however long they were away: being gone isn't a debt.
 */
export function settleBills(
  bills: readonly Bill[],
  billed: Billed,
  today: number,
  wallet: number,
  markOf: (mark: string) => number = () => 0,
): { billed: Billed; paid: number; earned: number; fell: Bill[] } {
  if (billed.day < 0) {
    return { billed: { day: today, owes: billed.owes }, paid: 0, earned: 0, fell: [] };
  }
  const fell = bills.filter(
    (b) =>
      Math.floor(today / b.everyDays) > Math.floor(billed.day / b.everyDays) &&
      (!b.when || markOf(b.when.mark) >= b.when.atLeast),
  );
  const earned = fell.reduce((sum, b) => sum + (b.pays ? b.amount : 0), 0);
  const owing = billed.owes + fell.reduce((sum, b) => sum + (b.pays ? 0 : b.amount), 0);
  // What comes in pays what's owed first.
  const paid = Math.max(0, Math.min(wallet + earned, owing));
  return { billed: { day: Math.max(today, billed.day), owes: owing - paid }, paid, earned, fell };
}

/** The next bill to fall due after city day `today`, and when. */
export function nextBill(
  bills: readonly Bill[],
  today: number,
): { bill: Bill; day: number } | null {
  let next: { bill: Bill; day: number } | null = null;
  for (const bill of bills) {
    if (bill.pays || bill.when) continue;
    const day = (Math.floor(today / bill.everyDays) + 1) * bill.everyDays;
    if (!next || day < next.day) next = { bill, day };
  }
  return next;
}

/** When it gets light and dark here, city time. */
export const Sun = z.object({ rises: MinuteOfDay, sets: MinuteOfDay });
export type Sun = z.infer<typeof Sun>;

/**
 * How far through the day a minute is: 0 at sunrise, 1 at sunset, outside 0..1 at night
 * (so sin(phase·π) is the sun's height). Without a sun, 05:30 to 18:30.
 */
export function dayPhase(sun: Sun | undefined, minuteOfDay: number): number {
  const rises = sun?.rises ?? 330;
  const length = sun ? (sun.sets - sun.rises + 1440) % 1440 || 720 : 780;
  return ((((minuteOfDay - rises) % 1440) + 1440) % 1440) / length;
}

/**
 * The few words the interface puts on screen around the model's own (a fare that costs
 * nothing, a place that's shut, someone between places), in the city's voice and language.
 */
export const BUILDING_LINE_MAX = 80;

export const WORD_KEYS = [
  /** Someone walking from one spot to another inside a place. */
  "walking",
  /** Someone doing nothing in particular. */
  "idle",
  /** Between places. */
  "onTheWay",
  /** A price of nothing. */
  "free",
  "openNow",
  "closedNow",
  "alwaysOpen",
  /** A way to get around that runs now, or doesn't. */
  "running",
  "notRunning",
  "cantAfford",
  /** A place that isn't built yet. */
  "notBuilt",
  /** Before the day's number on the clock ("Day 3"). */
  "day",
] as const;
export type WordKey = (typeof WORD_KEYS)[number];
export const Words = z.object(
  Object.fromEntries(WORD_KEYS.map((k) => [k, Label.min(1).max(40)])) as Record<
    WordKey,
    z.ZodString
  >,
);
export type Words = z.infer<typeof Words>;
export type Headline = z.infer<typeof Headline>;

// ── Interface: widgets, apps and the data they bind to ─────────────────────────────────

/** Things the interface can do when tapped. Every target is checked to exist. */
export const Intent = z.discriminatedUnion("do", [
  z.object({ do: z.literal("open_app"), app: SpecKey }),
  /** Show a place's sheet (what it is, how to get there). */
  z.object({ do: z.literal("show_place"), place: SpecKey }),
  z.object({ do: z.literal("map") }),
  /** Open one of the city's panels. */
  z.object({ do: z.literal("panel"), panel: SpecKey }),
  z.object({ do: z.literal("tour") }),
]);
export type Intent = z.infer<typeof Intent>;

/** A live value: something about you, the place or the city, or one of your needs. */
export const Binding = z.discriminatedUnion("of", [
  z.object({
    of: z.enum(["wallet", "clock", "place", "players_online", "name", "doing"]),
  }),
  z.object({ of: z.literal("need"), need: SpecKey }),
]);
export type Binding = z.infer<typeof Binding>;

/**
 * Generic queries over the city and its places. "actions" spans every built place's world
 * (what you can do where, what it costs or pays); tapping a result shows that place.
 */
export const Source = z.discriminatedUnion("from", [
  z.object({
    from: z.literal("actions"),
    filter: z.enum(["pays", "costs", "any"]),
    /** Only actions that help this need, if set. */
    need: SpecKey.nullable(),
    sort: z.enum(["best_paid", "cheapest", "name"]),
  }),
  z.object({
    from: z.literal("places"),
    tag: SpecKey.nullable(),
    openNow: z.boolean(),
    sort: z.enum(["nearest", "name"]),
  }),
  /** No options. `events`: what the city is going through now and next (its director's). */
  z.object({ from: z.enum(["travel", "people", "players", "headlines", "events"]) }),
]);
export type Source = z.infer<typeof Source>;

export const Widget = z.discriminatedUnion("type", [
  z.object({
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
      /** How the city is living now (people out, traffic), and a way to show it on the map. */
      "life",
      /** Opens the planner: change the roads, compare a day. Real cities only. */
      "plan",
      /** Where you're headed and when you'll arrive, while between places. */
      "trip",
      /** What you're in the middle of: your threads, step by step. */
      "threads",
    ]),
  }),
  /** A button that opens one of the city's panels, with its own name and icon. */
  z.object({ type: z.literal("panel"), panel: SpecKey }),
  z.object({ type: z.literal("clock"), style: z.enum(["digital", "sun"]) }),
  z.object({
    type: z.literal("needs"),
    style: z.enum(["bars", "rings", "chips"]),
    show: z.enum(["all", "lowest3"]),
  }),
  z.object({
    type: z.literal("text"),
    text: Text(160),
    tone: z.enum(["plain", "muted", "accent"]),
  }),
  z.object({ type: z.literal("button"), label: Label.min(1), icon: Icon, intent: Intent }),
]);
export type Widget = z.infer<typeof Widget>;

export const HudRegion = z.enum([
  "top",
  "top_left",
  "top_right",
  "left",
  "right",
  "bottom_left",
  "bottom",
  "bottom_right",
]);
export type HudRegion = z.infer<typeof HudRegion>;

export const Layout = z
  .array(
    z.object({ region: HudRegion, widgets: z.array(Widget).max(CITY_BOUNDS.widgetsPerRegion) }),
  )
  .max(8);
export type Layout = z.infer<typeof Layout>;

export const Block = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), text: Text(80) }),
  z.object({ type: z.literal("text"), text: Text(300) }),
  z.object({ type: z.literal("stat"), label: Label.min(1), value: Binding }),
  z.object({
    type: z.literal("list"),
    source: Source,
    limit: z.int().min(1).max(20),
    empty: Text(120),
  }),
  z.object({ type: z.literal("button"), label: Label.min(1), intent: Intent }),
]);
export type Block = z.infer<typeof Block>;

export const AppDef = z.object({
  key: SpecKey,
  label: Label.min(1),
  icon: Icon,
  colour: Colour,
  blocks: z.array(Block).min(1).max(CITY_BOUNDS.blocksPerApp),
});
export type AppDef = z.infer<typeof AppDef>;

/**
 * A panel: a group of the city's apps that opens as one screen. What it *is* belongs to the
 * model (a phone, a laptop, the buka's chalkboard, a POS terminal): its name, icon, which apps
 * it carries, which HUD button or which thing in a place opens it. Code owns only the shapes
 * a panel can be drawn in (`form`), as it owns how to draw a button or a list.
 */
export const PanelForm = z.enum(["handheld", "wide", "wall"]);
export const PanelDef = z.object({
  key: SpecKey,
  label: Label.min(1),
  icon: Icon,
  form: PanelForm,
  /** The apps on it, by key, in order. An app may be on several panels. */
  apps: z.array(SpecKey).min(1).max(CITY_BOUNDS.apps),
});
export type PanelDef = z.infer<typeof PanelDef>;

export const Ui = z.object({
  /** The city map screen. */
  map: Layout,
  /** Inside a place. */
  place: Layout,
  apps: z.array(AppDef).max(CITY_BOUNDS.apps),
  panels: z.array(PanelDef).max(CITY_BOUNDS.panels).default([]),
  tour: z.array(z.object({ title: Label.min(1), body: Text(300) })).max(CITY_BOUNDS.tour),
});
export type Ui = z.infer<typeof Ui>;

// ── The city ───────────────────────────────────────────────────────────────────────────

export const CITY_SPEC_FORMAT = "aye.city" as const;

export const CitySpec = z
  .object({
    format: z.literal(CITY_SPEC_FORMAT),
    version: z.literal(2),
    author: ModelRef,
    /** Hash of the brief it was written from. */
    brief: ArtifactHash,
    name: Label.min(1),
    tagline: Text(160),
    icon: Icon,
    currency: CurrencyCode,
    theme: Theme,
    /** The needs everyone here has; places are written to use these. */
    needs: z.array(NeedDef).min(1).max(12),
    /** What stays with people here: the skills, belongings and standing that matter. */
    marks: z.array(MarkDef).max(CITY_BOUNDS.marks).default([]),
    economy: Economy,
    sun: Sun,
    words: Words,
    /** What someone waiting for this city reads, in order, as it's built. Display only. */
    buildingLines: z.array(z.string().min(1).max(BUILDING_LINE_MAX)).max(6).default([]),
    /** The kinds of things this city is made of, with their traits. */
    kinds: z.array(Kind).min(1).max(KIND_BOUNDS.kinds),
    /** Everything on its map: items of those kinds. */
    items: z.array(Item).min(1).max(KIND_BOUNDS.items),
    starts: z.array(StartDef).min(1).max(CITY_BOUNDS.starts),
    /** Skin tones and outfit colours a new arrival can pick from. */
    looks: z.object({
      skin: z.array(Colour).min(1).max(CITY_BOUNDS.looks),
      outfit: z.array(Colour).min(2).max(CITY_BOUNDS.looks),
      hair: z.array(Colour).max(CITY_BOUNDS.looks).default([]),
    }),
    /** Looks new arrivals choose from, recoloured with the palettes above. */
    characters: z.array(PersonLook).max(CITY_BOUNDS.characterLooks).default([]),
    /** Rigged library outfits new arrivals choose from; empty: `characters`. */
    outfits: z.array(AssetId).max(CITY_BOUNDS.characterLooks).default([]),
    /** Who lives here and what their day looks like; empty until populated. */
    population: Population.default({ groups: [] }),
    /**
     * A real place on Earth, laid on its real roads: where its map's north-west corner is,
     * how big the map is, its road network and land cover (artifacts, OpenStreetMap).
     * Absent: a city sketched by a model on a CITY_BOUNDS.mapM square.
     */
    real: z
      .strictObject({
        origin: z.strictObject({
          lat: z.number().min(-85).max(85),
          lon: z.number().min(-180).max(180),
        }),
        extentM: z.tuple([
          z.int().min(100).max(CITY_BOUNDS.realMapM),
          z.int().min(100).max(CITY_BOUNDS.realMapM),
        ]),
        network: ArtifactHash,
        /** What covers the ground (water, land use: `LandCover`), if it was fetched. */
        land: ArtifactHash.optional(),
      })
      .optional(),
    headlines: z.array(Headline).max(CITY_BOUNDS.headlines),
    /** What the city is going through: its director's events (empty until it starts). */
    events: z.array(CityEvent).max(EVENT_BOUNDS.events).default([]),
    ui: Ui,
  })
  .superRefine((city, ctx) => {
    for (const issue of cityIssues(city)) ctx.addIssue({ code: "custom", message: issue });
  });
export type CitySpec = z.infer<typeof CitySpec>;

function intentTargets(intent: Intent): { app?: string; place?: string; panel?: string } {
  if (intent.do === "open_app") return { app: intent.app };
  if (intent.do === "show_place") return { place: intent.place };
  if (intent.do === "panel") return { panel: intent.panel };
  return {};
}

/**
 * Every broken reference or duplicate in a city, in words a model can act on. Empty means it
 * is consistent; whether it is a good city is for the critique to say.
 */
export function cityIssues(city: {
  needs: NeedDef[];
  events?: CityEvent[];
  kinds: Kind[];
  items: Item[];
  starts: StartDef[];
  ui: Ui;
}): string[] {
  const issues: string[] = [];
  const dupes = (what: string, keys: string[]) => {
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k)) issues.push(`${what} "${k}" is defined twice`);
      seen.add(k);
    }
  };
  dupes(
    "need",
    city.needs.map((n) => n.key),
  );
  issues.push(...kindIssues(city));
  const { places: placeList, movers } = viewsOf(city);
  issues.push(...eventIssues(city.events ?? [], { places: placeList, movers }));
  if (placeList.length === 0) issues.push("the city has no places to go into");
  if (movers.length === 0) issues.push("the city has no way to get around");
  dupes(
    "start",
    city.starts.map((s) => s.key),
  );
  dupes(
    "app",
    city.ui.apps.map((a) => a.key),
  );
  dupes(
    "panel",
    city.ui.panels.map((d) => d.key),
  );
  const needs = new Set(city.needs.map((n) => n.key));
  const places = new Map(placeList.map((p) => [p.key, p]));
  const apps = new Set(city.ui.apps.map((a) => a.key));
  const panels = new Set(city.ui.panels.map((d) => d.key));
  for (const d of city.ui.panels) {
    for (const a of d.apps) {
      if (!apps.has(a)) issues.push(`panel "${d.key}" has unknown app "${a}"`);
    }
  }

  for (const s of city.starts) {
    const home = places.get(s.home);
    if (!home) issues.push(`start "${s.key}" has unknown home "${s.home}"`);
    else if (!home.private)
      issues.push(`start "${s.key}" home "${s.home}" must be a private place`);
  }
  const checkIntent = (intent: Intent, at: string) => {
    const t = intentTargets(intent);
    if (t.app !== undefined && !apps.has(t.app)) issues.push(`${at} opens unknown app "${t.app}"`);
    if (t.panel !== undefined && !panels.has(t.panel)) {
      issues.push(`${at} opens unknown panel "${t.panel}"`);
    }
    if (t.place !== undefined && !places.has(t.place)) {
      issues.push(`${at} shows unknown place "${t.place}"`);
    }
  };
  const checkNeed = (need: string | null, at: string) => {
    if (need !== null && !needs.has(need)) issues.push(`${at} uses unknown need "${need}"`);
  };
  for (const [screen, layout] of [
    ["map", city.ui.map],
    ["place", city.ui.place],
  ] as const) {
    dupes(
      `${screen} region`,
      layout.map((s) => s.region),
    );
    for (const slot of layout) {
      for (const [i, w] of slot.widgets.entries()) {
        const at = `${screen} ${slot.region} widget ${i}`;
        if (w.type === "button") checkIntent(w.intent, at);
        if (w.type === "panel") checkIntent({ do: "panel", panel: w.panel }, at);
      }
    }
  }
  for (const app of city.ui.apps) {
    for (const [i, b] of app.blocks.entries()) {
      const at = `app "${app.key}" block ${i}`;
      if (b.type === "button") checkIntent(b.intent, at);
      if (b.type === "stat" && b.value.of === "need") checkNeed(b.value.need, at);
      if (b.type === "list" && b.source.from === "actions") checkNeed(b.source.need, at);
    }
  }
  return issues;
}

/**
 * How big a place's building is drawn on the map, in metres (width, height, depth): bigger
 * than life and chunkier, so every building reads from above. The same box its look is designed
 * and judged in.
 */
export function mapBlock(place: Pick<CityPlace, "sizeM" | "heightM">): [number, number, number] {
  const w = Math.max(70, place.sizeM[0] * 2.4);
  const d = Math.max(70, place.sizeM[1] * 2.4);
  const h = Math.max(24, place.heightM * 2.4, Math.max(w, d) * 0.45);
  return [w, h, d];
}

/** Straight-line distance between two places, metres (integer). */
export function distanceM(a: Pick<CityPlace, "at">, b: Pick<CityPlace, "at">): number {
  const dx = a.at[0] - b.at[0];
  const dz = a.at[1] - b.at[1];
  return Math.round(Math.sqrt(dx * dx + dz * dz));
}

/** The default longest trip, real seconds (`WorldSettings.tripMaxRealSec`). */
export const TRIP_MAX_REAL_SEC = 60;

/**
 * How fast trips go compared with life, permille (1000: as in life), so that the slowest way
 * to get around, across the city's farthest two places, takes at most `maxRealSec` real
 * seconds at `ticksPerRealSecond`. One factor for every mode, so faster ones stay faster.
 * `maxRealSec` 0: as in life.
 */
export function tripPacePermille(
  city: Pick<CitySpec, "kinds" | "items">,
  settings: { ticksPerRealSecond: number; tripMaxRealSec?: number },
): number {
  // Worlds made before the setting existed get its default.
  const maxRealSec = settings.tripMaxRealSec ?? TRIP_MAX_REAL_SEC;
  const { movers, places } = viewsOf(city);
  if (maxRealSec <= 0 || movers.length === 0) return 1000;
  const slowest = Math.min(...movers.map((m) => m.speedKmh));
  let farthest = 0;
  for (const a of places) for (const b of places) farthest = Math.max(farthest, distanceM(a, b));
  const longest = (Math.round((farthest * 13) / 10) * 60) / (slowest * 1000); // city minutes
  const allowed = (maxRealSec * settings.ticksPerRealSecond) / 60; // city minutes
  return longest <= allowed ? 1000 : Math.max(1, Math.floor((allowed * 1000) / longest));
}

/**
 * A trip by one mode: road distance (straight line × 1.3, cities aren't straight), whole
 * minutes at its speed (at least one), sped up by `pacePermille` (see `tripPacePermille`),
 * and the fare in minor units (by distance, never sped up).
 */
export function trip(
  mode: Pick<CityMover, "speedKmh" | "fare">,
  from: Pick<CityPlace, "at">,
  to: Pick<CityPlace, "at">,
  pacePermille = 1000,
): { minutes: number; fare: number; metres: number } {
  const metres = Math.round((distanceM(from, to) * 13) / 10);
  const minutes = Math.max(
    1,
    Math.ceil((metres * 60 * pacePermille) / (mode.speedKmh * 1000 * 1000)),
  );
  const fare = mode.fare.base + Math.floor((mode.fare.perKm * metres) / 1000);
  return { minutes, fare, metres };
}
