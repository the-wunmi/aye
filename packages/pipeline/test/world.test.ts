import { hashJson, MemoryArtifactStore, MemoryRecipeIndex } from "@aye/artifacts";
import { WORLD_BOUNDS, WorldSpec } from "@aye/schema";
import { sampleFlat, sampleSettings, sampleSpec } from "@aye/schema/fixtures";
import { evaluateWorld, Sim, TICKS_PER_HOUR } from "@aye/sim";
import { describe, expect, it } from "vitest";
import { draftFromBrief, fakeCalls, fakeWorldAuthor } from "../src/fake.ts";
import {
  authorWorld,
  briefFor,
  compileKind,
  compileWorld,
  draftOfKind,
  dressWorld,
  improvise,
  keyOf,
  type WorldDraft,
} from "../src/index.ts";

const sceneHash = hashJson(sampleFlat);
const brief = briefFor({
  scene: sampleFlat,
  name: "Sample flat",
  summary: "A two-room flat",
  description: "",
  currency: "NGN",
});
const author = { provider: "test", model: "world", version: "1" };
const critique = (spec: WorldSpec) =>
  evaluateWorld(sampleFlat, spec, sampleSettings, { hours: 6 }).findings;
const deps = (calls = fakeCalls()) => ({
  author: fakeWorldAuthor(calls),
  store: new MemoryArtifactStore(),
  index: new MemoryRecipeIndex(),
  critique,
});

describe("keyOf", () => {
  it("turns any name into a safe key, deterministically", () => {
    expect(keyOf("Door open!")).toBe("door_open");
    expect(keyOf("  ")).toBe("x");
    expect(keyOf("2nd floor")).toBe("k_2nd_floor");
    expect(keyOf("'; DROP TABLE x; --")).toBe("drop_table_x");
    expect(keyOf("Ìyá Àlàkẹ̀ stall")).toBe("iya_alake_stall");
  });
});

describe("compileWorld", () => {
  const base = draftFromBrief(brief);

  it("maps indices back to ids and derives every key in code", () => {
    const { spec, issues } = compileWorld({
      draft: base,
      scene: sampleFlat,
      sceneHash,
      currency: "NGN",
      author,
    });
    expect(issues).toEqual([]);
    expect(spec?.things.map((t) => t.object)).toEqual(sampleFlat.objects.map((o) => o.id));
    expect(spec?.kinds.every((k) => /^[a-z][a-z0-9_]*$/.test(k.key))).toBe(true);
  });

  it("resolves marks and people's names, and sends back what it can't", () => {
    const draft = structuredClone(base);
    const first = draft.kinds[0];
    if (!first) throw new Error("a draft has kinds");
    const person = draft.people[0]?.name ?? "";
    const action = first.actions[0];
    if (!action) throw new Error("a kind has actions");
    draft.kinds[0] = {
      ...first,
      actions: [
        {
          ...action,
          marks: [
            { mark: "Cooking", by: 90 },
            { mark: "Nonsense", by: 1 },
          ],
          asks: [{ mark: person, op: "gte", value: 3 }],
        },
      ],
    };
    const { spec, issues } = compileWorld({
      draft,
      scene: sampleFlat,
      sceneHash,
      currency: "NGN",
      author,
      cityMarks: [{ key: "cooking", label: "Cooking", max: 5, shown: true }],
    });
    const a = spec?.kinds[0]?.actions[0];
    // A skill comes from doing it a few times: one go moves it three at most.
    expect(a?.marks).toEqual([{ mark: "cooking", by: 3 }]);
    expect(a?.asks?.[0]?.mark).toMatch(/^close_/);
    expect(spec?.marks?.some((m) => m.key === "cooking")).toBe(true);
    expect(issues.join(" ")).toContain("nonsense");
  });

  it("in a real place someone filmed, keeps nobody they didn't name", () => {
    const args = { draft: base, scene: sampleFlat, sceneHash, currency: "NGN", author };
    expect(base.people.length).toBeGreaterThan(0);
    // They named nobody: whoever the model wrote is made up, and goes.
    const nobody = compileWorld({ ...args, filmed: { namedNobody: true } });
    expect(nobody.spec?.people).toEqual([]);
    expect(nobody.issues.some((i) => i.includes("nobody was named"))).toBe(true);
    expect(WorldSpec.safeParse(nobody.spec).success).toBe(true);
    // Owners go with them: a thing can't belong to someone who isn't there.
    expect(nobody.spec?.things.every((t) => !t.owner)).toBe(true);
    // They said something: it's the model's reading of what they said.
    const said = compileWorld({ ...args, filmed: { namedNobody: false } });
    expect(said.spec?.people.length).toBe(base.people.length);
    // Filmed, an empty place is fine; imagined, it's a problem to fix.
    const none = { ...base, people: [] };
    expect(
      compileWorld({ ...args, draft: none, filmed: { namedNobody: false } }).issues,
    ).not.toContain("the world has no people.");
    expect(compileWorld({ ...args, draft: none }).issues).toContain("the world has no people.");
  });

  it("gives things owners only among the people here, and vehicles a bounded speed", () => {
    const draft: WorldDraft = structuredClone(base);
    draft.things[0]!.owner = "Ade";
    draft.things[1]!.owner = "Nobody Here";
    const kind = draft.kinds.find((k) => keyOf(k.key) === draft.things[0]!.kind) ?? draft.kinds[0]!;
    kind.travelKmh = 9_999;
    // A thing that travels needs a way to go out with it.
    kind.actions[0]!.leaves = "with_thing";
    const { spec, issues } = compileWorld({
      draft,
      scene: sampleFlat,
      sceneHash,
      currency: "NGN",
      author,
    });
    expect(spec?.things[0]?.owner).toBe("ade");
    expect(spec?.things[1]?.owner).toBeUndefined();
    expect(issues.some((i) => /isn't one of the people here/.test(i))).toBe(true);
    const travels = spec?.kinds.find((k) => k.key === keyOf(kind.key));
    expect(travels?.travel?.speedKmh).toBe(WORLD_BOUNDS.travelKmh.max);
    // And back to a draft for revising, unchanged.
    expect(draftOfKind(travels!).travelKmh).toBe(WORLD_BOUNDS.travelKmh.max);
  });

  it("clamps every number to WORLD_BOUNDS, so no world is a money printer", () => {
    const draft: WorldDraft = structuredClone(base);
    const action = draft.kinds[0]!.actions[0]!;
    Object.assign(action, { durationMin: 0, income: 10 ** 9, cost: -5, capacity: 999 });
    action.needs = [{ need: "fun", perHour: 10 ** 9 }];
    draft.needs[0]!.decayPerHour = 10 ** 6;
    draft.people[0]!.money = 10 ** 9;
    draft.people[0]!.widthMm = 1;
    const { spec } = compileWorld({ draft, scene: sampleFlat, sceneHash, currency: "NGN", author });
    const a = spec!.kinds[0]!.actions[0]!;
    expect(a.durationMin).toBe(1);
    expect(a.income).toBe(Math.floor(WORLD_BOUNDS.incomePerHour / 60));
    expect(a.cost).toBe(0);
    expect(a.capacity).toBe(WORLD_BOUNDS.capacity);
    expect(a.needs[0]?.perHour).toBe(WORLD_BOUNDS.needPerHour);
    expect(spec!.needs[0]!.decayPerHour).toBe(WORLD_BOUNDS.needDecayPerHour);
    expect(spec!.people[0]!.body.widthMm).toBe(WORLD_BOUNDS.body.widthMm.min);
  });

  it("reports what doesn't add up, in words, instead of guessing", () => {
    const draft: WorldDraft = structuredClone(base);
    draft.things = draft.things.slice(1);
    draft.things.push({ object: 999, kind: "ghost", state: [], owner: "" });
    draft.kinds[0]!.look[0]!.colour = "red";
    draft.kinds[0]!.actions[0]!.requires = [{ var: "lit", op: "eq", value: 1 }];
    const { spec, issues } = compileWorld({
      draft,
      scene: sampleFlat,
      sceneHash,
      currency: "NGN",
      author,
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/object 999 doesn't exist/),
        expect.stringMatching(/object 0 \(.+\) has no kind/),
        expect.stringMatching(/colour "red" isn't #rrggbb/),
        expect.stringMatching(/tests unknown var "lit"/),
      ]),
    );
    expect(spec).toBeNull();
  });
});

describe("what someone looks like doing what takes them away", () => {
  const kind = sampleSpec.kinds[0] as (typeof sampleSpec.kinds)[number];
  const ride = (leaves: "alone" | "with_thing") => {
    const draft = draftOfKind(kind);
    const action = draft.actions[0] as (typeof draft.actions)[number];
    return compileKind(
      { ...draft, actions: [{ ...action, leaves, pose: "sit", on: false }] },
      [],
      kind.key,
    ).actions[0];
  };

  it("doesn't let a sitting pose on someone going off alone sink the place", () => {
    expect(ride("alone")?.pose).toBe("stand");
  });

  it("keeps how they ride in what they take with them", () => {
    expect(ride("with_thing")?.pose).toBe("sit");
  });
});

describe("authorWorld", () => {
  it("writes a valid, playable world and replays it from cache with no model calls", async () => {
    const calls = fakeCalls();
    const d = deps(calls);
    const first = await authorWorld({ scene: sampleFlat, sceneHash, brief }, d);
    expect(first.spec).not.toBeNull();
    expect(WorldSpec.safeParse(first.spec).success).toBe(true);
    const sim = new Sim({ scene: sampleFlat, spec: first.spec!, settings: sampleSettings });
    for (let t = 0; t < TICKS_PER_HOUR; t++) sim.step();
    const before = { ...calls };
    const again = await authorWorld({ scene: sampleFlat, sceneHash, brief }, d);
    expect(calls).toEqual(before);
    expect(again.specRef?.hash).toBe(first.specRef?.hash);
  });

  it("sends findings back for revision, and keeps the best round", async () => {
    const calls = fakeCalls();
    const strict = {
      ...deps(calls),
      // An exacting critic: always one warning, so every round is revised until the limit.
      critique: () => [{ severity: "warning" as const, message: "could be livelier" }],
      maxRounds: 3,
    };
    const result = await authorWorld({ scene: sampleFlat, sceneHash, brief }, strict);
    expect(result.rounds).toBe(3);
    expect(calls).toMatchObject({ author: 1, revise: 2 });
    expect(result.findings).toEqual([{ severity: "warning", message: "could be livelier" }]);
    expect(result.spec).not.toBeNull();
  });

  it("keeps going on what a player would hit, but a warning alone doesn't hold a place up", async () => {
    const fixing = fakeCalls();
    const fix = await authorWorld(
      { scene: sampleFlat, sceneHash, brief: { ...brief, description: "fix" } },
      {
        ...deps(fixing),
        untilNoErrors: true,
        maxRounds: 3,
        critique: () => [{ severity: "fix" as const, message: "a shelf nobody can get to" }],
      },
    );
    expect(fix.rounds).toBe(3);
    // It stayed, and the place still has its spec: that isn't a reason to refuse it.
    expect(fix.spec).not.toBeNull();
    expect(fix.findings.some((f) => f.severity === "error")).toBe(false);

    const warned = fakeCalls();
    const warning = await authorWorld(
      { scene: sampleFlat, sceneHash, brief: { ...brief, description: "warn" } },
      {
        ...deps(warned),
        untilNoErrors: true,
        maxRounds: 3,
        critique: () => [{ severity: "warning" as const, message: "could be livelier" }],
      },
    );
    expect(warning.rounds).toBe(1);
  });

  it("rejects output outside the contract", async () => {
    const bad = {
      ...deps(),
      author: { ...fakeWorldAuthor(), author: async () => ({ kinds: "all" }) },
    };
    await expect(authorWorld({ scene: sampleFlat, sceneHash, brief }, bad)).rejects.toThrow(
      /output rejected/,
    );
  });
});

describe("improvise", () => {
  it("extends a thing's kind on request, checks it, and replays from cache", async () => {
    const calls = fakeCalls();
    const d = deps(calls);
    const { spec } = await authorWorld({ scene: sampleFlat, sceneHash, brief }, d);
    const input = {
      scene: sampleFlat,
      spec: spec!,
      brief,
      object: "obj_gen",
      request: "refuel it",
    };
    const first = await improvise(input, d);
    expect(first.kind.actions.map((a) => a.key)).toContain("refuel_it");
    expect(WorldSpec.safeParse(first.spec).success).toBe(true);
    const again = await improvise(input, d);
    expect(again.cached).toBe(true);
    expect(calls.improvise).toBe(1);
  });

  it("round-trips a kind through its draft form unchanged", async () => {
    const { spec } = await authorWorld({ scene: sampleFlat, sceneHash, brief }, deps());
    const kind = spec!.kinds[0]!;
    const { compileKind } = await import("../src/index.ts");
    expect(compileKind(draftOfKind(kind), [], kind.key)).toEqual(kind);
  });

  it("refuses things that aren't part of the world", async () => {
    const d = deps();
    const { spec } = await authorWorld({ scene: sampleFlat, sceneHash, brief }, d);
    await expect(
      improvise({ scene: sampleFlat, spec: spec!, brief, object: "obj_nowhere", request: "x" }, d),
    ).rejects.toThrow(/isn't part of this world/);
  });
});

describe("dressing a place", () => {
  it("redesigns weak thing looks and keeps every rule exactly as play-tested", async () => {
    const spec = sampleSpec;
    const critic = {
      model: { provider: "test", model: "critic", version: "1" },
      prompt: "judge",
      effort: "none",
      async critique(_sheet: Uint8Array, items: readonly { index: number; label: string }[]) {
        return {
          tiles: items.map((i) => ({
            index: i.index,
            score: i.label === "Bed" && !critic.fixed ? 2 : 9,
            fixes: ["add a pillow"],
          })),
        };
      },
      fixed: false,
    };
    const designer = {
      model: { provider: "test", model: "designer", version: "1" },
      prompt: "redesign",
      effort: "none",
      async redesign(request: { current: unknown }) {
        critic.fixed = true;
        const current = request.current as { shapes: { shape: string; when: unknown[] }[] };
        return {
          shapes: [
            ...current.shapes,
            { ...(current.shapes[0] as object), shape: "capsule", when: [] },
          ],
        };
      },
    };
    const result = await dressWorld(spec, sampleFlat, {
      critic,
      designer,
      store: new MemoryArtifactStore(),
      index: new MemoryRecipeIndex(),
    });
    const bed = (s: typeof spec) => s.kinds.find((k) => k.label === "Bed");
    expect(bed(result.spec)?.look.length).toBe((bed(spec)?.look.length ?? 0) + 1);
    // Only looks change.
    const rules = (s: typeof spec) => s.kinds.map(({ look: _, ...k }) => k);
    expect(rules(result.spec)).toEqual(rules(spec));
    expect(result.spec.things).toEqual(spec.things);
  });
});
