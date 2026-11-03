/**
 * Repair the layouts of a city's places (built before assembly kept them walkable): cut a
 * doorway into any room nobody could walk into (`openSealedSpaces`) and slide anything
 * standing in a doorway's approach out of the way (`clearWays`), the same code new builds use, and pin the result as each place's next revision. Reports how many things
 * people can reach before and after. A trusted dev tool: it acts only on the worlds you pass.
 *
 * Usage: node --env-file=../../.env scripts/clear-ways.ts <worldId> [...]
 */
import { fileURLToPath } from "node:url";
import { encodeJson } from "@aye/artifacts";
import { FsArtifactStore } from "@aye/artifacts/node";
import { connect, systemGetPinnedPlace, systemGetWorld, systemRecordArtifacts } from "@aye/db";
import { bringInside, clearWays, makeWayThrough, openSealedSpaces, readJson } from "@aye/pipeline";
import {
  type ArtifactHash,
  CitySpec,
  type PlaceRevision,
  placesOf,
  Scene,
  type UserId,
  WorldId,
  WorldSpec,
} from "@aye/schema";
import { Sim, solidity } from "@aye/sim";
import { EVAL_SETTINGS } from "../src/compile-job.ts";
import { commitAndPin } from "../src/pin.ts";

const { db, close } = connect(process.env["DATABASE_URL"] as string, { max: 2 });
const store = new FsArtifactStore(
  fileURLToPath(new URL("../../../.aye/artifacts", import.meta.url)),
);
const ref = (h: string) => ({ hash: h as ArtifactHash, mediaType: "application/json", bytes: 0 });

/** Things with something to do that nobody present can get to. */
function unreachable(scene: Scene, spec: WorldSpec): number {
  const sim = new Sim({ scene, spec, settings: EVAL_SETTINGS });
  sim.step([]);
  let n = 0;
  sim.things.forEach((_, t) => {
    for (let i = 0; i < sim.agentIds.length; i++) if (sim.present[i] && sim.canReach(i, t)) return;
    n++;
  });
  return n;
}

try {
  for (const raw of process.argv.slice(2)) {
    const worldId = WorldId.parse(raw);
    const world = await systemGetWorld(db, worldId);
    if (!world?.city) continue;
    const city = CitySpec.parse(await readJson(store, ref(world.city)));
    for (const place of placesOf(city)) {
      const pinned = await systemGetPinnedPlace(db, worldId, place.key);
      if (!pinned?.spec) continue;
      const scene = Scene.parse(await readJson(store, ref(pinned.scene)));
      const spec = WorldSpec.parse(await readJson(store, ref(pinned.spec)));
      const { scene: open, opened } = openSealedSpaces(scene);
      const { scene: inside, moved: strays } = bringInside(open);
      const { scene: clearer, moved: cleared_ } = clearWays(inside);
      const { scene: cleared, moved: through } = makeWayThrough(clearer, solidity(spec));
      const moved = cleared_ + strays.length + through.length;
      const before = unreachable(scene, spec);
      if (moved === 0 && opened.length === 0) {
        console.log(`${city.name} / ${place.name}: clear already (${before} out of reach)`);
        continue;
      }
      const after = unreachable(cleared, spec);
      // Only ever keep a layout that's better for the people in it.
      if (after >= before) {
        console.log(
          `${city.name} / ${place.name}: moving ${moved} wouldn't help (${before} → ${after}); kept`,
        );
        continue;
      }
      const sceneRef = await store.put(encodeJson(cleared), "application/json");
      const specRef = ref(pinned.spec);
      await systemRecordArtifacts(db, [sceneRef]);
      const rev: PlaceRevision = {
        placeId: pinned.placeId as PlaceRevision["placeId"],
        parent: pinned.revision as ArtifactHash,
        base: sceneRef,
        edits: [],
        scene: sceneRef,
        world: { spec: { ...specRef, mediaType: "application/json" }, approved: false },
        authorId: world.ownerId as UserId,
        message: "Opened sealed rooms and cleared doorways",
        createdAt: new Date().toISOString(),
      };
      await commitAndPin(
        db,
        { worldId, key: place.key, ownerId: world.ownerId as UserId },
        rev,
        cleared,
      );
      console.log(
        `${city.name} / ${place.name}: moved ${moved}; out of reach ${before} → ${after}`,
      );
    }
  }
} finally {
  await close();
}
