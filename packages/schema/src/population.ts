/**
 * A city's population: who lives there and what their day looks like, written by a
 * model. Groups of people, each living in a district, with a routine of stops (a time, where,
 * and how they travel). Code turns it into city life: people on the roads, vehicles queueing
 * where roads fill up, places busy at their hours.
 *
 * Like everything a model writes, it is data: every place, district and travel mode it names
 * is checked against the city, every number is bounded, and nothing in it runs as code.
 */
import { z } from "zod";
import { type Item, type Kind, viewsOf } from "./city-kinds.ts";
import { Label } from "./primitives.ts";
import { SpecKey } from "./world-spec.ts";

export const POPULATION_BOUNDS = {
  groups: 16,
  stops: 8,
  perGroup: 50_000,
  people: 200_000,
  /** A real city is written at its real size. */
  realPerGroup: 5_000_000,
  realPeople: 40_000_000,
} as const;

/** Where a group goes next and when: a place by key, or home (null). */
export const RoutineStop = z.object({
  /** Minute of the day they set off. */
  at: z.int().min(0).max(1439),
  /** A place in the city by key, or null for home (or for a district, below). */
  place: SpecKey.nullable(),
  /**
   * Somewhere in a district rather than one of the city's places (work, school, a market
   * street): each person goes to their own spot in it. Only with `place` null.
   */
  district: SpecKey.optional(),
  /** A travel mode of the city, by key. */
  mode: SpecKey,
});
export type RoutineStop = z.infer<typeof RoutineStop>;

export const PopulationGroup = z.object({
  key: SpecKey,
  /** Who they are ("market traders"). Display only. */
  name: Label.min(1),
  count: z.int().min(1).max(POPULATION_BOUNDS.realPerGroup),
  /** The district they live in, by key. */
  home: SpecKey,
  /** Their day, in order of time. */
  routine: z.array(RoutineStop).min(1).max(POPULATION_BOUNDS.stops),
});
export type PopulationGroup = z.infer<typeof PopulationGroup>;

export const Population = z.object({
  groups: z.array(PopulationGroup).max(POPULATION_BOUNDS.groups),
});
export type Population = z.infer<typeof Population>;

/** Every broken reference or impossible routine, in words a model can act on. */
export function populationIssues(
  population: Population,
  city: { kinds: readonly Kind[]; items: readonly Item[]; real?: unknown },
): string[] {
  const issues: string[] = [];
  const views = viewsOf(city);
  const districts = new Set(views.districts.map((d) => d.key));
  const places = new Set(views.places.map((p) => p.key));
  const modes = new Set(views.movers.map((m) => m.key));
  const seen = new Set<string>();
  let total = 0;
  for (const g of population.groups) {
    const at = `group "${g.key}"`;
    if (seen.has(g.key)) issues.push(`${at} is defined twice`);
    seen.add(g.key);
    total += g.count;
    if (!districts.has(g.home)) issues.push(`${at} lives in unknown district "${g.home}"`);
    let last = -1;
    for (const [i, s] of g.routine.entries()) {
      if (s.place !== null && !places.has(s.place)) {
        issues.push(`${at} stop ${i} goes to unknown place "${s.place}"`);
      }
      if (s.district !== undefined) {
        if (s.place !== null) issues.push(`${at} stop ${i} names both a place and a district`);
        if (!districts.has(s.district)) {
          issues.push(`${at} stop ${i} goes to unknown district "${s.district}"`);
        }
      }
      if (!modes.has(s.mode)) issues.push(`${at} stop ${i} uses unknown travel mode "${s.mode}"`);
      if (s.at <= last) issues.push(`${at} stop ${i} isn't later than the one before`);
      last = s.at;
    }
  }
  const real = city.real !== undefined;
  const most = real ? POPULATION_BOUNDS.realPeople : POPULATION_BOUNDS.people;
  const perGroup = real ? POPULATION_BOUNDS.realPerGroup : POPULATION_BOUNDS.perGroup;
  if (total > most) issues.push(`${total} people is more than ${most}`);
  for (const g of population.groups) {
    if (g.count > perGroup) issues.push(`group "${g.key}" has more than ${perGroup} people`);
  }
  return issues;
}
