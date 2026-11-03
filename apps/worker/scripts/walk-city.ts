/**
 * Walk a built city the way a player would, read-only: send an ordinary visitor from the way in
 * to every space of every place with the sim's own walking, and print what stopped them, along
 * with what the checks say of each place. For judging a city by going there, not by its layout.
 * A trusted dev tool: it acts only on the worlds you pass, and changes nothing.
 *
 * Usage: node --env-file=../../.env scripts/walk-city.ts <worldId> [...]
 */
import { fileURLToPath } from "node:url";
import { FsArtifactStore } from "@aye/artifacts/node";
import { connect, systemGetPinnedPlace, systemGetWorld } from "@aye/db";
import { readJson } from "@aye/pipeline";
import {
  type ArtifactHash,
  CitySpec,
  moversOf,
  placesOf,
  Scene,
  type Space,
  WorldId,
  WorldSpec,
} from "@aye/schema";
import { cutOff, evaluateWorld, Mode, pointInPolygon, Sim, solidity } from "@aye/sim";
import { EVAL_SETTINGS } from "../src/compile-job.ts";

const { db, close } = connect(process.env["DATABASE_URL"] as string, { max: 2 });
const store = new FsArtifactStore(
  fileURLToPath(new URL("../../../.aye/artifacts", import.meta.url)),
);
const ref = (h: string) => ({ hash: h as ArtifactHash, mediaType: "application/json", bytes: 0 });

const VISITOR = "walk_checker";
/** Sim seconds a visitor gets to reach one space before it counts as not reached. */
const PATIENCE_TICKS = 1800;

function middleOf(space: Space): [number, number] {
  const n = space.polygon.length;
  const x = space.polygon.reduce((s, p) => s + p[0], 0) / n;
  const z = space.polygon.reduce((s, p) => s + p[1], 0) / n;
  return [Math.round(x), Math.round(z)];
}

function walkEverywhere(scene: Scene, spec: WorldSpec) {
  const sim = new Sim({ scene, spec, settings: EVAL_SETTINGS });
  sim.step([
    {
      type: "arrive",
      controlled: true,
      person: {
        key: VISITOR,
        name: "A visitor",
        about: "",
        colours: { skin: "#8d5a3b", top: "#808080", bottom: "#404040" },
        body: {
          widthMm: 450,
          stepMm: 200,
          stairs: true,
          slopePermille: 150,
          speedMmPerS: 1_300,
          seated: false,
        },
        money: 1_000_000,
        needs: spec.needs.map((n) => ({ need: n.key, start: 700 })),
      },
    },
  ]);
  const me = sim.slotOf(VISITOR);
  if (me < 0) return [{ name: "(couldn't arrive)", ticks: -1, miss: "" }];
  return scene.spaces.map((space) => {
    const [x, z] = middleOf(space);
    // Walk until they stop, then ask where they ended up: the middle of a space can be under
    // a counter, so being in the space is what counts.
    sim.step([{ type: "walk", agent: VISITOR, x, z }]);
    let ticks = 1;
    while (ticks < PATIENCE_TICKS && sim.mode[me] !== Mode.Idle) {
      sim.step([]);
      ticks++;
    }
    const at = sim.position(me) as [number, number];
    const ended = scene.spaces.find((s) => pointInPolygon(at[0], at[1], s.polygon))?.name;
    return {
      name: space.name,
      ticks: pointInPolygon(at[0], at[1], space.polygon) ? ticks : -1,
      miss: `after ${ticks} ticks, in ${ended ?? "no space"}${ticks >= PATIENCE_TICKS ? ", still walking" : ""}`,
    };
  });
}

try {
  for (const raw of process.argv.slice(2)) {
    const worldId = WorldId.parse(raw);
    const world = await systemGetWorld(db, worldId);
    if (!world?.city) continue;
    const city = CitySpec.parse(await readJson(store, ref(world.city)));
    for (const m of moversOf(city)) {
      console.log(
        `${m.label}: ${m.way}, goes to ${m.serves.length > 0 ? m.serves.join(", ") : "everywhere"}`,
      );
    }
    for (const place of placesOf(city)) {
      const pinned = await systemGetPinnedPlace(db, worldId, place.key);
      if (!pinned?.spec) {
        console.log(`\n${place.name}: not built`);
        continue;
      }
      const scene = Scene.parse(await readJson(store, ref(pinned.scene)));
      const spec = WorldSpec.parse(await readJson(store, ref(pinned.spec)));
      const cut = cutOff(scene, solidity(spec));
      const walked = walkEverywhere(scene, spec);
      const evaluation = evaluateWorld(scene, spec, EVAL_SETTINGS, { hours: 24 });
      console.log(
        `\n${place.name}: ${scene.spaces.length} spaces, ${scene.objects.length} objects, ` +
          `${spec.kinds.length} kinds, ${spec.people.length} people; ` +
          `cut off ${cut.spaces.length} spaces, ${cut.things.length} things`,
      );
      console.log(
        `  walked: ${walked.map((w) => `${w.name} ${w.ticks < 0 ? `NOT REACHED (${w.miss})` : `${w.ticks}s`}`).join(", ")}`,
      );
      const placed = new Set(spec.things.map((t) => t.kind));
      const scenery = spec.kinds.filter((k) => placed.has(k.key) && k.actions.length === 0);
      console.log(
        `  does nothing: ${scenery.length} of ${placed.size} kinds: ${scenery.map((k) => k.label).join(", ")}`,
      );
      for (const f of evaluation.findings)
        console.log(`  ${f.severity}: ${f.message.slice(0, 220)}`);
    }
  }
} finally {
  await close();
}
