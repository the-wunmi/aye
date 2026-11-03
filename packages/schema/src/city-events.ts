/**
 * What a city is going through: events its director writes (a fuel queue, a festival, a
 * flooded road, the ferry suspended for repairs), each a window of city time with effects
 * on the city's own items and kinds.
 *
 * Effects are code's small vocabulary for change over time, read by trait: a place can be
 * closed, a mover halted, slowed or its fares changed. Every effect names its target by key
 * and is bounded; an event's words are display text only. Everything that asks "is this open,
 * is that running, what does it cost, how fast is it" asks through the functions here, so an
 * event is felt everywhere at once: on the map, in trips, in apps.
 */
import { z } from "zod";
import { type CityMover, type CityPlace, isOpen } from "./city-kinds.ts";
import { Label } from "./primitives.ts";
import { SpecKey } from "./world-spec.ts";

export const EVENT_BOUNDS = {
  /** Events a city holds at once (past ones are dropped when new ones are written). */
  events: 12,
  effects: 6,
  /** Longest an event lasts: three city days. */
  maxMinutes: 3 * 1440,
  /** Speed and fare changes, permille of normal. */
  permille: { min: 100, max: 5000 },
} as const;

/** One change an event makes, to an item (a place) or a kind (a mover). */
export const EventEffect = z.discriminatedUnion("type", [
  /** A place is shut. */
  z.object({ type: z.literal("closed"), place: SpecKey }),
  /** A way to get around isn't running. */
  z.object({ type: z.literal("halted"), mover: SpecKey }),
  /** A way to get around goes at this share of its speed. */
  z.object({
    type: z.literal("slowed"),
    mover: SpecKey,
    permille: z.int().min(EVENT_BOUNDS.permille.min).max(1000),
  }),
  /** A way to get around costs this share of its fare. */
  z.object({
    type: z.literal("fare"),
    mover: SpecKey,
    permille: z.int().min(EVENT_BOUNDS.permille.min).max(EVENT_BOUNDS.permille.max),
  }),
]);
export type EventEffect = z.infer<typeof EventEffect>;

export const CityEvent = z.object({
  key: SpecKey,
  name: Label.min(1),
  /** What's going on, in a line. Display only. */
  about: z.string().max(200),
  icon: z.string().min(1).max(32),
  /** City minutes since the world began (absolute), when it starts and ends. */
  from: z.int().min(0),
  to: z.int().min(0),
  effects: z.array(EventEffect).max(EVENT_BOUNDS.effects),
});
export type CityEvent = z.infer<typeof CityEvent>;

/** Events going on at this city minute (absolute). */
export function eventsAt(events: readonly CityEvent[], minute: number): CityEvent[] {
  return events.filter((e) => e.from <= minute && minute < e.to);
}

/** Is a place open at this city minute: its hours, unless an event has shut it. */
export function placeOpen(
  place: Pick<CityPlace, "key" | "hours">,
  events: readonly CityEvent[],
  minute: number,
): boolean {
  if (!isOpen(place.hours, minute % 1440)) return false;
  return !eventsAt(events, minute).some((e) =>
    e.effects.some((f) => f.type === "closed" && f.place === place.key),
  );
}

/**
 * The first city minute at or after `from` when a place is open (its hours, and no event
 * closing it), looking up to `withinMin` ahead in quarter hours; null if it stays shut.
 */
export function nextOpen(
  place: Pick<CityPlace, "key" | "hours">,
  events: readonly CityEvent[],
  from: number,
  withinMin: number,
): number | null {
  for (let m = from; m <= from + withinMin; m += m === from ? 15 - (from % 15) : 15) {
    if (placeOpen(place, events, m)) return m;
  }
  return null;
}

/**
 * The first stretch, starting at or after `from`, when a place is open for at least `atLeastMin`
 * (city minutes): when it opens (or `from`, if already open) and when it next closes. Looks up
 * to `withinMin` ahead in quarter hours; null if there is no such stretch.
 */
export function openWindow(
  place: Pick<CityPlace, "key" | "hours">,
  events: readonly CityEvent[],
  from: number,
  atLeastMin: number,
  withinMin: number,
): { opens: number; closes: number } | null {
  let at = from;
  while (at <= from + withinMin) {
    const opens = nextOpen(place, events, at, from + withinMin - at);
    if (opens === null) return null;
    let closes = opens;
    while (closes < opens + 1440 && placeOpen(place, events, closes)) {
      closes += closes === opens ? 15 - (opens % 15) : 15;
    }
    if (closes - opens >= atLeastMin) return { opens, closes };
    at = closes;
  }
  return null;
}

/**
 * How a way to get around is doing at this city minute: whether it runs (its hours, unless an
 * event has halted it), its speed and its fare, with every event's changes applied.
 */
export function moverNow(
  mover: Pick<CityMover, "key" | "hours" | "speedKmh" | "fare">,
  events: readonly CityEvent[],
  minute: number,
): { running: boolean; speedKmh: number; fare: { base: number; perKm: number } } {
  let running = isOpen(mover.hours, minute % 1440);
  let speed = 1000;
  let fare = 1000;
  for (const e of eventsAt(events, minute)) {
    for (const f of e.effects) {
      if (!("mover" in f) || f.mover !== mover.key) continue;
      if (f.type === "halted") running = false;
      if (f.type === "slowed") speed = Math.floor((speed * f.permille) / 1000);
      if (f.type === "fare") fare = Math.floor((fare * f.permille) / 1000);
    }
  }
  return {
    running,
    speedKmh: Math.max(1, Math.floor((mover.speedKmh * speed) / 1000)),
    fare: {
      base: Math.floor((mover.fare.base * fare) / 1000),
      perKm: Math.floor((mover.fare.perKm * fare) / 1000),
    },
  };
}

/** Problems with a city's events: targets that don't exist or can't take the effect. */
export function eventIssues(
  events: readonly CityEvent[],
  city: { places: readonly { key: string }[]; movers: readonly { key: string }[] },
): string[] {
  const issues: string[] = [];
  const places = new Set(city.places.map((p) => p.key));
  const movers = new Set(city.movers.map((m) => m.key));
  const keys = new Set<string>();
  for (const e of events) {
    if (keys.has(e.key)) issues.push(`event "${e.key}" is defined twice`);
    keys.add(e.key);
    if (e.to <= e.from) issues.push(`event "${e.key}" ends before it starts`);
    if (e.to - e.from > EVENT_BOUNDS.maxMinutes) issues.push(`event "${e.key}" lasts too long`);
    for (const f of e.effects) {
      if (f.type === "closed" && !places.has(f.place)) {
        issues.push(`event "${e.key}" closes "${f.place}", which isn't a place`);
      }
      if (f.type !== "closed" && !movers.has(f.mover)) {
        issues.push(`event "${e.key}" changes "${f.mover}", which isn't a way to get around`);
      }
    }
  }
  return issues;
}

/** City minutes since the world began (absolute), from when it was made and its clock. */
export function cityMinuteNow(
  createdAt: string,
  settings: { startMinuteOfDay: number; ticksPerRealSecond: number },
  nowMs: number,
): number {
  const elapsedS = (nowMs - Date.parse(createdAt)) / 1000;
  return settings.startMinuteOfDay + Math.floor((elapsedS * settings.ticksPerRealSecond) / 60);
}
