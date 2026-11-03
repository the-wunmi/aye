/**
 * The city harness: a model writes a whole playable city (map, travel, needs, starts, theme,
 * HUD layout, its panels and their apps), code compiles it into a bounded `CitySpec`, a critique checks it
 * plays and reads well, and the model fixes what came back, until it works.
 *
 *   brief ─ author-city (model) ─ draft ─ compile-city (code) ─ spec ─ critique
 *             ▲                                                         │
 *             └────────── revise-city (model), given every finding ◄────┘
 *
 * As with worlds (world.ts), the model chooses names, words, numbers and colours; code derives
 * every key from names, clamps every number to `CITY_BOUNDS`, accepts only real colours and
 * single emoji, and reports in plain words anything it had to change. The critique holds the
 * interface to what makes a game playable (you can see your money and needs, get back to the
 * map, reach the phone, talk to people, afford to move) and legible (text contrast).
 *
 * Places are only described here. Each is built afterwards from its description (layout, then
 * its world, written knowing the city's needs) by whoever runs the harness.
 */
import type { ArtifactStore, RecipeIndex } from "@aye/artifacts";
import {
  type ArtifactHash,
  type ArtifactRef,
  type Block,
  CITY_BOUNDS,
  CITY_SPEC_FORMAT,
  CitySpec,
  type Hours,
  type HudRegion,
  type Intent,
  isOpen,
  type Layout,
  type ModelRef,
  moversOf,
  placesOf,
  type StageRecord,
  type StartDef,
  viewsOf,
  type Widget,
  WORD_KEYS,
  WORLD_BOUNDS,
  type Words,
} from "@aye/schema";
import { cleanText } from "./assemble.ts";
import { compileKinds, draftOfKinds } from "./city-kinds.ts";
import {
  CityBrief,
  CityDraft,
  type DraftBlock,
  type DraftIntent,
  type DraftWidget,
} from "./contracts.ts";
import { clamp, colour, icon, PIN } from "./draft-values.ts";
import { buildingTile, type LookToJudge, lookTile, personTile } from "./looks.ts";
import type { CityAuthor } from "./providers.ts";
import { json, readJson, runStage, type StageDeps, type StageResult } from "./stage.ts";
import { compilePersonLook, draftOfPersonLook, keyOf, type WorldCritique } from "./world.ts";

/** Bump when the authoring loop's wiring or the brief's shape changes. */
/** The least a money goal in someone's aim should come to, in hours of ordinary work. */
const AIM_LEAST_HOURS = 30;

/** What a critique takes as an ordinary ride, to judge a fare by. */
const TYPICAL_RIDE_KM = 5;

export const CITY_HARNESS_VERSION = 2;
/** Bump when draft → spec compilation changes. */
/** How many hours of ordinary work a day the bills should come to, at most and at least. */
const BILLS_MOST_HOURS_A_DAY = 4;
const BILLS_LEAST_HOURS_A_DAY = 2;

export const CITY_COMPILER_VERSION = 14;
/** Bump when the critique's rules change. */
export const CITY_CRITIQUE_VERSION = 14;

/** A sum code had to change, up to two significant figures: a price someone would really name. */
function roundUpNicely(amount: number): number {
  let unit = 1;
  while (amount / unit >= 100) unit *= 10;
  return Math.ceil(amount / unit) * unit;
}

/** Minutes of the day when none of these is open. */
function shutMinutes(places: readonly { hours: Hours }[]): number {
  let shut = 0;
  for (let minute = 0; minute < 1440; minute++) {
    if (!places.some((p) => isOpen(p.hours, minute))) shut++;
  }
  return shut;
}

// ── Compile: draft → bounded spec ─────────────────────────────────────────────────────

export function compileCity(args: {
  draft: CityDraft;
  briefHash: ArtifactHash;
  author: ModelRef;
}): { spec: CitySpec | null; issues: string[] } {
  const { draft } = args;
  const B = CITY_BOUNDS;
  const issues: string[] = [];
  const seen = (what: string) => {
    const keys = new Set<string>();
    return (key: string, name: string) => {
      if (keys.has(key)) {
        issues.push(
          `${what} "${cleanText(name, 80)}" has the same name as another; kept the first.`,
        );
        return false;
      }
      keys.add(key);
      return true;
    };
  };

  const t = draft.theme;
  const theme = {
    font: t.font,
    radiusPx: clamp(t.radiusPx, 0, B.radiusPx),
    colours: {
      bg: colour(t.bg, "#f6f3ec", issues, "theme bg"),
      surface: colour(t.surface, "#ffffff", issues, "theme surface"),
      ink: colour(t.ink, "#1d1b16", issues, "theme ink"),
      muted: colour(t.muted, "#6b665b", issues, "theme muted"),
      accent: colour(t.accent, "#1a7f4e", issues, "theme accent"),
      onAccent: colour(t.onAccent, "#ffffff", issues, "theme onAccent"),
      good: colour(t.good, "#1a7f4e", issues, "theme good"),
      warn: colour(t.warn, "#c98a00", issues, "theme warn"),
      bad: colour(t.bad, "#c0392b", issues, "theme bad"),
      land: colour(t.land, "#d8e6cf", issues, "theme land"),
      water: colour(t.water, "#5aa9d6", issues, "theme water"),
      road: colour(t.road, "#9a9a96", issues, "theme road"),
      built: colour(t.built, "#b9ad97", issues, "theme built"),
      industrial: colour(t.industrial, "#9c8f86", issues, "theme industrial"),
      green: colour(t.green, "#8fc27a", issues, "theme green"),
    },
  };

  const needOk = seen("need");
  const needs = draft.needs
    .map((n) => ({
      key: keyOf(n.name),
      label: cleanText(n.name, 80) || "Need",
      decayPerHour: clamp(n.decayPerHour, 0, WORLD_BOUNDS.needDecayPerHour),
      ...(n.whenEmpty && cleanText(n.whenEmpty.feeling, 80)
        ? {
            whenEmpty: {
              payPermille: clamp(n.whenEmpty.payPermille, WORLD_BOUNDS.emptyLeastPermille, 1000),
              walkPermille: clamp(n.whenEmpty.walkPermille, WORLD_BOUNDS.emptyLeastPermille, 1000),
              feeling: cleanText(n.whenEmpty.feeling, 80),
            },
          }
        : {}),
    }))
    .filter((n) => needOk(n.key, n.label))
    .slice(0, 12);
  const needKeys = new Set(needs.map((n) => n.key));
  const markOk = seen("mark");
  const marks = draft.marks
    .map((m) => ({
      key: keyOf(m.name),
      label: cleanText(m.name, 80) || "Mark",
      max: clamp(m.max, 1, WORLD_BOUNDS.markMax),
      shown: m.shown,
    }))
    .filter((m) => markOk(m.key, m.label))
    .slice(0, B.marks);

  const { kinds, items } = compileKinds(draft, issues, B.mapM);
  // A ride has to be worth what it costs against an hour's work, or nobody takes it over
  // walking. A number that's out of proportion is ours to bound, not a reason to lose a city.
  const hourPay = clamp(draft.hourPay, 1, B.money);
  for (const k of kinds) {
    const m = k.traits.mover;
    if (!m) continue;
    const ride = m.fare.base + m.fare.perKm * TYPICAL_RIDE_KM;
    const most = Math.floor(hourPay / 2);
    if (ride > most) {
      m.fare = {
        base: Math.floor((m.fare.base * most) / ride),
        perKm: Math.floor((m.fare.perKm * most) / ride),
      };
    }
  }
  const views = viewsOf({ kinds, items });
  const placeByKey = new Map(views.places.map((p) => [p.key, p]));
  if (views.places.length === 0) issues.push("The city has no places to go into.");
  if (views.movers.length === 0) issues.push("The city has no way to get around (a mover).");

  const economy = {
    hourPay: clamp(draft.hourPay, 1, B.money),
    bills: draft.bills.slice(0, B.bills).flatMap((b) => {
      const name = cleanText(b.name, 80);
      if (!name) return [];
      return [
        {
          name,
          amount: clamp(b.amount, 1, B.money),
          everyDays: clamp(b.everyDays, 1, B.billEveryDays),
          ...(b.pays ? { pays: true } : {}),
          ...(b.whenMark.trim()
            ? { when: { mark: keyOf(b.whenMark), atLeast: clamp(b.whenAtLeast, 1, 1_000) } }
            : {}),
        },
      ];
    }),
  };
  // What everyone has to pay should mean something next to what they can earn: the model's sums
  // stay in proportion to each other, and are raised together.
  const everyone = economy.bills.filter((b) => !b.pays && !b.when);
  const billedPerDay = everyone.reduce((sum, b) => sum + b.amount / b.everyDays, 0);
  const leastPerDay = economy.hourPay * BILLS_LEAST_HOURS_A_DAY;
  if (billedPerDay > 0 && billedPerDay < leastPerDay) {
    for (const b of everyone) {
      b.amount = clamp(roundUpNicely((b.amount * leastPerDay) / billedPerDay), 1, B.money);
    }
  }
  if (draft.hourPay < 1) issues.push("hourPay must be what an hour of ordinary work pays here.");
  const sun = { rises: clamp(draft.sunrise, 0, 1439), sets: clamp(draft.sunset, 0, 1439) };
  const words = Object.fromEntries(
    WORD_KEYS.map((k) => {
      const w = cleanText(draft.words[k], 40);
      if (!w) issues.push(`words.${k} is empty: say it in the city's own words.`);
      return [k, w || k];
    }),
  ) as Words;

  const startOk = seen("start");
  const starts = draft.starts
    .flatMap((s) => {
      const home = keyOf(s.home);
      const where = `start "${cleanText(s.name, 40)}"`;
      const place = placeByKey.get(home);
      if (!place) {
        issues.push(`${where} has home "${cleanText(s.home, 40)}", which isn't a place; dropped.`);
        return [];
      }
      if (!place.private) {
        issues.push(`${where} has home "${place.name}", which isn't private; homes must be.`);
        return [];
      }
      type AimStep = NonNullable<StartDef["aim"]>["steps"][number];
      const aimSteps = (s.aim?.steps ?? []).slice(0, B.aimSteps).flatMap((st): AimStep[] => {
        const text = cleanText(st.text, 160);
        if (!text) return [];
        if (!st.mark.trim()) {
          // A life goal is days of work. If it has to be raised, a sum in its words goes with it;
          // the screen shows how far along they are in real numbers anyway.
          const least = economy.hourPay * AIM_LEAST_HOURS;
          if (st.atLeast >= least) return [{ money: clamp(st.atLeast, 1, B.money), text }];
          return [
            {
              money: clamp(roundUpNicely(least), 1, B.money),
              text: /\d/.test(text) ? "Save up" : text,
            },
          ];
        }
        const mark = marks.find((m) => m.key === keyOf(st.mark));
        if (!mark) {
          issues.push(
            `${where}: its aim asks for "${cleanText(st.mark, 40)}", which isn't a mark.`,
          );
          return [];
        }
        return [{ mark: mark.key, atLeast: clamp(st.atLeast, 1, mark.max), text }];
      });
      const aim =
        s.aim && aimSteps.length > 0
          ? {
              aim: {
                title: cleanText(s.aim.title, 80) || "Get ahead",
                about: cleanText(s.aim.about, 200),
                icon: icon(s.aim.icon, "\u{2B50}", issues, where),
                reward: clamp(s.aim.reward, 0, B.money),
                steps: aimSteps,
              },
            }
          : {};
      return [
        {
          ...aim,
          key: keyOf(s.name),
          label: cleanText(s.name, 80) || "Start",
          blurb: cleanText(s.blurb, 200),
          money: clamp(s.money, 0, B.money),
          home,
        },
      ];
    })
    .filter((s) => startOk(s.key, s.label))
    .slice(0, B.starts);

  const palette = (list: string[], what: string) =>
    [...new Set(list.map((c) => colour(c, "", issues, what)).filter(Boolean))].slice(0, B.looks);
  const looks = {
    skin: palette(draft.skinTones, "skin tone"),
    outfit: palette(draft.outfitColours, "outfit colour"),
    hair: palette(draft.hairColours, "hair colour"),
  };
  const characters = draft.characters.slice(0, B.characterLooks).flatMap((c, i) => {
    const look = compilePersonLook(
      c.look,
      c.heightMm,
      issues,
      `character look ${i} (${cleanText(c.name, 40)})`,
    );
    return look ? [look] : [];
  });
  const headlines = draft.headlines
    .slice(0, B.headlines)
    .map((h) => ({
      icon: icon(h.icon, "\u{1F4F0}", issues, "headline"),
      text: cleanText(h.text, 160),
    }))
    .filter((h) => h.text);

  const appOk = seen("app");
  const appNames = new Map(draft.apps.map((a) => [keyOf(a.name), a.name]));
  const panelNames = new Map(draft.panels.map((d) => [keyOf(d.name), d.name]));
  const panelRef = (name: string, where: string): string | null => {
    const key = keyOf(name);
    if (panelNames.has(key)) return key;
    if (panelNames.size > 0 && !name.trim()) return keyOf(draft.panels[0]?.name ?? "");
    issues.push(`${where} opens panel "${cleanText(name, 40)}", which doesn't exist.`);
    return null;
  };
  const intentOf = (i: DraftIntent, where: string): Intent | null => {
    switch (i.do) {
      case "map":
      case "tour":
        return { do: i.do };
      case "panel": {
        const panel = panelRef(i.target, where);
        return panel ? { do: "panel", panel } : null;
      }
      case "open_app": {
        const app = keyOf(i.target);
        if (appNames.has(app)) return { do: "open_app", app };
        issues.push(`${where} opens app "${cleanText(i.target, 40)}", which doesn't exist.`);
        return null;
      }
      case "show_place": {
        const place = keyOf(i.target);
        if (placeByKey.has(place)) return { do: "show_place", place };
        issues.push(`${where} shows place "${cleanText(i.target, 40)}", which doesn't exist.`);
        return null;
      }
      default:
        issues.push(`${where} is a button that does nothing; dropped.`);
        return null;
    }
  };
  const needRef = (name: string, where: string): string | null => {
    if (!name.trim()) return null;
    const key = keyOf(name);
    if (needKeys.has(key)) return key;
    issues.push(
      `${where} uses need "${cleanText(name, 40)}", which isn't one of the city's needs.`,
    );
    return null;
  };

  const widgetOf = (w: DraftWidget, where: string): Widget | null => {
    switch (w.type) {
      case "clock":
        return { type: "clock", style: w.style === "sun" ? "sun" : "digital" };
      case "needs":
        return {
          type: "needs",
          style: w.style === "rings" || w.style === "chips" ? w.style : "bars",
          show: w.show,
        };
      case "text": {
        const text = cleanText(w.text, 160);
        return text ? { type: "text", text, tone: w.tone } : null;
      }
      case "button": {
        const intent = intentOf(w.intent, where);
        const label = cleanText(w.label, 80);
        if (!intent || !label) return null;
        return { type: "button", label, icon: icon(w.icon, PIN, issues, where), intent };
      }
      case "panel": {
        const panel = panelRef(w.label, where);
        return panel ? { type: "panel", panel } : null;
      }
      default:
        return { type: w.type };
    }
  };
  const layoutOf = (draftLayout: CityDraft["map"], screen: string): Layout => {
    const regions = new Set<string>();
    const out: Layout = [];
    for (const slot of draftLayout) {
      if (regions.has(slot.region)) {
        issues.push(`${screen} screen lists region ${slot.region} twice; kept the first.`);
        continue;
      }
      regions.add(slot.region);
      const widgets = slot.widgets
        .map((w, i) => widgetOf(w, `${screen} ${slot.region} widget ${i}`))
        .filter((w): w is Widget => w !== null);
      if (widgets.length > B.widgetsPerRegion) {
        issues.push(
          `${screen} ${slot.region} has ${widgets.length} widgets; only ${B.widgetsPerRegion} fit.`,
        );
      }
      out.push({ region: slot.region, widgets: widgets.slice(0, B.widgetsPerRegion) });
    }
    return out.slice(0, 8);
  };

  const blockOf = (b: DraftBlock, where: string): Block | null => {
    switch (b.type) {
      case "heading":
      case "text": {
        const text = cleanText(b.text, b.type === "heading" ? 80 : 300);
        return text ? { type: b.type, text } : null;
      }
      case "stat": {
        const label = cleanText(b.label, 80);
        if (!label) {
          issues.push(`${where}: a stat with no label doesn't say what it's counting.`);
          return null;
        }
        if (b.value === "need") {
          const need = needRef(b.need, where);
          return need ? { type: "stat", label, value: { of: "need", need } } : null;
        }
        return { type: "stat", label, value: { of: b.value } };
      }
      case "button": {
        const intent = intentOf(b.intent, where);
        const label = cleanText(b.label, 80);
        return intent && label ? { type: "button", label, intent } : null;
      }
      case "list": {
        const limit = clamp(b.limit, 1, 20);
        const empty = cleanText(b.empty, 120);
        if (b.source === "actions") {
          const sort = b.sort === "cheapest" || b.sort === "name" ? b.sort : "best_paid";
          return {
            type: "list",
            source: { from: "actions", filter: b.filter, need: needRef(b.need, where), sort },
            limit,
            empty,
          };
        }
        if (b.source === "places") {
          return {
            type: "list",
            source: {
              from: "places",
              tag: b.tag.trim() ? keyOf(b.tag) : null,
              openNow: b.openNow,
              sort: b.sort === "name" ? "name" : "nearest",
            },
            limit,
            empty,
          };
        }
        return { type: "list", source: { from: b.source }, limit, empty };
      }
    }
  };
  const apps = draft.apps
    .map((a) => {
      const where = `app "${cleanText(a.name, 40)}"`;
      return {
        key: keyOf(a.name),
        label: cleanText(a.name, 80) || "App",
        icon: icon(a.icon, "\u{1F4F1}", issues, where),
        colour: colour(a.colour, theme.colours.accent, issues, where),
        blocks: a.blocks
          .map((b, i) => blockOf(b, `${where} block ${i}`))
          .filter((b): b is Block => b !== null)
          .slice(0, B.blocksPerApp),
      };
    })
    .filter((a) => {
      if (a.blocks.length === 0) issues.push(`app "${a.label}" has nothing in it; dropped.`);
      return a.blocks.length > 0 && appOk(a.key, a.label);
    })
    .slice(0, B.apps);
  const appKeys = new Set(apps.map((a) => a.key));
  const panelOk = seen("panel");
  const panels = draft.panels
    .map((d) => {
      const where = `panel "${cleanText(d.name, 40)}"`;
      const carried = d.apps.map(keyOf).filter((k, i) => {
        if (appKeys.has(k)) return true;
        issues.push(`${where} has app "${cleanText(d.apps[i] ?? "", 40)}", which doesn't exist.`);
        return false;
      });
      return {
        key: keyOf(d.name),
        label: cleanText(d.name, 80) || "Panel",
        icon: icon(d.icon, PIN, issues, where),
        form: d.form,
        apps: [...new Set(carried)].slice(0, B.apps),
      };
    })
    .filter((d) => {
      if (d.apps.length === 0) issues.push(`panel "${d.label}" has no apps; dropped.`);
      return d.apps.length > 0 && panelOk(d.key, d.label);
    })
    .slice(0, B.panels);

  let currency = draft.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    issues.push(`currency "${cleanText(draft.currency, 8)}" isn't an ISO code; used USD.`);
    currency = "USD";
  }

  const candidate = {
    format: CITY_SPEC_FORMAT,
    version: 2,
    author: args.author,
    brief: args.briefHash,
    name: cleanText(draft.name, 80) || "A city",
    tagline: cleanText(draft.tagline, 160),
    icon: icon(draft.icon, "\u{1F3D9}\u{FE0F}", issues, "city"),
    currency,
    theme,
    needs,
    economy,
    marks,
    sun,
    words,
    kinds,
    items,
    starts,
    looks,
    characters,
    headlines,
    ui: {
      map: layoutOf(draft.map, "map"),
      place: layoutOf(draft.place, "place"),
      apps,
      panels,
      tour: draft.tour
        .slice(0, B.tour)
        .map((s) => ({ title: cleanText(s.title, 80) || "Tip", body: cleanText(s.body, 300) })),
    },
  };
  const parsed = CitySpec.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 20)) {
      issues.push(`${issue.path.join(".") || "city"}: ${issue.message}`);
    }
    return { spec: null, issues };
  }
  return { spec: parsed.data, issues };
}

/** The model-facing form of a spec: what a revision starts from, and what fakes answer. */
export function draftOfCity(city: CitySpec): CityDraft {
  const placeName = new Map(placesOf(city).map((p) => [p.key, p.name]));
  const appName = new Map(city.ui.apps.map((a) => [a.key, a.label]));
  const panels = city.ui.panels;
  const panelName = new Map(panels.map((d) => [d.key, d.label]));
  const needName = new Map(city.needs.map((n) => [n.key, n.label]));
  const intent = (i: Intent): DraftIntent =>
    i.do === "open_app"
      ? { do: i.do, target: appName.get(i.app) ?? i.app }
      : i.do === "show_place"
        ? { do: i.do, target: placeName.get(i.place) ?? i.place }
        : i.do === "panel"
          ? { do: i.do, target: panelName.get(i.panel) ?? i.panel }
          : { do: i.do, target: "" };
  const none: DraftIntent = { do: "none", target: "" };
  const widget = (w: Widget): DraftWidget => ({
    type: w.type,
    style: w.type === "clock" || w.type === "needs" ? w.style : "",
    show: w.type === "needs" ? w.show : "all",
    text: w.type === "text" ? w.text : "",
    tone: w.type === "text" ? w.tone : "plain",
    label:
      w.type === "button" ? w.label : w.type === "panel" ? (panelName.get(w.panel) ?? w.panel) : "",
    icon: w.type === "button" ? w.icon : "",
    intent: w.type === "button" ? intent(w.intent) : none,
  });
  const block = (b: Block): DraftBlock => {
    const base: DraftBlock = {
      type: b.type,
      text: "",
      label: "",
      value: "wallet",
      need: "",
      source: "actions",
      filter: "any",
      sort: "",
      tag: "",
      openNow: false,
      limit: 5,
      empty: "",
      intent: none,
    };
    switch (b.type) {
      case "heading":
      case "text":
        return { ...base, text: b.text };
      case "stat":
        return {
          ...base,
          label: b.label,
          value: b.value.of,
          need: b.value.of === "need" ? (needName.get(b.value.need) ?? b.value.need) : "",
        };
      case "button":
        return { ...base, label: b.label, intent: intent(b.intent) };
      case "list": {
        const s = b.source;
        return {
          ...base,
          source: s.from,
          limit: b.limit,
          empty: b.empty,
          filter: s.from === "actions" ? s.filter : "any",
          need: s.from === "actions" && s.need ? (needName.get(s.need) ?? s.need) : "",
          sort: s.from === "actions" || s.from === "places" ? s.sort : "",
          tag: s.from === "places" ? (s.tag ?? "") : "",
          openNow: s.from === "places" ? s.openNow : false,
        };
      }
    }
  };
  return {
    name: city.name,
    tagline: city.tagline,
    icon: city.icon,
    currency: city.currency,
    theme: { font: city.theme.font, radiusPx: city.theme.radiusPx, ...city.theme.colours },
    needs: city.needs.map((n) => ({
      name: n.label,
      decayPerHour: n.decayPerHour,
      whenEmpty: n.whenEmpty ?? null,
    })),
    marks: city.marks.map((m) => ({ name: m.label, max: m.max, shown: m.shown })),
    hourPay: city.economy.hourPay,
    bills: city.economy.bills.map((b) => ({
      name: b.name,
      amount: b.amount,
      everyDays: b.everyDays,
      pays: b.pays ?? false,
      whenMark: b.when?.mark ?? "",
      whenAtLeast: b.when?.atLeast ?? 0,
    })),
    sunrise: city.sun.rises,
    sunset: city.sun.sets,
    words: city.words,
    ...draftOfKinds(city),
    starts: city.starts.map((s) => ({
      aim: s.aim
        ? {
            title: s.aim.title,
            about: s.aim.about,
            icon: s.aim.icon,
            reward: s.aim.reward,
            steps: s.aim.steps.map((st) =>
              "mark" in st
                ? {
                    mark: city.marks.find((m) => m.key === st.mark)?.label ?? st.mark,
                    atLeast: st.atLeast,
                    text: st.text,
                  }
                : { mark: "", atLeast: st.money, text: st.text },
            ),
          }
        : null,
      name: s.label,
      blurb: s.blurb,
      money: s.money,
      home: placeName.get(s.home) ?? s.home,
    })),
    skinTones: city.looks.skin,
    outfitColours: city.looks.outfit,
    hairColours: city.looks.hair,
    characters: city.characters.map((c, i) => ({
      name: `Look ${i + 1}`,
      heightMm: c.heightMm,
      look: draftOfPersonLook(c),
    })),
    headlines: city.headlines,
    map: city.ui.map.map((s) => ({ region: s.region, widgets: s.widgets.map(widget) })),
    place: city.ui.place.map((s) => ({ region: s.region, widgets: s.widgets.map(widget) })),
    apps: city.ui.apps.map((a) => ({
      name: a.label,
      icon: a.icon,
      colour: a.colour,
      blocks: a.blocks.map(block),
    })),
    panels: panels.map((d) => ({
      name: d.label,
      icon: d.icon,
      form: d.form,
      apps: d.apps.map((k) => appName.get(k) ?? k),
    })),
    tour: city.ui.tour,
  };
}

// ── Critique: is it playable and legible? ─────────────────────────────────────────────

/** WCAG relative luminance of #rrggbb. */
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, 1..21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function inside([x, z]: [number, number], polygon: [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i] as [number, number];
    const [xj, zj] = polygon[j] as [number, number];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/** What makes a city unplayable or hard to read, in words the author can act on. */
export function critiqueCity(city: CitySpec): WorldCritique[] {
  const out: WorldCritique[] = [];
  const error = (message: string) => out.push({ severity: "error", message });
  const warn = (message: string) => out.push({ severity: "warning", message });
  const c = city.theme.colours;

  const legible = [
    ["ink", "bg", 4.5, error],
    ["ink", "surface", 4.5, error],
    ["onAccent", "accent", 4.5, error],
    ["muted", "surface", 3, warn],
  ] as const;
  for (const [text, behind, min, report] of legible) {
    const ratio = contrast(c[text], c[behind]);
    if (ratio < min) {
      report(
        `${text} text on ${behind} has contrast ${ratio.toFixed(1)}:1; it needs at least ${min}:1 to be readable.`,
      );
    }
  }
  for (const app of city.ui.apps) {
    if (contrast(c.onAccent, app.colour) < 3) {
      warn(`app "${app.label}" colour is too light or dark for its label; pick one with contrast.`);
    }
  }

  const widgetsOn = (layout: Layout) => layout.flatMap((s) => s.widgets);
  const place = widgetsOn(city.ui.place);
  const map = widgetsOn(city.ui.map);
  const has = (ws: Widget[], type: Widget["type"]) => ws.some((w) => w.type === type);
  const buttonTo = (ws: Widget[], d: Intent["do"]) =>
    ws.some((w) => w.type === "button" && w.intent.do === d);
  if (!has(place, "wallet")) error("Inside a place, players can't see their money: add a wallet.");
  if (!has(place, "needs")) error("Inside a place, players can't see their needs: add needs.");
  for (const p of placesOf(city)) {
    for (const x of p.asks ?? []) {
      if (!city.marks.some((m) => m.key === x.mark)) {
        error(`${p.name} asks for "${x.mark}", which isn't one of the city's marks.`);
      }
    }
  }
  const paidMovers = moversOf(city).filter(
    (m) => m.serves.length > 0 && (m.fare.base > 0 || m.fare.perKm > 0),
  );
  for (const s of city.starts) {
    if (paidMovers.length > 0 && !paidMovers.some((m) => m.serves.includes(s.home))) {
      error(
        `${s.label} starts at home in "${s.home}", and none of the city's paid transport stops there. Add it to one's serves list.`,
      );
    }
  }
  if (city.starts.some((s) => !s.aim)) {
    error("Every start needs an aim: what someone starting this way is working towards.");
  }
  for (const s of city.starts) {
    for (const step of s.aim?.steps ?? []) {
      if ("money" in step && step.money < city.economy.hourPay * AIM_LEAST_HOURS) {
        error(
          `${s.label}'s aim asks for ${step.money}, which is soon earned. A life goal is days of work: at least ${AIM_LEAST_HOURS} hours' pay (${city.economy.hourPay * AIM_LEAST_HOURS}), and say the same number in its words.`,
        );
      }
    }
  }
  if (city.marks.length < 2) {
    error(
      "Nothing stays with people here from place to place: add marks for the skills, belongings and standing that matter.",
    );
  }
  // What everyone pays, whatever they have: that's what has to bite and stay fair.
  const perDay = city.economy.bills
    .filter((b) => !b.pays && !b.when)
    .reduce((sum, b) => sum + b.amount / b.everyDays, 0);
  if (city.economy.bills.length === 0) {
    error("Nobody here ever has to pay for anything: add the bills people have to keep paying.");
  } else if (perDay > city.economy.hourPay * BILLS_MOST_HOURS_A_DAY) {
    error(
      `Bills come to more than ${BILLS_MOST_HOURS_A_DAY} hours of ordinary work a day: nobody could keep up.`,
    );
  } else if (perDay < city.economy.hourPay * BILLS_LEAST_HOURS_A_DAY) {
    error(
      `Bills come to under ${BILLS_LEAST_HOURS_A_DAY} hour of ordinary work a day: they'd never bite.`,
    );
  }
  if (!city.needs.some((n) => n.whenEmpty)) {
    error(
      "Running out of a need costs nobody anything: say what it costs for the ones that matter.",
    );
  }
  if (!has(place, "chat")) error("Inside a place, players can't talk to each other: add chat.");
  if (!has(place, "clock") || !has(map, "clock")) {
    error(
      "Players can't tell the time (places open and close by it): add a clock to both screens.",
    );
  }
  if (!buttonTo(place, "map")) {
    error("Inside a place, there's no way back to the map: add a button that opens the map.");
  }
  const panels = city.ui.panels;
  const onPanel = new Set(panels.flatMap((d) => d.apps));
  for (const app of city.ui.apps) {
    if (!onPanel.has(app.key)) error(`App "${app.label}" isn't on any panel: put it on one.`);
  }
  const opens = (ws: Widget[], panel: string) =>
    ws.some(
      (w) =>
        (w.type === "panel" && w.panel === panel) ||
        (w.type === "button" && w.intent.do === "panel" && w.intent.panel === panel),
    );
  for (const d of panels) {
    if (!opens(place, d.key) && !opens(map, d.key)) {
      error(`Panel "${d.label}" can't be opened from any screen: add a panel widget for it.`);
    }
  }
  if (city.ui.apps.length > 0 && panels.length === 0) {
    error("The apps aren't on any panel: give the city at least one panel people carry.");
  }
  if (!has(map, "brand")) warn("The map screen doesn't say which city this is: add the brand.");
  if (!has(place, "clock") && !has(map, "clock")) warn("Nobody can tell the time: add a clock.");
  const listsWork = city.ui.apps.some((a) =>
    a.blocks.some(
      (b) => b.type === "list" && b.source.from === "actions" && b.source.filter === "pays",
    ),
  );
  if (!listsWork) warn("No app shows ways to earn money: list actions that pay somewhere.");
  if (
    !city.ui.apps.some((a) => a.blocks.some((b) => b.type === "list" && b.source.from === "travel"))
  ) {
    warn("No app shows how to get around: list the travel modes somewhere.");
  }
  if (city.ui.tour.length === 0) warn("There's no welcome tour for new players.");
  if (city.headlines.length < 3) warn("The city has little news: write a few headlines.");

  const { places, movers, props, districts, water } = viewsOf(city);
  if (!movers.some((m) => m.fare.base === 0 && m.fare.perKm === 0 && m.hours === null)) {
    error("Someone with no money can't get anywhere: add a free way to travel that always runs.");
  }
  for (const m of movers) {
    if (!m.look) error(`${m.label} has no look: draw what its travellers look like on the map.`);
    for (const t of m.tires) {
      if (!city.needs.some((n) => n.key === t.need)) {
        error(`${m.label} tires people in "${t.need}", which isn't one of the city's needs.`);
      }
    }
    if (m.holds === 0 && m.tires.length === 0) {
      warn(`${m.label} takes nothing out of anyone, so nobody has a reason to pay for a ride.`);
    }
    if (m.serves.length === 1) {
      error(
        `${m.label} only goes to one place, so nobody can ride it anywhere: list where it goes.`,
      );
    }
  }
  if (!has(map, "life")) error("The map doesn't show how the city is living: add the life widget.");
  if (!has(map, "trip") && !has(place, "trip")) {
    error("Nobody can see where they're headed while travelling: add the trip widget.");
  }
  if (!has(map, "threads") || !has(place, "threads")) {
    error(
      "Players can't see what they're in the middle of: add the threads widget to both screens.",
    );
  }
  if (!has(map, "plan")) warn("Planners can't change the roads: add the plan widget to the map.");
  const publicPlaces = places.filter((p) => !p.private);
  // The clock is shared: someone always joins in the middle of the night.
  const shut = shutMinutes(publicPlaces);
  if (shut > 0 && publicPlaces.length > 0) {
    error(
      `Every public place is shut for ${Math.ceil(shut / 60)} hours a day, so anyone who turns up then has nowhere to go and nothing to do but wait: keep the places a city really has open at night open all night.`,
    );
  }
  if (publicPlaces.length < 4) {
    error(
      `Only ${publicPlaces.length} public places: a city needs at least 4 to be worth exploring.`,
    );
  }
  if (places.length > 16) warn("More than 16 places takes long to build; keep it focused.");
  if (districts.length === 0) error("The map has no districts (land areas) for people to live in.");
  for (const p of places) {
    const d = districts.find((x) => x.key === p.district);
    if (d && !inside(p.at, d.polygon)) warn(`${p.name} isn't inside ${d.name} on the map.`);
    if (water.some((w) => inside(p.at, w.polygon))) warn(`${p.name} stands in water.`);
    if (!p.description.trim()) error(`${p.name} has no description to build it from.`);
  }
  for (let i = 0; i < places.length; i++) {
    for (let j = i + 1; j < places.length; j++) {
      const a = places[i] as (typeof places)[number];
      const b = places[j] as (typeof places)[number];
      if (
        Math.abs(a.at[0] - b.at[0]) * 2 < a.sizeM[0] + b.sizeM[0] &&
        Math.abs(a.at[1] - b.at[1]) * 2 < a.sizeM[1] + b.sizeM[1]
      ) {
        warn(`${a.name} and ${b.name} overlap on the map.`);
      }
    }
  }
  if (city.characters.length < 3) {
    error(
      "New arrivals need at least 3 character looks to choose from (people built from shapes).",
    );
  }
  for (const p of places) {
    if ((p.look?.solids.length ?? 0) < 3) {
      warn(`${p.name} has no real look on the map; build it from shapes.`);
    }
  }
  if (props.length === 0)
    warn("The map is bare: add props (kinds that stand on the map) to dress it.");
  if (city.looks.hair.length < 3) warn("Offer at least 3 hair colours for new characters.");
  if (city.looks.skin.length < 3) warn("Offer at least 3 skin tones for new characters.");
  if (city.looks.outfit.length < 4) warn("Offer at least 4 outfit colours for new characters.");
  return out;
}

/** Every building, kind seen on the map and character look, to be looked at. */
export function looksOfCity(city: CitySpec): LookToJudge[] {
  const colours = {
    skin: city.looks.skin[0] ?? "#8d5524",
    top: city.looks.outfit[0] ?? "#1a7f4e",
    bottom: city.looks.outfit[1] ?? "#2c3e50",
    hair: city.looks.hair[0] ?? "#1a1310",
    accent: city.looks.outfit[2] ?? "#f2e6c9",
  };
  return [
    ...placesOf(city).map((p) => ({
      label: `${p.name}: ${p.blurb}`,
      role: `a building on the map of ${city.name}`,
      tile: buildingTile(p),
    })),
    // Every kind seen on the map as itself (movers, props), at its own size.
    ...city.kinds.flatMap((k) =>
      k.look && !k.look.asset && !k.traits.place
        ? [
            {
              label: `${k.name}: ${k.about}`,
              role: k.traits.mover
                ? `how people travelling by ${k.name} look on the map of ${city.name}, front facing +x`
                : `something standing on the map of ${city.name}`,
              tile: lookTile(k.look),
            },
          ]
        : [],
    ),
    ...city.characters.map((c, i) => ({
      label: `Character look ${i + 1}, a person in ${city.name}`,
      role: "a person new players can look like (colours are filled in per player)",
      tile: personTile(c, colours),
    })),
  ];
}

// ── The loop ──────────────────────────────────────────────────────────────────────────

export interface CityDeps {
  author: CityAuthor;
  store: ArtifactStore;
  index: RecipeIndex;
  maxRounds?: number;
  /** Stop as soon as nothing is broken (warnings allowed): a quick first pass. */
  untilNoErrors?: boolean;
  signal?: AbortSignal;
  onStage?: StageDeps["onStage"];
}

export interface CityResult {
  spec: CitySpec | null;
  specRef: ArtifactRef | null;
  findings: WorldCritique[];
  rounds: number;
  stages: StageRecord[];
  cached: number;
}

const badness = (spec: CitySpec | null, findings: readonly WorldCritique[]) =>
  spec === null
    ? Number.POSITIVE_INFINITY
    : findings.reduce((n, f) => n + (f.severity === "error" ? 1000 : 1), 0);

/**
 * What a player can't do without, put back where a model left it out. The layout is the model's
 * to design, but a missing clock isn't worth losing a whole city over once it's had its rounds.
 */
export function repairCity(city: CitySpec): CitySpec {
  const add = (layout: Layout, region: HudRegion, widget: Widget): Layout => {
    const entry = layout.find((s) => s.region === region);
    if (entry && entry.widgets.length < CITY_BOUNDS.widgetsPerRegion) {
      return layout.map((s) => (s === entry ? { ...s, widgets: [...s.widgets, widget] } : s));
    }
    if (!entry) return [...layout, { region, widgets: [widget] }];
    // That region's full: the next with room, so nothing the model chose has to go.
    const room = layout.find((s) => s.widgets.length < CITY_BOUNDS.widgetsPerRegion);
    return room
      ? layout.map((s) => (s === room ? { ...s, widgets: [...s.widgets, widget] } : s))
      : layout;
  };
  const ensure = (layout: Layout, needed: readonly [HudRegion, Widget][]): Layout =>
    needed.reduce(
      (acc, [region, widget]) =>
        acc.some((s) =>
          s.widgets.some(
            (w) =>
              w.type === widget.type &&
              (w.type !== "button" ||
                (widget.type === "button" && w.intent.do === widget.intent.do)),
          ),
        )
          ? acc
          : add(acc, region, widget),
      layout,
    );
  const clock: Widget = { type: "clock", style: "digital" };
  return {
    ...city,
    ui: {
      ...city.ui,
      map: ensure(city.ui.map, [
        ["top_right", clock],
        ["bottom_left", { type: "life" }],
        ["bottom", { type: "trip" }],
        ["right", { type: "threads" }],
      ]),
      place: ensure(city.ui.place, [
        ["top_right", { type: "wallet" }],
        ["top_right", clock],
        ["left", { type: "needs", style: "bars", show: "all" }],
        ["right", { type: "threads" }],
        ["bottom_left", { type: "chat" }],
        [
          "bottom_left",
          { type: "button", label: "Map", icon: "\u{1F5FA}\u{FE0F}", intent: { do: "map" } },
        ],
      ]),
    },
  };
}

/** What really stops anyone living here. Anything else left after revising isn't worth a city. */
export function unplayable(city: CitySpec): string[] {
  const out: string[] = [];
  const places = placesOf(city);
  const movers = moversOf(city);
  if (!places.some((p) => !p.private)) out.push("The city has nowhere public to go.");
  if (city.starts.length === 0) out.push("There's no way to start a life here.");
  for (const s of city.starts) {
    if (!places.some((p) => p.key === s.home)) out.push(`${s.label} has no home to start in.`);
  }
  if (!movers.some((m) => m.fare.base === 0 && m.fare.perKm === 0 && m.hours === null)) {
    out.push("Someone with no money can't get anywhere.");
  }
  if (places.some((p) => !p.description.trim())) out.push("A place has nothing to build it from.");
  return out;
}

export async function authorCity(brief: CityBrief, deps: CityDeps): Promise<CityResult> {
  const valid = CityBrief.parse(brief);
  const signal = deps.signal ?? new AbortController().signal;
  const stageDeps: StageDeps = {
    store: deps.store,
    index: deps.index,
    signal,
    ...(deps.onStage ? { onStage: deps.onStage } : {}),
  };
  const stages: StageRecord[] = [];
  let cached = 0;
  const run = async <K extends string>(
    spec: Parameters<typeof runStage>[0],
    exec: Parameters<typeof runStage<K>>[2],
  ) => {
    const result = await runStage(spec, stageDeps, exec);
    stages.push(result.record);
    if (result.cached) cached++;
    return result;
  };
  const ctx = (seed: number) => ({ store: deps.store, seed, signal });
  const briefRef = await deps.store.put(json(valid).bytes, "application/json");

  let best: CityResult = {
    spec: null,
    specRef: null,
    findings: [{ severity: "error", message: "no city was written" }],
    rounds: 0,
    stages,
    cached: 0,
  };
  let previous: { draftRef: ArtifactRef; draft: CityDraft; findings: WorldCritique[] } | null =
    null;
  const maxRounds = deps.maxRounds ?? 3;
  let rounds = 0;
  for (let round = 0; round < maxRounds; round++) {
    rounds++;
    const findingsRef = previous
      ? await deps.store.put(json(previous.findings).bytes, "application/json")
      : null;
    const authored: StageResult<"draft"> = await run<"draft">(
      {
        stage: previous ? "revise-city" : "author-city",
        version: CITY_HARNESS_VERSION,
        model: deps.author.model,
        prompt: previous ? deps.author.revisePrompt : deps.author.prompt,
        inputs: {
          brief: briefRef.hash,
          ...(previous && findingsRef
            ? { draft: previous.draftRef.hash, findings: findingsRef.hash }
            : {}),
        },
        params: { effort: deps.author.effort, round },
      },
      async (seed) => {
        const raw = previous
          ? await deps.author.revise(
              valid,
              previous.draft,
              previous.findings.map((f) => `${f.severity}: ${f.message}`),
              ctx(seed),
            )
          : await deps.author.author(valid, ctx(seed));
        const parsed = CityDraft.safeParse(raw);
        if (!parsed.success) {
          const first = parsed.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join(".")}: ${i.message}`);
          throw new Error(`city author: output rejected — ${first.join("; ")}`);
        }
        return { draft: json(parsed.data) };
      },
    );
    const draftRef = authored.outputs.draft;
    const draft = CityDraft.parse(await readJson(deps.store, draftRef));
    const compiled = await run<"result">(
      {
        stage: "compile-city",
        version: CITY_COMPILER_VERSION * 1000 + CITY_CRITIQUE_VERSION,
        model: null,
        prompt: null,
        inputs: { draft: draftRef.hash, brief: briefRef.hash },
        params: {},
      },
      async () => {
        const { spec, issues } = compileCity({
          draft,
          briefHash: briefRef.hash,
          author: deps.author.model,
        });
        const findings: WorldCritique[] = [
          ...issues.map((message) => ({
            severity: (spec === null ? "error" : "warning") as WorldCritique["severity"],
            message,
          })),
          ...(spec ? critiqueCity(spec) : []),
        ];
        return { result: json({ spec, findings }) } as const;
      },
    );
    const { spec: raw, findings } = (await readJson(deps.store, compiled.outputs.result)) as {
      spec: unknown;
      findings: WorldCritique[];
    };
    const spec = raw === null ? null : CitySpec.parse(raw);
    if (badness(spec, findings) < badness(best.spec, best.findings)) {
      const specRef = spec ? await deps.store.put(json(spec).bytes, "application/json") : null;
      best = { ...best, spec, specRef, findings };
    }
    if (spec && findings.length === 0) break;
    if (spec && deps.untilNoErrors && !findings.some((f) => f.severity === "error")) break;
    previous = { draftRef, draft, findings };
  }
  if (best.spec) {
    const repaired = repairCity(best.spec);
    const specRef = await deps.store.put(json(repaired).bytes, "application/json");
    best = { ...best, spec: repaired, specRef, findings: critiqueCity(repaired) };
  }
  return { ...best, rounds, stages, cached };
}
