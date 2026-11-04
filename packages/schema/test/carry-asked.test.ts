/** `carryAsked`: what a personal copy of a place picks up from the place it was copied from. */
import { describe, expect, it } from "vitest";
import { sampleSpec } from "../src/fixtures.ts";
import { carryAsked, type WorldSpec } from "../src/index.ts";

const kind = sampleSpec.kinds[0] as WorldSpec["kinds"][number];
const action = kind.actions[0] as WorldSpec["kinds"][number]["actions"][number];
const withNew: WorldSpec = {
  ...sampleSpec,
  kinds: sampleSpec.kinds.map((k) =>
    k.key === kind.key ? { ...k, actions: [...k.actions, { ...action, key: "asked_for" }] } : k,
  ),
};

describe("a copy of a place someone made their own", () => {
  it("gets what's been added to the place since", () => {
    const carried = carryAsked(sampleSpec, withNew);
    const got = carried.kinds.find((k) => k.key === kind.key);
    expect(got?.actions.some((a) => a.key === "asked_for")).toBe(true);
  });

  it("is the same object when there's nothing new, so nothing rebuilds", () => {
    expect(carryAsked(sampleSpec, sampleSpec)).toBe(sampleSpec);
    expect(carryAsked(withNew, sampleSpec)).toBe(withNew);
  });

  it("keeps the kinds only the copy has", () => {
    const own: WorldSpec = {
      ...sampleSpec,
      kinds: [...sampleSpec.kinds, { ...kind, key: "bought_chair" }],
    };
    const carried = carryAsked(own, withNew);
    expect(carried.kinds.some((k) => k.key === "bought_chair")).toBe(true);
  });

  it("stays as it is if what's new can't work there", () => {
    const broken: WorldSpec = {
      ...withNew,
      kinds: withNew.kinds.map((k) =>
        k.key === kind.key
          ? {
              ...k,
              actions: k.actions.map((a) =>
                a.key === "asked_for" ? { ...a, needs: [{ need: "no_such_need", perHour: 1 }] } : a,
              ),
            }
          : k,
      ),
    };
    expect(carryAsked(sampleSpec, broken)).toBe(sampleSpec);
  });
});
