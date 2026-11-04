/** How money owed reads: rounded up to whole units, whatever the currency's part-units. */
import { describe, expect, it } from "vitest";
import { moneyOwed } from "../src/format.ts";

const plain = (s: string) => s.replace(/\s/g, "");

describe("what you owe", () => {
  it("is shown to the next whole unit, so it never reads less than you need", () => {
    expect(plain(moneyOwed(6_676, "NGN"))).toContain("67");
    expect(plain(moneyOwed(6_676, "NGN"))).not.toContain(".");
  });

  it("keeps small change when that's all it is", () => {
    expect(plain(moneyOwed(950, "GBP"))).toContain("9.50");
  });

  it("copes with a currency that has no part-units", () => {
    expect(plain(moneyOwed(1_500, "JPY"))).toContain("1,500");
  });
});
