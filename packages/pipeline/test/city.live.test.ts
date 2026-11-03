/**
 * Live eval: does Muse design a whole playable city and its interface from a sentence?
 * Skipped without MUSE_API_KEY; cached under .aye/ like the world evals, so re-runs are free.
 * Assertions are about what makes a game playable, not about particular names or numbers.
 */
import { fileURLToPath } from "node:url";
import { FsArtifactStore, FsRecipeIndex } from "@aye/artifacts/node";
import { moversOf, placesOf, waterOf } from "@aye/schema";
import { describe, expect, it } from "vitest";
import { authorCity, museCityAuthor, museConfigFrom } from "../src/index.ts";

const live = Boolean(process.env["MUSE_API_KEY"]);
const root = fileURLToPath(new URL("../../../.aye/", import.meta.url));
export const LAGOS =
  "Lagos, Nigeria: the mainland and the island across the lagoon. Buka food, danfo buses and okadas, Yaba tech hubs, markets, beaches, churches and mosques, owambe parties, hustling to make rent, NEPA taking the light.";

describe.skipIf(!live)("Muse city harness (live)", () => {
  it("designs a playable city and its interface", { timeout: 1_800_000 }, async () => {
    const cfg = museConfigFrom(process.env);
    const result = await authorCity(
      { description: LAGOS },
      {
        author: museCityAuthor(cfg),
        store: new FsArtifactStore(`${root}artifacts`),
        index: new FsRecipeIndex(root),
      },
    );
    const city = result.spec;
    expect(city, JSON.stringify(result.findings)).not.toBeNull();
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(city!.currency).toBe("NGN");
    expect(placesOf(city!).filter((p) => !p.private).length).toBeGreaterThanOrEqual(6);
    // Every way to get around is drawn as itself.
    expect(moversOf(city!).every((m) => m.look !== null)).toBe(true);
    expect(city!.starts.length).toBeGreaterThan(0);
    expect(city!.ui.apps.length).toBeGreaterThanOrEqual(3);
    expect(waterOf(city!).length).toBeGreaterThan(0);
  });
});
