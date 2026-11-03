/**
 * Populating a city: a model writes who lives there and what their day looks like
 * (groups of people, the district each lives in, and a routine of where they go, when and
 * how). Code compiles it: keys derived from names, every district, place and travel mode
 * checked against the city, numbers bounded, routines put in time order. Findings go back to
 * the model once if it named things that don't exist.
 *
 * A memoised stage keyed by the city: a replay makes no call.
 */
import type { ArtifactStore, RecipeIndex } from "@aye/artifacts";
import {
  type CitySpec,
  CitySpec as CitySpecSchema,
  districtsOf,
  moversOf,
  POPULATION_BOUNDS,
  type Population,
  placesOf,
  populationIssues,
  type StageRecord,
  viewsOf,
} from "@aye/schema";
import { z } from "zod";
import type { Furnisher } from "./providers.ts";
import { json, readJson, runStage, type StageDeps } from "./stage.ts";
import { keyOf } from "./world.ts";

/** Bump when what populating sends, accepts or how it compiles changes. */
export const POPULATE_VERSION = 2;

export interface PopulateRequest {
  city: { name: string; tagline: string; real: boolean };
  districts: { name: string }[];
  places: { name: string; blurb: string; tags: string[]; opens: number; closes: number }[];
  travel: { name: string; speedKmh: number; fare: string }[];
  /** Earlier findings to fix, if this is a second try. */
  fix: string[];
}

const Name = z.string().max(80);
/** What the model writes: names, not keys; code resolves them. */
export const PopulationDraft = z.strictObject({
  groups: z
    .array(
      z.strictObject({
        name: Name,
        count: z.int(),
        district: Name,
        routine: z
          .array(
            z.strictObject({
              /** "HH:MM" */
              at: z.string().max(5),
              /** A place's name, "home", or "" for a district. */
              place: Name,
              /** A district's name when they go somewhere in it, else "". */
              district: Name,
              travel: Name,
            }),
          )
          .max(12),
      }),
    )
    .max(24),
});
export type PopulationDraft = z.infer<typeof PopulationDraft>;

export interface PopulateDeps {
  furnisher: Furnisher;
  store: ArtifactStore;
  index: RecipeIndex;
  signal?: AbortSignal;
  onStage?: StageDeps["onStage"];
}

const minuteOf = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
};

/** Turn the model's draft into a bounded population of this city, and say what didn't fit. */
export function compilePopulation(
  draft: PopulationDraft,
  city: Pick<CitySpec, "kinds" | "items"> & { real?: unknown },
): { population: Population; issues: string[] } {
  const real = city.real !== undefined;
  const issues: string[] = [];
  const byName = <T extends { key: string }>(xs: readonly T[], name: (x: T) => string) => {
    const m = new Map<string, string>();
    for (const x of xs) {
      m.set(keyOf(name(x)), x.key);
      m.set(x.key, x.key);
    }
    return (n: string) => m.get(keyOf(n)) ?? null;
  };
  const views = viewsOf(city);
  const district = byName(views.districts, (d) => d.name);
  const place = byName(views.places, (p) => p.name);
  const mode = byName(views.movers, (t) => t.label);
  const seen = new Set<string>();
  const groups: Population["groups"] = [];
  for (const g of draft.groups.slice(0, POPULATION_BOUNDS.groups)) {
    const key = keyOf(g.name);
    if (seen.has(key)) {
      issues.push(`group "${g.name}" is listed twice; kept the first.`);
      continue;
    }
    seen.add(key);
    const home = district(g.district);
    if (!home) {
      issues.push(`"${g.name}" live in "${g.district}", which isn't one of the districts.`);
      continue;
    }
    const routine: Population["groups"][number]["routine"] = [];
    for (const s of g.routine) {
      const at = minuteOf(s.at);
      const travel = mode(s.travel);
      const toDistrict = s.district.trim() !== "" && keyOf(s.place) !== "home";
      const zone = toDistrict ? district(s.district) : null;
      const where = keyOf(s.place) === "home" || toDistrict ? null : place(s.place);
      if (at === null)
        issues.push(`"${g.name}" have a stop at "${s.at}", which isn't a time (HH:MM).`);
      else if (!travel)
        issues.push(`"${g.name}" travel by "${s.travel}", which isn't a way to get around here.`);
      else if (toDistrict && !zone) {
        issues.push(`"${g.name}" go to district "${s.district}", which isn't one here.`);
      } else if (toDistrict && zone) {
        routine.push({ at, place: null, district: zone, mode: travel });
      } else if (where === undefined || (where === null && keyOf(s.place) !== "home")) {
        issues.push(`"${g.name}" go to "${s.place}", which isn't a place here (or "home").`);
      } else routine.push({ at, place: where, mode: travel });
    }
    routine.sort((a, b) => a.at - b.at);
    const unique = routine.filter((s, i) => i === 0 || s.at !== routine[i - 1]?.at);
    if (unique.length === 0) {
      issues.push(`"${g.name}" have no day: give them a routine.`);
      continue;
    }
    groups.push({
      key,
      name: g.name.trim().slice(0, 80) || "People",
      count: Math.max(
        1,
        Math.min(
          real ? POPULATION_BOUNDS.realPerGroup : POPULATION_BOUNDS.perGroup,
          Math.round(g.count),
        ),
      ),
      home,
      routine: unique.slice(0, POPULATION_BOUNDS.stops),
    });
  }
  const population = { groups };
  issues.push(...populationIssues(population, city));
  return { population, issues };
}

/** Write (or keep) a city's population. Only cities without one get a new one. */
export async function populateCity(
  city: CitySpec,
  deps: PopulateDeps,
): Promise<{ spec: CitySpec; issues: string[]; stages: StageRecord[]; cached: number }> {
  if (city.population.groups.length > 0) return { spec: city, issues: [], stages: [], cached: 0 };
  const signal = deps.signal ?? new AbortController().signal;
  const stages: StageRecord[] = [];
  let cached = 0;
  let fix: string[] = [];
  let best: { population: Population; issues: string[] } | null = null;
  for (let round = 0; round < 2; round++) {
    const request: PopulateRequest = {
      city: { name: city.name, tagline: city.tagline, real: city.real !== undefined },
      districts: districtsOf(city).map((d) => ({ name: d.name })),
      places: placesOf(city).map((p) => ({
        name: p.name,
        blurb: p.blurb,
        tags: p.tags,
        opens: p.hours?.from ?? -1,
        closes: p.hours?.to ?? -1,
      })),
      travel: moversOf(city).map((t) => ({
        name: t.label,
        speedKmh: t.speedKmh,
        fare: t.fare.base === 0 && t.fare.perKm === 0 ? "free" : "paid",
      })),
      fix,
    };
    const requestRef = await deps.store.put(json(request).bytes, "application/json");
    const result = await runStage<"draft">(
      {
        stage: "populate-city",
        version: POPULATE_VERSION,
        model: deps.furnisher.model,
        prompt: deps.furnisher.populatePrompt,
        inputs: { request: requestRef.hash },
        params: { effort: deps.furnisher.effort, round },
      },
      {
        store: deps.store,
        index: deps.index,
        signal,
        ...(deps.onStage ? { onStage: deps.onStage } : {}),
      },
      async (seed) => {
        const raw = await deps.furnisher.populate(request, PopulationDraft, {
          store: deps.store,
          seed,
          signal,
        });
        const parsed = PopulationDraft.safeParse(raw);
        if (!parsed.success) throw new Error("populator: output rejected");
        return { draft: json(parsed.data) };
      },
    );
    stages.push(result.record);
    if (result.cached) cached++;
    const draft = PopulationDraft.parse(await readJson(deps.store, result.outputs.draft));
    const compiled = compilePopulation(draft, city);
    if (!best || compiled.population.groups.length >= best.population.groups.length)
      best = compiled;
    if (compiled.issues.length === 0) break;
    fix = compiled.issues.slice(0, 20);
  }
  const population = best?.population ?? { groups: [] };
  return {
    spec: CitySpecSchema.parse({ ...city, population }),
    issues: best?.issues ?? [],
    stages,
    cached,
  };
}
