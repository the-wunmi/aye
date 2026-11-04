/** Someone arriving never lands on anyone already there, and people using a thing stand apart. */
import type { ObjectId } from "@aye/schema";
import { sampleFlat, sampleSettings, sampleSpec } from "@aye/schema/fixtures";
import { describe, expect, it } from "vitest";
import { Sim } from "../src/index.ts";

describe("arriving", () => {
  it("never puts someone on top of someone already there", () => {
    const sim = new Sim({ scene: sampleFlat, spec: sampleSpec, settings: sampleSettings });
    const base = sampleSpec.people[0]!;
    // Three newcomers through the same door, one after another.
    for (const n of [1, 2, 3]) {
      sim.step([
        {
          type: "arrive",
          person: { ...base, key: `guest${n}`, name: `Guest ${n}` },
          controlled: true,
        },
      ]);
    }
    const g = sim.grid;
    const at = (key: string) => {
      const c = sim.cell[sim.slotOf(key)] as number;
      return [(c % g.width) * g.cellMm, Math.floor(c / g.width) * g.cellMm] as const;
    };
    const keys = ["guest1", "guest2", "guest3", ...sampleSpec.people.map((p) => p.key)].filter(
      (k) => sim.slotOf(k) >= 0,
    );
    for (const a of keys) {
      for (const b of keys) {
        if (a >= b) continue;
        const [ax, az] = at(a);
        const [bx, bz] = at(b);
        expect(Math.hypot(ax - bx, az - bz), `${a} and ${b}`).toBeGreaterThanOrEqual(500);
      }
    }
  });

  it("two people using one thing stand side by side, not in each other", () => {
    const sim = new Sim({ scene: sampleFlat, spec: sampleSpec, settings: sampleSettings });
    const base = sampleSpec.people[0]!;
    const guests = ["guest1", "guest2"];
    for (const key of guests) {
      sim.step([{ type: "arrive", person: { ...base, key, name: key }, controlled: true }]);
    }
    sim.step(
      guests.map((agent) => ({
        type: "use" as const,
        agent,
        object: "obj_telly" as ObjectId,
        action: "watch",
      })),
    );
    // Long enough to walk over and settle in.
    for (let k = 0; k < 600; k++) sim.step([]);
    const g = sim.grid;
    const [a, b] = guests.map((k) => sim.cell[sim.slotOf(k)] as number) as [number, number];
    const d = Math.hypot(
      ((a % g.width) - (b % g.width)) * g.cellMm,
      (Math.floor(a / g.width) - Math.floor(b / g.width)) * g.cellMm,
    );
    expect(guests.map((k) => sim.activity(sim.slotOf(k)).action?.key)).toEqual(["watch", "watch"]);
    expect(d).toBeGreaterThanOrEqual(500);
  });
});
