import { describe, expect, it } from "vitest";
import { GuestBudget } from "../src/guest-budget.ts";

describe("what guests may spend on replies", () => {
  it("stops one guest at their limit, and not another", () => {
    const budget = new GuestBudget(() => 0, 2, 100);
    expect(budget.take("a")).toBe(true);
    expect(budget.take("a")).toBe(true);
    expect(budget.take("a")).toBe(false);
    expect(budget.take("b")).toBe(true);
  });

  it("can't be got around by making more guests", () => {
    const budget = new GuestBudget(() => 0, 5, 3);
    expect(["a", "b", "c", "d", "e"].map((g) => budget.take(g))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it("starts again after an hour", () => {
    let now = 0;
    const budget = new GuestBudget(() => now, 1, 100);
    expect(budget.take("a")).toBe(true);
    expect(budget.take("a")).toBe(false);
    now = 3_600_000;
    expect(budget.take("a")).toBe(true);
  });
});
