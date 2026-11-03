/**
 * The data an AI-written interface can show. A city's apps and widgets name a source ("actions
 * that pay, best paid first", "places tagged food, open now"); this evaluates it over the city,
 * what its built places offer, and who is around. Pure functions: the model chooses what to
 * show, code decides what that means, and every string shown is the model's or a player's,
 * rendered as text.
 */
import {
  distanceM,
  moverNow,
  moversOf,
  placeOpen,
  placesOf,
  type RosterEntry,
  type Source,
} from "@aye/schema";
import { clockText, closedText, durationText, money } from "../format.ts";
import type { CityBundle } from "./types.ts";

export interface Item {
  id: string;
  icon: string;
  title: string;
  detail: string;
  badge: string;
  tone: "good" | "bad" | "muted" | "plain";
  /** Tapping it shows this place, if any. */
  place: string | null;
  /** What it stands for there, if it's something to do: tapping takes you to do it. */
  act?: { kind: string; action: string };
  /** You can't do this yet, and why: shown instead of sending you across town to find out. */
  lacking?: string;
}

/** Somewhere to go, and (optionally) something to do once there. */
export interface GoTarget {
  place: string;
  kind?: string;
  action?: string;
  /** What it's called, for telling the player what's next. */
  label: string;
}

export interface SourceContext {
  bundle: CityBundle;
  /** Where the player is (or last was), by city key. */
  here: string | null;
  /** Their home, the only private place they can go. */
  home: string | null;
  /** City minutes since the world began: hours and the city's events both apply. */
  minute: number;
  roster: readonly RosterEntry[];
  online: number;
  /** What you have of each mark, by key, once known. */
  marks?: Readonly<Record<string, number>>;
  /** What work pays you just now, permille: running on empty costs you, and the list should say. */
  payPermille?: number;
}

/** Private places other than your own home don't exist for you. */
export function visiblePlaces(ctx: Pick<SourceContext, "bundle" | "home">) {
  return placesOf(ctx.bundle.city).filter((p) => !p.private || p.key === ctx.home);
}

/**
 * The thing to do about a need: what restores most of it among what's open to you and you can
 * pay for, free things included, the cheaper of two that help as much. Something right here wins
 * unless it barely helps (a sip of water against a meal).
 */
export function bestForNeed(
  need: string,
  ctx: SourceContext,
  wallet: number | null,
): Item | undefined {
  const { catalog, city } = ctx.bundle;
  const places = new Map(placesOf(city).map((p) => [p.key, p]));
  const scored = listItems(
    { from: "actions", filter: "any", need, sort: "cheapest" } as Source,
    ctx,
    200,
  )
    .filter((i) => {
      const at = places.get(i.place as string);
      return !i.lacking && i.act && at && placeOpen(at, city.events, ctx.minute);
    })
    .flatMap((item) => {
      const a = catalog[item.place as string]?.actions.find(
        (x) => x.kind === item.act?.kind && x.action === item.act?.action,
      );
      if (!a || (wallet !== null && a.cost > wallet)) return [];
      const rate = a.needs.find((n) => n.need === need)?.perHour ?? 0;
      return rate > 0 ? [{ item, gain: (rate * a.durationMin) / 60, cost: a.cost }] : [];
    })
    .sort((x, y) => y.gain - x.gain || x.cost - y.cost);
  const best = scored[0];
  if (!best) return undefined;
  const nearby = scored.find((s) => s.item.place === ctx.here);
  return nearby && nearby.gain * 4 >= best.gain ? nearby.item : best.item;
}

export function listItems(source: Source, ctx: SourceContext, limit: number): Item[] {
  const { city, catalog } = ctx.bundle;
  const cur = city.currency;
  const w = city.words;
  const placeOf = new Map(placesOf(city).map((p) => [p.key, p]));
  const here = ctx.here ? placeOf.get(ctx.here) : undefined;
  switch (source.from) {
    case "actions": {
      const rows = visiblePlaces(ctx).flatMap((p) =>
        (catalog[p.key]?.actions ?? []).map((a) => ({ p, a })),
      );
      const kept = rows.filter(({ a }) => {
        if (source.filter === "pays" && a.income <= 0) return false;
        if (source.filter === "costs" && a.cost <= 0) return false;
        if (source.need && !a.needs.some((n) => n.need === source.need)) return false;
        return true;
      });
      const perHour = (a: (typeof rows)[number]["a"]) => (a.income * 60) / a.durationMin;
      const lackingFor = ({ a, p }: (typeof rows)[number]): string | undefined => {
        const held = ctx.marks;
        if (!held) return undefined;
        // The door comes first: work inside a place you can't get into isn't work you can do.
        for (const ask of p.asks ?? []) {
          if ((held[ask.mark] ?? 0) < ask.atLeast) {
            const label = city.marks.find((m) => m.key === ask.mark)?.label;
            return `${p.name} needs ${label ?? ask.mark} ${ask.atLeast}`;
          }
        }
        for (const ask of a.asks ?? []) {
          const have = held[ask.mark] ?? 0;
          if (ask.op === "lte" && have > ask.value) return "You've done this already";
          if (ask.op === "gte" && have < ask.value) {
            const label = city.marks.find((m) => m.key === ask.mark)?.label;
            return label ? `Needs ${label} ${ask.value}` : "Needs someone there to know you better";
          }
        }
        return undefined;
      };
      const open = new Map(
        visiblePlaces(ctx).map((p) => [p.key, placeOpen(p, city.events, ctx.minute)]),
      );
      kept.sort(
        (x, y) =>
          // What you can go and do now first; closed places after, saying so; earned work last.
          Number(lackingFor(x) !== undefined) - Number(lackingFor(y) !== undefined) ||
          Number(open.get(y.p.key)) - Number(open.get(x.p.key)) ||
          (source.sort === "best_paid"
            ? perHour(y.a) - perHour(x.a)
            : source.sort === "cheapest"
              ? x.a.cost - y.a.cost
              : x.a.label.localeCompare(y.a.label)),
      );
      // Something to work towards stays on the list, even when there's plenty to do already.
      const shown = kept.slice(0, limit);
      const locked = kept.find((row) => lackingFor(row) !== undefined);
      if (limit >= 2 && locked && !shown.includes(locked)) shown[limit - 1] = locked;
      return shown.map((row) => {
        const { p, a } = row;
        const isOpen = open.get(p.key) === true;
        const lacking = lackingFor(row);
        return {
          ...(lacking ? { lacking } : {}),
          id: `${p.key}/${a.kind}/${a.action}`,
          icon: p.icon,
          title: a.label,
          detail: `${a.thing} · ${p.name} · ${durationText(a.durationMin)}${(a.marks ?? [])
            .flatMap((key) => {
              const m = city.marks.find((x) => x.key === key);
              return m?.shown ? [` · builds ${m.label}`] : [];
            })
            .join("")}${isOpen ? "" : ` · ${closedText(w.closedNow, p.hours)}`}`,
          badge:
            a.income > 0
              ? `+${money(Math.floor((a.income * (ctx.payPermille ?? 1000)) / 1000), cur)}`
              : a.cost > 0
                ? money(a.cost, cur)
                : w.free,
          tone:
            !isOpen || lacking ? "muted" : a.income > 0 ? "good" : a.cost > 0 ? "plain" : "muted",
          place: p.key,
          act: { kind: a.kind, action: a.action },
        };
      });
    }
    case "places": {
      const kept = visiblePlaces(ctx).filter(
        (p) =>
          (!source.tag || p.tags.includes(source.tag)) &&
          (!source.openNow || placeOpen(p, city.events, ctx.minute)),
      );
      kept.sort((a, b) =>
        source.sort === "nearest" && here
          ? distanceM(here, a) - distanceM(here, b)
          : a.name.localeCompare(b.name),
      );
      return kept.slice(0, limit).map((p) => {
        const open = placeOpen(p, city.events, ctx.minute);
        return {
          id: p.key,
          icon: p.icon,
          title: p.name,
          detail: p.blurb,
          badge: !catalog[p.key] ? w.notBuilt : open ? w.openNow : closedText(w.closedNow, p.hours),
          tone: !catalog[p.key] ? "muted" : open ? "good" : "bad",
          place: p.key,
        };
      });
    }
    case "travel":
      return moversOf(city)
        .slice(0, limit)
        .map((m) => {
          const now = moverNow(m, city.events, ctx.minute);
          const runs = now.running;
          const free = now.fare.base === 0 && now.fare.perKm === 0;
          return {
            id: m.key,
            icon: m.icon,
            title: m.label,
            detail: free
              ? `${now.speedKmh} km/h · ${w.free}`
              : `${now.speedKmh} km/h · ${money(now.fare.base, cur)} + ${money(now.fare.perKm, cur)}/km`,
            badge: runs ? w.running : w.notRunning,
            tone: runs ? "good" : "muted",
            place: null,
          };
        });
    case "people":
    case "players":
      return ctx.roster
        .filter((r) => source.from === "people" || r.player !== null)
        .slice(0, limit)
        .map((r) => ({
          id: r.key,
          icon: r.player ? "\u{1F9D1}" : "\u{1F464}",
          title: r.person.name,
          detail: r.person.about,
          badge: r.player ? `@${r.player}` : r.heldBy ? `played by @${r.heldBy}` : "",
          tone: r.player ? "good" : "plain",
          place: null,
        }));
    case "events":
      // What's on now, then what's coming, soonest first.
      return city.events
        .filter((e) => e.to > ctx.minute)
        .sort((a, b) => a.from - b.from)
        .slice(0, limit)
        .map((e) => {
          const on = e.from <= ctx.minute;
          return {
            id: e.key,
            icon: e.icon,
            title: e.name,
            detail: e.about,
            badge: on
              ? `\u{2192} ${clockText(e.to % 1440)}`
              : `${clockText(e.from % 1440)} \u{2192}`,
            tone: on ? "good" : "muted",
            place: e.effects.find((f) => f.type === "closed")?.place ?? null,
          };
        });
    case "headlines":
      return city.headlines.slice(0, limit).map((h, i) => ({
        id: `h${i}`,
        icon: h.icon,
        title: h.text,
        detail: "",
        badge: "",
        tone: "plain",
        place: null,
      }));
  }
}
