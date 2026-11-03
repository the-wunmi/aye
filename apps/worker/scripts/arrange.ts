/**
 * Arrange the places of existing cities (built before the harness looked at seats): the
 * arranger sees each seat with what's around it and says which way it should face; physics
 * and a replay decide each turn (`arrangePlace`, the same stage new builds run). Turned
 * places are pinned as their next revision. A trusted dev tool: it acts only on the worlds
 * you pass. Set SHEETS_DIR to keep the pictures the model was shown.
 *
 * Usage: node --env-file=../../.env scripts/arrange.ts <worldId> [...]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeJson } from "@aye/artifacts";
import { FsArtifactStore } from "@aye/artifacts/node";
import {
  connect,
  PgRecipeIndex,
  systemGetPinnedPlace,
  systemGetWorld,
  systemRecordArtifacts,
} from "@aye/db";
import { type Arranger, arrangePlace, museArranger, museConfigFrom, readJson } from "@aye/pipeline";
import {
  type ArtifactHash,
  CitySpec,
  LIBRARY_CATALOG,
  type PlaceRevision,
  placesOf,
  Scene,
  type UserId,
  WorldId,
  WorldSpec,
} from "@aye/schema";
import { evaluateWorld } from "@aye/sim";
import { EVAL_SETTINGS } from "../src/compile-job.ts";
import { libraryFiles } from "../src/library-files.ts";
import { commitAndPin } from "../src/pin.ts";

const { db, close } = connect(process.env["DATABASE_URL"] as string, { max: 2 });
const store = new FsArtifactStore(
  fileURLToPath(new URL("../../../.aye/artifacts", import.meta.url)),
);
const index = new PgRecipeIndex(db);
const ref = (h: string) => ({ hash: h as ArtifactHash, mediaType: "application/json", bytes: 0 });
const sheets = process.env["SHEETS_DIR"];
if (sheets) mkdirSync(sheets, { recursive: true });

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
      const live = museArranger(museConfigFrom(process.env));
      let n = 0;
      const arranger: Arranger = {
        ...live,
        async arrange(sheet, items, ctx) {
          if (sheets) writeFileSync(join(sheets, `${place.key}-${n++}.png`), sheet);
          return live.arrange(sheet, items, ctx);
        },
      };
      const result = await arrangePlace(scene, spec, {
        arranger,
        store,
        index,
        catalog: LIBRARY_CATALOG,
        readAsset: libraryFiles(),
        critique: (s, w) => evaluateWorld(s, w, EVAL_SETTINGS).findings,
        settings: EVAL_SETTINGS,
      });
      if (result.turned.length === 0) {
        console.log(`${city.name} / ${place.name}: all facing right`);
        continue;
      }
      const sceneRef = await store.put(encodeJson(result.scene), "application/json");
      await systemRecordArtifacts(db, [sceneRef]);
      const rev: PlaceRevision = {
        placeId: pinned.placeId as PlaceRevision["placeId"],
        parent: pinned.revision as ArtifactHash,
        base: sceneRef,
        edits: [],
        scene: sceneRef,
        world: { spec: ref(pinned.spec), approved: false },
        authorId: world.ownerId as UserId,
        message: "Turned seats to face the way they're used",
        createdAt: new Date().toISOString(),
      };
      await commitAndPin(
        db,
        { worldId, key: place.key, ownerId: world.ownerId as UserId },
        rev,
        result.scene,
      );
      for (const t of result.turned) {
        console.log(`${city.name} / ${place.name}: turned ${t.thing} ${t.turnDeg}° (${t.why})`);
      }
    }
  }
} finally {
  await close();
}
