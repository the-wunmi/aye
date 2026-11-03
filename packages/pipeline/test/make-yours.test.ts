import { hashJson, MemoryArtifactStore, MemoryRecipeIndex } from "@aye/artifacts";
import { LIBRARY_CATALOG, type LibraryCatalog } from "@aye/schema";
import { sampleFlat, sampleSpec } from "@aye/schema/fixtures";
import { cutOff, solidity } from "@aye/sim";
import { describe, expect, it } from "vitest";
import { makeYours, type PlaceChanger } from "../src/make-yours.ts";

const catalog: LibraryCatalog = LIBRARY_CATALOG;
const sofa = [...catalog.things]
  .filter((t) => !t.tags.includes("building"))
  .sort((a, b) => a.sizeMm[0] * a.sizeMm[2] - b.sizeMm[0] * b.sizeMm[2])[0];
if (!sofa) throw new Error("the library has things");
const parlour = sampleFlat.spaces.findIndex((s) => s.name === "Parlour");

function changer(answer: unknown): PlaceChanger & { calls: number } {
  return {
    model: { provider: "test", model: "changer", version: "1" },
    prompt: "change",
    effort: "low",
    calls: 0,
    async change() {
      this.calls++;
      return answer;
    },
  };
}

const deps = (c: PlaceChanger) => ({
  changer: c,
  store: new MemoryArtifactStore(),
  index: new MemoryRecipeIndex(),
  catalog,
});
const item = (over = {}) => ({
  asset: sofa.id,
  space: parlour,
  x: 1.5,
  z: 2.5,
  yawDeg: 0,
  price: 50_000,
  actions: [],
  ...over,
});

describe("making a place your own", () => {
  it("proposes what was asked for, at the price, changing nothing it was given", async () => {
    const before = hashJson(sampleFlat);
    const r = await makeYours(
      sampleFlat,
      sampleSpec,
      "something nice",
      deps(changer({ say: "Here you go", add: [item()], remove: [], move: [] })),
    );
    expect(r.added).toEqual([sofa.label]);
    expect(r.price).toBe(50_000);
    expect(r.scene?.objects.length).toBe(sampleFlat.objects.length + 1);
    expect(r.spec?.things.length).toBe(sampleSpec.things.length + 1);
    expect(hashJson(sampleFlat)).toBe(before);
  });

  it("won't let the model set a giveaway price or a silly one", async () => {
    const hourPay = sampleSpec.hourPay;
    const cheap = await makeYours(
      sampleFlat,
      sampleSpec,
      "free one",
      deps(changer({ say: "", add: [item({ price: -5 })], remove: [], move: [] })),
    );
    expect(cheap.price).toBe(Math.floor(hourPay / 2));
    const dear = await makeYours(
      sampleFlat,
      sampleSpec,
      "gold one",
      deps(changer({ say: "", add: [item({ price: 1e12 })], remove: [], move: [] })),
    );
    expect(dear.price).toBeLessThanOrEqual(hourPay * 400);
  });

  it("ignores what doesn't exist, can't be placed, or stands outside the room", async () => {
    const r = await makeYours(
      sampleFlat,
      sampleSpec,
      "nonsense",
      deps(
        changer({
          say: "No can do",
          add: [item({ asset: "not_a_thing" }), item({ x: 500 }), item({ space: 99 })],
          remove: [999],
          move: [{ thing: 999, x: 1, z: 1, yawDeg: 0 }],
        }),
      ),
    );
    expect(r.scene).toBeNull();
    expect(r.say).toContain("wouldn't fit");
    expect(r.price).toBe(0);
  });

  it("takes away what's asked, and that costs nothing", async () => {
    const r = await makeYours(
      sampleFlat,
      sampleSpec,
      "get rid of it",
      deps(changer({ say: "Gone", add: [], remove: [0], move: [] })),
    );
    expect(r.removed).toEqual([sampleFlat.objects[0]?.label]);
    expect(r.price).toBe(0);
    expect(r.spec?.things.some((t) => t.object === sampleFlat.objects[0]?.id)).toBe(false);
  });

  it("what you buy can't pay you, or hand you marks wholesale", async () => {
    const action = {
      key: "work",
      label: "Print money",
      durationMin: 60,
      capacity: 1,
      cost: 0,
      income: 99_999_999,
      requires: [],
      marks: [
        { mark: "cooking", by: 999 },
        { mark: "not_here", by: 1 },
      ],
      asks: [],
      needs: [{ need: "not_a_need", perHour: 100 }],
      sets: [],
      leaves: "no",
      pose: "stand",
      on: false,
    };
    const spec = {
      ...sampleSpec,
      marks: [{ key: "cooking", label: "Cooking", max: 5, shown: true }],
    };
    const r = await makeYours(
      sampleFlat,
      spec,
      "a money machine",
      deps(changer({ say: "", add: [item({ actions: [action] })], remove: [], move: [] })),
    );
    const bought = r.spec?.kinds.find((k) => k.asset === sofa?.id)?.actions[0];
    expect(bought?.income).toBe(0);
    expect(bought?.marks).toEqual([]);
    expect(bought?.needs).toEqual([]);
  });

  it("what you buy stays where it stands, and does you some good or nothing", async () => {
    const action = (over: object) => ({
      key: "sleep_here",
      label: "Sleep here",
      durationMin: 480,
      capacity: 1,
      cost: 0,
      income: 0,
      requires: [],
      marks: [],
      asks: [],
      needs: [{ need: "energy", perHour: 150 }],
      sets: [],
      leaves: "alone",
      pose: "lie",
      on: true,
      ...over,
    });
    const r = await makeYours(
      sampleFlat,
      sampleSpec,
      "a mat",
      deps(
        changer({
          say: "",
          add: [
            item({
              actions: [
                action({}),
                action({
                  key: "toss",
                  label: "Toss and turn",
                  needs: [{ need: "energy", perHour: -12 }],
                }),
              ],
            }),
          ],
          remove: [],
          move: [],
        }),
      ),
    );
    const actions = r.spec?.kinds.find((k) => k.asset === sofa?.id)?.actions ?? [];
    expect(actions.map((a) => a.label)).toEqual(["Sleep here"]);
    expect(actions[0]?.leaves).toBeNull();
  });

  it("won't sell you what you couldn't get to", async () => {
    // With every way between its rooms gone, the parlour stands alone: nothing in it can be got to.
    const sealed = { ...sampleFlat, openings: sampleFlat.openings.slice(0, 1) };
    const out = cutOff(sealed, solidity(sampleSpec)).spaces;
    const room = sealed.spaces.findIndex((s) => out.includes(s.id));
    expect(room).toBeGreaterThanOrEqual(0);
    const polygon = sealed.spaces[room]?.polygon ?? [];
    const xs = polygon.map((p) => p[0]);
    const zs = polygon.map((p) => p[1]);
    const middle = (v: number[]) => (Math.min(...v) + Math.max(...v)) / 2000;
    const r = await makeYours(
      sealed,
      sampleSpec,
      "a sofa",
      deps(
        changer({
          say: "",
          add: [item({ space: room, x: middle(xs), z: middle(zs) })],
          remove: [],
          move: [],
        }),
      ),
    );
    expect(r.spec).toBeFalsy();
    expect(r.say).toMatch(/get to it/);
  });

  it("only offers the model rooms someone could get into", async () => {
    const sealed = { ...sampleFlat, openings: sampleFlat.openings.slice(0, 1) };
    const out = cutOff(sealed, solidity(sampleSpec)).spaces;
    const seen: { spaces: { name: string }[] }[] = [];
    const c = changer({ say: "", add: [], remove: [], move: [] });
    const change = c.change.bind(c);
    c.change = async (...args: Parameters<typeof c.change>) => {
      seen.push(args[0] as unknown as (typeof seen)[number]);
      return change(...args);
    };
    await makeYours(sealed, sampleSpec, "a sofa", deps(c));
    const offered = seen[0]?.spaces.map((s) => s.name) ?? [];
    for (const id of out) {
      expect(offered).not.toContain(sealed.spaces.find((s) => s.id === id)?.name);
    }
    expect(offered.length).toBeGreaterThan(0);
  });

  it("says what wouldn't fit, not what the model hoped", async () => {
    const big = [...catalog.things]
      .filter((t) => !t.tags.includes("building"))
      .sort((a, b) => b.sizeMm[0] * b.sizeMm[2] - a.sizeMm[0] * a.sizeMm[2])[0];
    const r = await makeYours(
      sampleFlat,
      sampleSpec,
      "something huge",
      deps(
        changer({
          say: "All done, it looks great",
          add: [item({ asset: big?.id })],
          remove: [],
          move: [],
        }),
      ),
    );
    expect(r.say).toContain("wouldn't fit");
    expect(r.say).not.toContain("great");
    expect(r.price).toBe(0);
  });

  it("is memoised: the same ask of the same place makes no second call", async () => {
    const c = changer({ say: "x", add: [item()], remove: [], move: [] });
    const d = deps(c);
    await makeYours(sampleFlat, sampleSpec, "same", d);
    await makeYours(sampleFlat, sampleSpec, "same", d);
    expect(c.calls).toBe(1);
  });
});
