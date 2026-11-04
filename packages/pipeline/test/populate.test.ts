/**
 * Tests for populating a city with a scripted model: compiling the draft against the city, and
 * that a populated city is left alone.
 */
import { MemoryArtifactStore, MemoryRecipeIndex } from "@aye/artifacts";
import { districtsOf, moversOf, placesOf } from "@aye/schema";
import { sampleCity } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import {
  compilePopulation,
  type Furnisher,
  type PopulationDraft,
  populateCity,
} from "../src/index.ts";

const place = placesOf(sampleCity)[1]!;
const district = districtsOf(sampleCity)[0]!;
const walk = moversOf(sampleCity)[0]!;

const good: PopulationDraft = {
  groups: [
    {
      name: "Traders",
      count: 1200,
      district: district.name,
      routine: [
        { at: "17:30", place: "home", district: "", travel: walk.label },
        { at: "06:15", place: place.name, district: "", travel: walk.label },
      ],
    },
  ],
};

describe("compilePopulation", () => {
  it("sends people to districts too, and lets a real city be its real size", () => {
    const real = {
      ...sampleCity,
      real: {
        origin: { lat: 6.5, lon: 3.3 },
        extentM: [20_000, 20_000] as [number, number],
        network: sampleCity.brief,
      },
    };
    const draft: PopulationDraft = {
      groups: [
        {
          name: "Office workers",
          count: 2_500_000,
          district: district.name,
          routine: [
            { at: "07:00", place: "", district: district.name, travel: walk.label },
            { at: "18:00", place: "home", district: "", travel: walk.label },
          ],
        },
      ],
    };
    const { population, issues } = compilePopulation(draft, real);
    expect(issues).toEqual([]);
    expect(population.groups[0]?.count).toBe(2_500_000);
    expect(population.groups[0]?.routine[0]).toMatchObject({ place: null, district: district.key });
    // A sketched city stays small.
    expect(compilePopulation(draft, sampleCity).population.groups[0]?.count).toBe(50_000);
  });

  it("resolves names to the city's keys and puts each day in order", () => {
    const { population, issues } = compilePopulation(good, sampleCity);
    expect(issues).toEqual([]);
    const g = population.groups[0];
    expect(g?.home).toBe(district.key);
    expect(g?.routine.map((s) => [s.at, s.place, s.mode])).toEqual([
      [375, place.key, walk.key],
      [1050, null, walk.key],
    ]);
  });

  it("refuses what isn't in the city, in words the model can act on", () => {
    const { population, issues } = compilePopulation(
      {
        groups: [
          { name: "Ghosts", count: 10, district: "Atlantis", routine: [] },
          {
            name: "Lost",
            count: 99_999_999,
            district: district.name,
            routine: [
              { at: "25:99", place: place.name, district: "", travel: walk.label },
              { at: "08:00", place: "The Moon", district: "", travel: walk.label },
              { at: "09:00", place: place.name, district: "", travel: "teleporter" },
              { at: "10:00", place: place.name, district: "", travel: walk.label },
            ],
          },
        ],
      },
      sampleCity,
    );
    expect(issues.some((i) => i.includes("Atlantis"))).toBe(true);
    expect(issues.some((i) => i.includes("25:99"))).toBe(true);
    expect(issues.some((i) => i.includes("The Moon"))).toBe(true);
    expect(issues.some((i) => i.includes("teleporter"))).toBe(true);
    expect(population.groups.map((g) => g.key)).toEqual(["lost"]);
    expect(population.groups[0]?.count).toBe(50_000);
    expect(population.groups[0]?.routine).toHaveLength(1);
  });
});

describe("populateCity", () => {
  const fake = (drafts: unknown[]) => {
    const calls = { n: 0, fix: [] as string[][] };
    const furnisher: Furnisher = {
      model: { provider: "test", model: "people", version: "1" },
      prompt: "",
      cityPrompt: "",
      decoratePrompt: "",
      populatePrompt: "populate",
      effort: "low",
      furnishWorld: async () => ({}),
      furnishCity: async () => ({}),
      decorate: async () => ({ items: [] }),
      async populate(request) {
        calls.fix.push(request.fix);
        return drafts[Math.min(calls.n++, drafts.length - 1)];
      },
    };
    return { furnisher, calls };
  };

  it("asks again with the findings, then keeps a working population, memoised", async () => {
    const bad = { groups: [{ ...good.groups[0], district: "Nowhere" }] };
    const { furnisher, calls } = fake([bad, good]);
    const deps = { furnisher, store: new MemoryArtifactStore(), index: new MemoryRecipeIndex() };
    const first = await populateCity(sampleCity, deps);
    expect(calls.n).toBe(2);
    expect(calls.fix[1]?.some((f) => f.includes("Nowhere"))).toBe(true);
    expect(first.spec.population.groups).toHaveLength(1);
    expect(first.issues).toEqual([]);
    const again = await populateCity(sampleCity, deps);
    expect(calls.n).toBe(2);
    expect(again.spec).toEqual(first.spec);
    // A populated city is left alone.
    await populateCity(first.spec, deps);
    expect(calls.n).toBe(2);
  });
});
