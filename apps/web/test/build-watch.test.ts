import { describe, expect, it } from "vitest";
import { doneLine, settle } from "../src/game/build-watch.ts";
import type { WorldSummary } from "../src/game/types.ts";

const world = (id: string, status: WorldSummary["status"]) =>
  ({ id, name: `City ${id}`, status }) as WorldSummary;

describe("watching a city being built", () => {
  it("says when one's finished, either way, and keeps waiting on the rest", () => {
    const { done, waiting } = settle(
      ["a", "b", "c"],
      [world("a", "ready"), world("b", "building"), world("c", "failed")],
    );
    expect(done.map((w) => w.id)).toEqual(["a", "c"]);
    expect(waiting).toEqual(["b"]);
  });

  it("stops watching something deleted, and doesn't announce it", () => {
    expect(settle(["gone"], [world("a", "ready")])).toEqual({ done: [], waiting: [] });
  });

  it("tells success from failure", () => {
    expect(doneLine(world("a", "ready"))).toBe("City a is ready to play.");
    expect(doneLine(world("a", "failed"))).toBe("City a couldn't be built.");
  });
});
