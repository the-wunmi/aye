/**
 * Tests for the city harness without a model: compiling a draft, repairing and critiquing a city,
 * the authoring loop and dressing.
 */
import { hashJson, MemoryArtifactStore, MemoryRecipeIndex } from "@aye/artifacts";
import { type ArtifactHash, CitySpec, moversOf, placesOf } from "@aye/schema";
import { sampleCity } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import { fakeCalls, fakeCityAuthor } from "../src/fake.ts";
import {
  authorCity,
  type CityDraft,
  compileCity,
  contrast,
  critiqueCity,
  draftOfCity,
  dressCity,
  repairCity,
  unplayable,
} from "../src/index.ts";

const briefHash = hashJson({ description: "test" }) as ArtifactHash;
const author = sampleCity.author;
const compile = (draft: CityDraft) => compileCity({ draft, briefHash, author });
const messages = (city: CitySpec) => critiqueCity(city).map((f) => `${f.severity}: ${f.message}`);
type DraftItem = CityDraft["items"][number];
type DraftKind = CityDraft["kinds"][number];
/** Change one item (by name) or kind (by name) of a draft. */
const editItem = (draft: CityDraft, name: string, f: (i: DraftItem) => DraftItem) => {
  draft.items = draft.items.map((i) => (i.name === name ? f(i) : i));
};
const editKind = (draft: CityDraft, name: string, f: (k: DraftKind) => DraftKind) => {
  draft.kinds = draft.kinds.map((k) => (k.name === name ? f(k) : k));
};

describe("compiling a city", () => {
  it("round-trips: the draft of a spec compiles back to the same spec", () => {
    const { spec, issues } = compile(draftOfCity(sampleCity));
    expect(issues).toEqual([]);
    expect(spec).toEqual({ ...sampleCity, brief: briefHash });
  });

  it("keeps the lines someone reads while waiting clean, short and few", () => {
    const draft = draftOfCity(sampleCity);
    expect(draft.buildingLines).toEqual(sampleCity.buildingLines);
    const RLO = String.fromCodePoint(0x202e);
    const { spec } = compile({
      ...draft,
      buildingLines: [`  Hello${RLO} there  `, "   ", "x".repeat(300)],
    });
    expect(spec?.buildingLines[0]).toBe("Hello there");
    expect(spec?.buildingLines).toHaveLength(2);
    expect(spec?.buildingLines[1]?.length).toBeLessThanOrEqual(80);
  });

  it("derives keys from names and maps references through them", () => {
    const draft = draftOfCity(sampleCity);
    editItem(draft, "Mama's spot", (i) => ({ ...i, name: "Mama Put!" }));
    draft.apps[0]?.blocks.push({
      ...(draft.apps[0]?.blocks[0] as CityDraft["apps"][number]["blocks"][number]),
      type: "button",
      label: "Eat",
      intent: { do: "show_place", target: "mama put" },
    });
    const { spec } = compile(draft);
    expect(placesOf(spec!).map((p) => p.key)).toEqual(["your_flat", "mama_put"]);
    expect(spec?.ui.apps[0]?.blocks.at(-1)).toEqual({
      type: "button",
      label: "Eat",
      intent: { do: "show_place", place: "mama_put" },
    });
  });

  it("scales a fare nobody would pay down to what a ride is worth, keeping the city", () => {
    const draft = draftOfCity(sampleCity);
    const rich = {
      ...draft,
      kinds: draft.kinds.map((k) =>
        k.mover && k.mover.holds > 0
          ? { ...k, mover: { ...k.mover, baseFare: draft.hourPay, farePerKm: draft.hourPay } }
          : k,
      ),
    };
    const { spec, issues } = compile(rich);
    expect(issues.filter((i) => i.includes("costs"))).toEqual([]);
    const paid = (spec as CitySpec).kinds.flatMap((k) =>
      k.traits.mover && k.traits.mover.holds > 0 ? [k.traits.mover] : [],
    );
    expect(paid.length).toBeGreaterThan(0);
    for (const m of paid) {
      expect(m.fare.base + m.fare.perKm * 5).toBeLessThanOrEqual(draft.hourPay / 2);
      expect(m.fare.perKm).toBeGreaterThan(0);
    }
  });

  it("raises a money goal that's soon earned, and doesn't leave its words saying otherwise", () => {
    const draft = draftOfCity(sampleCity);
    const start = draft.starts[0] as CityDraft["starts"][number];
    const aim = start.aim as NonNullable<typeof start.aim>;
    const low = (text: string) => ({
      ...draft,
      hourPay: 100_000,
      starts: [
        {
          ...start,
          aim: {
            ...aim,
            steps: [
              { ...(aim.steps[0] as (typeof aim.steps)[number]), mark: "", atLeast: 200_000, text },
            ],
          },
        },
      ],
    });
    const stepOf = (text: string) => compile(low(text)).spec?.starts[0]?.aim?.steps[0];
    expect(stepOf("Save 2,000 for a stall")).toEqual({ money: 3_000_000, text: "Save up" });
    expect(stepOf("Put money by")).toEqual({ money: 3_000_000, text: "Put money by" });
  });

  it("raises bills that would never bite, keeping them in proportion", () => {
    const draft = draftOfCity(sampleCity);
    const hourPay = 100_000;
    const cheap = {
      ...draft,
      hourPay,
      bills: [
        { ...(draft.bills[0] as CityDraft["bills"][number]), amount: 6_000, everyDays: 3 },
        {
          ...(draft.bills[0] as CityDraft["bills"][number]),
          name: "Fuel",
          amount: 2_000,
          everyDays: 1,
        },
        {
          ...(draft.bills[0] as CityDraft["bills"][number]),
          name: "Stipend",
          amount: 500,
          everyDays: 1,
          pays: true,
        },
      ],
    };
    const { spec } = compile(cheap);
    const bills = spec?.economy.bills ?? [];
    const perDay = (bills[0]?.amount ?? 0) / 3 + (bills[1]?.amount ?? 0);
    expect(perDay).toBeGreaterThanOrEqual(hourPay * 2);
    expect(bills[0]?.amount).toBe((bills[1]?.amount ?? 0) * 3);
    expect(bills[2]?.amount).toBe(500);
  });

  it("clamps everything to the map and bounds, and says what it changed", () => {
    const draft = draftOfCity(sampleCity);
    editItem(draft, "Mama's spot", (i) => ({ ...i, x: 10, z: 99_999 }));
    editKind(draft, "Food spot", (k) => ({
      ...k,
      place: { ...k.place!, widthM: 1e9, heightM: -3 },
    }));
    editKind(draft, "Bus", (k) => ({ ...k, mover: { ...k.mover!, speedKmh: 9_999, holds: -4 } }));
    const { spec } = compile(draft);
    const spot = placesOf(spec!)[1];
    expect(spot?.at).toEqual([10, 4000]);
    expect(spot?.sizeM[0]).toBe(400);
    expect(spot?.heightM).toBe(2);
    expect(moversOf(spec!)[1]?.speedKmh).toBe(150);
    expect(moversOf(spec!)[1]?.holds).toBe(0);
  });

  it("only real colours and single emoji get through; markup never does", () => {
    const draft = draftOfCity(sampleCity);
    draft.icon = "<img src=x onerror=alert(1)>";
    draft.theme.accent = "red; background:url(javascript:alert(1))";
    editKind(draft, "Flat", (k) => ({ ...k, icon: "home" }));
    const { spec, issues } = compile(draft);
    expect(spec?.icon).toBe("\u{1F3D9}\u{FE0F}");
    expect(spec?.theme.colours.accent).toBe("#1a7f4e");
    expect(placesOf(spec!)[0]?.icon).toBe("\u{1F4CD}");
    expect(issues.some((i) => i.includes("isn't a single emoji"))).toBe(true);
    expect(issues.some((i) => i.includes("isn't a #rrggbb colour"))).toBe(true);
  });

  it("drops buttons that go nowhere and references to things that don't exist", () => {
    const draft = draftOfCity(sampleCity);
    draft.place.push({
      region: "top",
      widgets: [
        {
          ...(draft.place[0]?.widgets[0] as CityDraft["place"][number]["widgets"][number]),
          type: "button",
          label: "Ghost",
          icon: "\u{1F47B}",
          intent: { do: "open_app", target: "nowhere" },
        },
      ],
    });
    draft.starts.push({ name: "Squatter", blurb: "", money: 1, home: "Mama's spot", aim: null });
    const { spec, issues } = compile(draft);
    expect(spec?.ui.place.find((s) => s.region === "top")?.widgets).toEqual([]);
    expect(spec?.starts.map((s) => s.key)).toEqual(["fresh_start"]);
    expect(issues).toContain('place top widget 0 opens app "nowhere", which doesn\'t exist.');
    expect(issues.some((i) => i.includes("isn't private"))).toBe(true);
  });
});

describe("a city that's had its rounds", () => {
  it("gets back what a player can't do without, and stays valid", () => {
    const bare: CitySpec = {
      ...sampleCity,
      ui: { ...sampleCity.ui, map: [], place: [] },
    };
    const repaired = repairCity(bare);
    expect(CitySpec.safeParse(repaired).success).toBe(true);
    const missing = critiqueCity(repaired).filter(
      (f) =>
        f.severity === "error" &&
        /clock|life widget|trip widget|threads widget|wallet|their needs|chat|back to the map/i.test(
          f.message,
        ),
    );
    expect(missing).toEqual([]);
    // Doesn't add what's already there.
    expect(repairCity(sampleCity).ui.map).toEqual(sampleCity.ui.map);
  });

  it("only fails on what really stops anyone living there", () => {
    expect(unplayable(sampleCity)).toEqual([]);
    expect(unplayable({ ...sampleCity, starts: [] }).length).toBeGreaterThan(0);
    const noFreeWay = {
      ...sampleCity,
      kinds: sampleCity.kinds.filter((k) => k.traits.mover?.fare.base !== 0),
    };
    expect(unplayable(noFreeWay).length).toBeGreaterThan(0);
  });
});

describe("critiquing a city", () => {
  it("won't keep a way around that only goes to one place", () => {
    const oneStop = {
      ...sampleCity,
      kinds: sampleCity.kinds.map((k) =>
        k.traits.mover && k.traits.mover.fare.base > 0
          ? { ...k, traits: { ...k.traits, mover: { ...k.traits.mover, serves: ["food_spot"] } } }
          : k,
      ),
    } as CitySpec;
    expect(messages(oneStop).join("\n")).toMatch(/only goes to one place/);
  });

  it("won't open a city where someone joining at night has nowhere to go", () => {
    // The sample's one public place shuts from 23:00 to 06:00.
    expect(messages(sampleCity).join("\n")).toMatch(
      /error: Every public place is shut for 7 hours/,
    );
    const allNight = {
      ...sampleCity,
      kinds: sampleCity.kinds.map((k) =>
        k.traits.place
          ? { ...k, traits: { ...k.traits, place: { ...k.traits.place, hours: null } } }
          : k,
      ),
    } as CitySpec;
    expect(messages(allNight).join("\n")).not.toMatch(/Every public place is shut/);
  });

  it("measures contrast like WCAG", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  });

  it("flags unreadable text, a HUD missing the essentials, and no free way to move", () => {
    const bad: CitySpec = {
      ...sampleCity,
      theme: { ...sampleCity.theme, colours: { ...sampleCity.theme.colours, ink: "#dddddd" } },
      kinds: sampleCity.kinds.filter((k) => k.key !== "walk"),
      ui: { ...sampleCity.ui, place: [] },
    };
    const found = messages(bad);
    expect(found.some((m) => m.startsWith("error: ink text on bg"))).toBe(true);
    expect(found).toContain("error: Inside a place, players can't see their money: add a wallet.");
    expect(found).toContain(
      "error: Inside a place, there's no way back to the map: add a button that opens the map.",
    );
    expect(found).toContain(
      "error: Someone with no money can't get anywhere: add a free way to travel that always runs.",
    );
  });
});

describe("the city harness", () => {
  it("writes, checks and revises, and replays from cache with zero model calls", async () => {
    const calls = fakeCalls();
    const deps = {
      author: fakeCityAuthor(calls),
      store: new MemoryArtifactStore(),
      index: new MemoryRecipeIndex(),
    };
    const first = await authorCity({ description: "A small test town" }, deps);
    expect(first.spec?.name).toBe("Testville");
    // The sample has one public place, so the critique asks for more; the fake can't learn.
    expect(first.findings.some((f) => f.message.includes("public places"))).toBe(true);
    expect(first.rounds).toBe(3);
    const made = calls.author + calls.revise;
    expect(made).toBe(3);

    const again = await authorCity({ description: "A small test town" }, deps);
    expect(calls.author + calls.revise).toBe(made);
    expect(again.spec).toEqual(first.spec);
    expect(again.cached).toBe(again.stages.length);
  });
});

describe("dressing a city: the visual loop", () => {
  it("judges every look, redesigns the weak ones from a picture, and keeps the improvement", async () => {
    const judged: string[] = [];
    const roofs = (shapes: readonly { shape: string }[]) =>
      shapes.filter((x) => x.shape === "wedge").length;
    const critic = {
      model: { provider: "test", model: "critic", version: "1" },
      prompt: "judge",
      effort: "none",
      calls: 0,
      async critique(sheet: Uint8Array, items: readonly { index: number; label: string }[]) {
        critic.calls++;
        expect([...sheet.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
        judged.push(...items.map((i) => i.label));
        return {
          tiles: items.map((i) => ({
            index: i.index,
            // The flat passes once it has two roofs.
            score: i.label.startsWith("Your flat") && critic.flatRoofs < 2 ? 3 : 9,
            fixes: ["add a second wedge roof over the porch"],
          })),
        };
      },
      flatRoofs: 1,
    };
    const designer = {
      model: { provider: "test", model: "designer", version: "1" },
      prompt: "redesign",
      effort: "none",
      calls: 0,
      async redesign(
        request: { label: string; current: unknown; fixes: readonly string[] },
        image: Uint8Array,
      ) {
        designer.calls++;
        expect(image.byteLength).toBeGreaterThan(100);
        expect(request.fixes).toContain("add a second wedge roof over the porch");
        const current = request.current as { shapes: { shape: string }[] };
        const shapes = [
          ...current.shapes,
          { ...(current.shapes[1] as object), shape: "wedge", y: 700 },
        ];
        critic.flatRoofs = roofs(shapes);
        return { shapes };
      },
    };
    const deps = {
      critic,
      designer,
      store: new MemoryArtifactStore(),
      index: new MemoryRecipeIndex(),
    };
    const result = await dressCity(sampleCity, deps);
    expect(judged.some((l) => l.startsWith("Character look 1"))).toBe(true);
    expect(designer.calls).toBe(1);
    const flat = placesOf(result.spec).find((p) => p.key === "your_flat");
    expect(roofs(flat?.look?.solids ?? [])).toBe(2);
    expect(result.scores.get("Your flat: Two rooms, a kitchen and a generator.")).toBe(9);
    // Kinds seen on the map as themselves are judged too (what people travel in).
    expect(judged.some((l) => l.startsWith("Bus:"))).toBe(true);
    // Dressing only touches looks.
    const withoutLooks = (c: CitySpec) => ({
      ...c,
      characters: [],
      kinds: c.kinds.map((k) => ({ ...k, look: null })),
      items: c.items.map(({ look: _, ...i }) => i),
    });
    expect(withoutLooks(result.spec)).toEqual(withoutLooks(sampleCity));
    // And replays with no calls.
    const calls = critic.calls + designer.calls;
    await dressCity(sampleCity, deps);
    expect(critic.calls + designer.calls).toBe(calls);
  });
});

describe("panels in the critique", () => {
  it("wants every app on a panel, and every panel reachable", () => {
    const stranded: CitySpec = {
      ...sampleCity,
      ui: {
        ...sampleCity.ui,
        panels: [
          { key: "mobile", label: "Mobile", icon: "\u{1F4F1}", form: "handheld", apps: ["work"] },
        ],
      },
    };
    expect(messages(stranded)).toContain('error: App "Ride" isn\'t on any panel: put it on one.');
    const hidden: CitySpec = {
      ...sampleCity,
      ui: {
        ...sampleCity.ui,
        map: sampleCity.ui.map.filter((s) => s.region !== "bottom_right"),
        place: sampleCity.ui.place.map((s) =>
          s.region === "bottom_right"
            ? { ...s, widgets: s.widgets.filter((w) => w.type !== "panel") }
            : s,
        ),
      },
    };
    expect(messages(hidden).some((m) => m.includes('Panel "Mobile" can\'t be opened'))).toBe(true);
    expect(messages(sampleCity).filter((m) => /panel/i.test(m))).toEqual([]);
  });
});
