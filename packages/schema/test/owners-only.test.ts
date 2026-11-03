/** What only an owner can do, so boards and the director don't send newcomers to it. */
import { describe, expect, it } from "vitest";
import { sampleSpec } from "../src/fixtures.ts";
import { ownersOnly, type WorldSpec } from "../src/world-spec.ts";

describe("ownersOnly", () => {
  const kind = sampleSpec.kinds[0] as WorldSpec["kinds"][number];
  const action = kind.actions[0] as WorldSpec["kinds"][number]["actions"][number];
  const takes = { ...action, cost: 0, leaves: { withThing: true } } as typeof action;
  const withOwners = (...owners: (string | undefined)[]) =>
    ({
      ...sampleSpec,
      things: owners.map((owner, i) => ({
        ...(sampleSpec.things[0] as WorldSpec["things"][number]),
        object: `t${i}`,
        kind: kind.key,
        ...(owner ? { owner } : {}),
      })),
    }) as WorldSpec;

  it("is true only when every one of them belongs to someone", () => {
    expect(ownersOnly(withOwners("a", "b"), kind.key, takes)).toBe(true);
    expect(ownersOnly(withOwners("a", undefined), kind.key, takes)).toBe(false);
  });

  it("doesn't cover what's paid for, or what doesn't leave with the thing", () => {
    expect(ownersOnly(withOwners("a"), kind.key, { ...takes, cost: 100 })).toBe(false);
    const stays = { ...takes, leaves: null } as unknown as typeof takes;
    expect(ownersOnly(withOwners("a"), kind.key, stays)).toBe(false);
  });
});
