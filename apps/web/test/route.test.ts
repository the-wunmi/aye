import { describe, expect, it } from "vitest";
import { parseRoute, pathOf } from "../src/route.ts";

describe("links into the game", () => {
  it("reads a city and a place, and writes them back the same", () => {
    expect(parseRoute("/city/wld_abc123")).toEqual({ world: "wld_abc123", place: null });
    expect(parseRoute("/city/wld_abc123/")).toEqual({ world: "wld_abc123", place: null });
    expect(parseRoute("/city/wld_abc123/mama_put")).toEqual({
      world: "wld_abc123",
      place: "mama_put",
    });
    expect(pathOf("wld_abc123")).toBe("/city/wld_abc123");
    expect(pathOf("wld_abc123", "mama_put")).toBe("/city/wld_abc123/mama_put");
  });

  it("takes nothing else from the address bar", () => {
    for (const bad of [
      "/",
      "/city",
      "/city/",
      "/other/wld_abc123",
      "/city/../../etc",
      "/city/wld_abc123/Not A Key",
      "/city/wld_abc123/..%2f..",
      "/city/wld_abc123/place/more",
      "/city/javascript:alert(1)",
    ]) {
      expect(parseRoute(bad)).toBeNull();
    }
  });
});
