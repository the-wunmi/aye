/**
 * Tests for a filmed place joining a city with a scripted model: which kinds it can be, and what's
 * cleaned and bounded.
 */
import { MemoryArtifactStore, MemoryRecipeIndex } from "@aye/artifacts";
import { type CitySpec, Item } from "@aye/schema";
import { sampleCity } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import {
  type CityJoiner,
  compileJoin,
  type JoinDraft,
  joinableKinds,
  joinCity,
  placeKindsOf,
} from "../src/index.ts";

const kind = placeKindsOf(sampleCity)[0]!;
const input = {
  captureId: "cap_abc",
  at: [120, 340] as const,
  footprintM: [3, 500] as const,
  build: "A small kitchen.",
};
const draft = (over: Partial<JoinDraft> = {}): JoinDraft => ({
  kind: kind.name,
  name: "Wunmi's Kitchen",
  blurb: "Coffee on, always.",
  icon: "\u{2615}",
  tags: ["Food", "food", "rest"],
  look: null,
  asks: ["Can two people cook here?", ""],
  ...over,
});

describe("a real place joining a city", () => {
  it("becomes one of the city's own kinds, where the player put it", () => {
    const r = compileJoin(draft(), sampleCity, input)!;
    expect(Item.safeParse(r.item).success).toBe(true);
    expect(r.item.kind).toBe(kind.key);
    expect(r.item.name).toBe("Wunmi's Kitchen");
    expect(r.item.where.at).toEqual([120, 340]);
    // Whoever filmed it can walk in the moment it's built, at any hour.
    expect(r.item.traits.place?.hours).toBeNull();
    // Tags are keys, once each; the footprint is bounded whatever the scene says.
    expect(r.item.traits.place?.tags).toEqual(["food", "rest"]);
    expect(r.item.traits.place?.footprintM).toEqual([4, 200]);
    expect(r.item.traits.place?.private).toBe(false);
    expect(r.issues).toEqual([]);
    // Questions worth asking here are the model's, cleaned; empty ones go.
    expect(r.item.attrs).toEqual({ ask_1: "Can two people cook here?" });
  });

  it("gets a building of its own on the map, bounded like any other", () => {
    const shape = {
      shape: "box" as const,
      x: 0,
      y: 500,
      z: 0,
      w: 99_999,
      h: 1000,
      d: 1000,
      rx: 0,
      ry: 0,
      rz: 0,
      colour: "#aabbcc",
      glow: false,
    };
    const r = compileJoin(
      draft({ look: { lengthM: 12, heightM: 6, widthM: 9, shapes: [shape] } as never }),
      sampleCity,
      input,
    )!;
    expect(Item.safeParse(r.item).success).toBe(true);
    expect(r.item.look?.solids[0]?.size[0]).toBe(2000);
    expect(compileJoin(draft(), sampleCity, input)?.item.look).toBeUndefined();
  });

  it("is called what they called it, whatever a model would rather say", () => {
    const r = compileJoin(draft({ name: "Modern Lounge" }), sampleCity, {
      ...input,
      calledIt: "Our family home",
    })!;
    expect(r.item.name).toBe("Our family home");
    const none = compileJoin(draft({ name: "Modern Lounge" }), sampleCity, input)!;
    expect(none.item.name).toBe("Modern Lounge");
  });

  it("keeps the same key when rebuilt from the same capture, a new one from another", () => {
    const a = compileJoin(draft(), sampleCity, input)!;
    const b = compileJoin(draft(), sampleCity, input)!;
    const c = compileJoin(draft(), sampleCity, { ...input, captureId: "cap_other" })!;
    expect(a.item.key).toBe(b.item.key);
    expect(a.item.key).not.toBe(c.item.key);
  });

  it("doesn't take a model's word for anything: kinds, words and icons are checked", () => {
    const bad = compileJoin(
      draft({
        kind: "Secret Admin Bunker",
        name: `<script>x</script>${String.fromCodePoint(0x202e)}`,
        icon: "not an emoji",
      }),
      sampleCity,
      input,
    )!;
    expect(bad.item.kind).toBe(kind.key);
    expect(bad.item.name).not.toContain(String.fromCodePoint(0x202e));
    expect(bad.item.icon).toBe(kind.icon);
    expect(bad.issues.length).toBeGreaterThanOrEqual(2);
    expect(Item.safeParse(bad.item).success).toBe(true);
    // Never a kind that has to be earned: whoever filmed it couldn't get in.
    const locked = {
      kinds: [
        {
          ...kind,
          key: "lounge",
          name: "Lounge",
          traits: { place: { ...kind.traits.place, asks: [{ mark: "respect", atLeast: 4 }] } },
        },
        kind,
      ],
    } as Pick<CitySpec, "kinds">;
    expect(joinableKinds(locked).map((k) => k.key)).toEqual([kind.key]);
    expect(compileJoin(draft({ kind: "Lounge" }), locked, input)?.item.kind).toBe(kind.key);
    // A city with nowhere public to put it can't take it.
    expect(compileJoin(draft(), { kinds: [] }, input)).toBeNull();
  });

  it("is a memoised stage: the same place replays with no call", async () => {
    let calls = 0;
    const joiner: CityJoiner = {
      model: { provider: "test", model: "join", version: "1" },
      prompt: "join",
      effort: "low",
      async join() {
        calls++;
        return draft();
      },
    };
    const deps = { joiner, store: new MemoryArtifactStore(), index: new MemoryRecipeIndex() };
    const brief = {
      city: "Accra",
      kinds: [{ name: kind.name, about: kind.about, tags: [] }],
      place: { name: "Kitchen", summary: "A kitchen.", things: ["Stove"] },
      note: "",
    };
    const a = await joinCity(brief, sampleCity, input, deps);
    const b = await joinCity(brief, sampleCity, input, deps);
    expect(calls).toBe(1);
    expect(b?.called).toBe(false);
    expect(b?.item).toEqual(a?.item);
  });
});
