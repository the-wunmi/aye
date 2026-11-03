/**
 * Live evals: does Muse build the worlds we actually want?
 *
 * Skipped without MUSE_API_KEY (CI has none). Runs the real harness, cached under the repo's
 * .aye/: the first run asks the model, later runs replay the stored answers with no calls, so
 * these are cheap to keep running, and a changed prompt or model shows up as a fresh,
 * evaluated answer. Assertions are about meaning, not exact numbers: nothing in code knows
 * what a car is, so if the car can be uncovered, opened and driven, the model put that there.
 */
import { fileURLToPath } from "node:url";
import { FsArtifactStore, FsRecipeIndex } from "@aye/artifacts/node";
import type { WorldSpec } from "@aye/schema";
import { sampleSettings } from "@aye/schema/fixtures";
import { evaluateWorld, Sim, staticFindings, TICKS_PER_HOUR } from "@aye/sim";
import { describe, expect, it } from "vitest";
import {
  authorWorld,
  briefFor,
  compilePlace,
  improvise,
  metaDescriber,
  museConfigFrom,
  museWorldAuthor,
} from "../src/index.ts";

const live = Boolean(process.env["MUSE_API_KEY"]);
const root = fileURLToPath(new URL("../../../.aye/", import.meta.url));
const DESCRIPTION =
  "A family compound yard in Surulere, Lagos: a car under a dust cover, a small petrol generator, a few plastic chairs under a mango tree, a water drum, and a gate to the street.";

describe.skipIf(!live)("Muse world harness (live)", () => {
  const cfg = live ? museConfigFrom(process.env) : null;
  const store = new FsArtifactStore(`${root}artifacts`);
  const index = new FsRecipeIndex(root);
  let place: Awaited<ReturnType<typeof compilePlace>>;
  let spec: WorldSpec;

  const critique = (s: WorldSpec) => evaluateWorld(place.scene, s, sampleSettings).findings;
  it("lays out a place from words alone", { timeout: 600_000 }, async () => {
    place = await compilePlace(
      { kind: "description", text: DESCRIPTION },
      { store, index, describer: metaDescriber(cfg!) },
    );
    expect(place.scene.objects.length).toBeGreaterThanOrEqual(5);
  });

  it("writes a world whose every reference holds, revising until it plays", {
    timeout: 1_200_000,
  }, async () => {
    const result = await authorWorld(
      {
        scene: place.scene,
        sceneHash: place.sceneRef.hash,
        brief: briefFor({
          scene: place.scene,
          ...place.place,
          description: DESCRIPTION,
        }),
      },
      { author: museWorldAuthor(cfg!), store, index, critique },
    );
    expect(place.place.currency).toBe("NGN");
    expect(result.spec).not.toBeNull();
    spec = result.spec!;
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(spec.things).toHaveLength(place.scene.objects.length);
  });

  /**
   * What takes someone out of here with it, gated by state another of its actions changes. The
   * model names things what it likes (a "Corolla under cover", and an "old car tyre" beside it),
   * so the vehicle is found by what it does, never by a word in its label.
   */
  const gatedRide = () =>
    spec.kinds.flatMap((kind) =>
      kind.actions
        .filter((a) => a.leaves?.withThing)
        .filter((drive) =>
          drive.requires.some(
            (c) =>
              "var" in c &&
              kind.actions.some((a) => a !== drive && a.sets.some((x) => x.var === c.var)),
          ),
        )
        .map((drive) => ({ kind, drive })),
    );

  it("gives the covered car real state and a multi-step way to drive it", () => {
    const rides = gatedRide();
    expect(rides.length, "something you uncover or open, then leave with").toBeGreaterThan(0);
    expect(rides[0]?.kind.vars.length).toBeGreaterThan(0);
  });

  // Whether anyone here fancies a drive, and what else it takes first (petrol from somewhere, say),
  // is the model's to write, and differs every time. That it can be done isn't: nothing the ride
  // waits for may be something that never comes about.
  it("plays: nothing about taking the car out is impossible", () => {
    const ride = gatedRide()[0];
    expect(ride).toBeDefined();
    const impossible = staticFindings(spec).filter((f) => f.severity === "error");
    expect(impossible).toEqual([]);
    // And the world really runs for two days with it.
    const sim = new Sim({ scene: place.scene, spec, settings: sampleSettings });
    for (let t = 0; t < 48 * TICKS_PER_HOUR; t++) sim.step();
    expect(sim.tick).toBeGreaterThanOrEqual(48 * TICKS_PER_HOUR);
  });

  it("improvises a new ability on request", { timeout: 600_000 }, async () => {
    const ride = gatedRide()[0];
    const car = place.scene.objects.find(
      (o) => spec.things.find((t) => t.object === o.id)?.kind === ride?.kind.key,
    )!;
    const result = await improvise(
      {
        scene: place.scene,
        spec,
        brief: briefFor({
          scene: place.scene,
          ...place.place,
          description: DESCRIPTION,
        }),
        object: car.id,
        request: "wash the car with water from the drum",
      },
      { author: museWorldAuthor(cfg!), store, index, critique },
    );
    expect(result.kind.actions.some((a) => /wash/i.test(a.label))).toBe(true);
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
  });
});
