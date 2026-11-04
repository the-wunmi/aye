/** Money the city pays someone is a command, so it stays deterministic and can't take any away. */
import { sampleFlat, sampleSettings, sampleSpec } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import { Sim } from "../src/index.ts";

describe("grants", () => {
  it("pay someone the city's money, deterministically, and never take any away", () => {
    const make = () => new Sim({ scene: sampleFlat, spec: sampleSpec, settings: sampleSettings });
    const a = make();
    const b = make();
    const slot = a.slotOf("tolu");
    const before = a.wallet[slot] as number;
    for (const sim of [a, b]) {
      sim.step([{ type: "grant", agent: "tolu", amount: 5_000 }]);
      sim.step([{ type: "grant", agent: "tolu", amount: -1_000_000 }]);
    }
    expect(a.wallet[slot]).toBe(before + 5_000);
    expect(a.hash()).toBe(b.hash());
    // Nobody: nothing happens.
    const r = a.step([{ type: "grant", agent: "ghost", amount: 5_000 }]);
    expect(r.some((e) => e.type === "command_rejected")).toBe(true);
  });
});
