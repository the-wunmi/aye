import { describe, expect, it } from "vitest";
import { usualWait, waitNote } from "../src/game/build-time.ts";

const MIN = 60_000;

describe("telling someone how long a city takes", () => {
  it("uses real builds when there are some, and the usual range when not", () => {
    expect(usualWait({ lowMin: 8, highMin: 12 })).toBe("8 to 12 minutes");
    expect(usualWait({ lowMin: 9, highMin: 9 })).toBe("about 9 minutes");
    expect(usualWait(null)).toBe("10 to 15 minutes");
  });

  it("says how long it's been", () => {
    expect(waitNote(0, 4 * MIN, { lowMin: 8, highMin: 12 })).toBe(
      "Usually 8 to 12 minutes. 4 minutes so far.",
    );
    expect(waitNote(0, MIN, null)).toBe("Usually 10 to 15 minutes. 1 minute so far.");
  });

  it("is honest once it runs long, and survives a clock behind the server's", () => {
    expect(waitNote(0, 12 * MIN, { lowMin: 8, highMin: 12 })).toBe(
      "Taking longer than usual. It's still going.",
    );
    expect(waitNote(5 * MIN, 0, null)).toContain("0 minutes so far");
  });
});
