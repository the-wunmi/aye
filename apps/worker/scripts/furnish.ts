/**
 * Furnish and decorate a city's places now, without waiting for its dressing pass:
 * for each pinned place, choose library models, outfits and surfaces, dress the set with more
 * library things (placed by physics, checked by a replay), and pin the result as the place's
 * next revision. Rooms in play pick it up within seconds. Choices are memoised stages, so the
 * dressing pass later reuses them with no new model calls.
 *
 * A trusted dev tool (it uses system* functions): it acts only on a world id you pass.
 * Usage: node --env-file=../../.env scripts/furnish.ts <worldId>
 */

import { fileURLToPath } from "node:url";
import { encodeJson } from "@aye/artifacts";
import { FsArtifactStore } from "@aye/artifacts/node";
import {
  connect,
  PgRecipeIndex,
  systemGetPinnedPlace,
  systemGetWorld,
  systemLinkWorldArtifacts,
  systemRecordArtifacts,
  systemSetWorld,
} from "@aye/db";
import {
  decoratePlace,
  furnishCity,
  furnishWorld,
  museConfigFrom,
  museFurnisher,
  populateCity,
  readJson,
} from "@aye/pipeline";
import {
  type ArtifactHash,
  CitySpec,
  LIBRARY_CATALOG,
  type PlaceRevision,
  panelsOf,
  placesOf,
  Scene,
  type UserId,
  WorldId,
  WorldSpec,
} from "@aye/schema";
import { evaluateWorld } from "@aye/sim";
import { z } from "zod";
import { EVAL_SETTINGS } from "../src/compile-job.ts";
import { commitAndPin } from "../src/pin.ts";

const worldId = WorldId.parse(process.argv[2]);
const env = z
  .object({
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    AYE_ARTIFACT_DIR: z
      .string()
      .min(1)
      .default(fileURLToPath(new URL("../../../.aye/artifacts", import.meta.url))),
  })
  .parse(process.env);
const { db, close } = connect(env.DATABASE_URL, { max: 2 });
const store = new FsArtifactStore(env.AYE_ARTIFACT_DIR);
const index = new PgRecipeIndex(db);
const furnisher = museFurnisher({ ...museConfigFrom(process.env), effort: "low" });
const ref = (hash: string) => ({
  hash: hash as ArtifactHash,
  mediaType: "application/json",
  bytes: 0,
});

try {
  const world = await systemGetWorld(db, worldId);
  if (!world?.city) throw new Error("no such city");
  let city = CitySpec.parse(await readJson(store, ref(world.city)));
  // The city first: its outfits, its buildings on the map and its scenery.
  const outfitted = await furnishCity(city, {
    furnisher,
    store,
    index,
    catalog: LIBRARY_CATALOG,
  });
  const peopled = await populateCity(outfitted.spec, { furnisher, store, index });
  if (peopled.issues.length > 0) console.log(`population: ${peopled.issues.join("; ")}`);
  if (outfitted.chosen > 0 || peopled.spec !== outfitted.spec) {
    city = peopled.spec;
    const cityRef = await store.put(encodeJson(city), "application/json");
    await systemRecordArtifacts(db, [cityRef]);
    await systemLinkWorldArtifacts(db, worldId, [cityRef.hash]);
    await systemSetWorld(db, worldId, { city: cityRef.hash });
    console.log(
      `${city.name}: ${outfitted.chosen} choices for the map and outfits; ${city.population.groups.length} groups of people`,
    );
  }
  for (const place of placesOf(city)) {
    const pinned = await systemGetPinnedPlace(db, worldId, place.key);
    if (!pinned?.spec) continue;
    const scene = Scene.parse(await readJson(store, ref(pinned.scene)));
    const spec = WorldSpec.parse(await readJson(store, ref(pinned.spec)));
    const looks = await furnishWorld(spec, scene, {
      furnisher,
      store,
      index,
      catalog: LIBRARY_CATALOG,
      panels: panelsOf(city.ui),
    });
    const set = await decoratePlace(scene, looks.spec, {
      furnisher,
      store,
      index,
      catalog: LIBRARY_CATALOG,
      critique: (s, w) => evaluateWorld(s, w, EVAL_SETTINGS).findings,
      settings: EVAL_SETTINGS,
    });
    if (looks.chosen + set.added === 0) {
      console.log(`${place.name}: nothing new`);
      continue;
    }
    const specRef = await store.put(encodeJson(set.spec), "application/json");
    const sceneRef = await store.put(encodeJson(set.scene), "application/json");
    await systemRecordArtifacts(db, [specRef, sceneRef]);
    const rev: PlaceRevision = {
      placeId: pinned.placeId as PlaceRevision["placeId"],
      parent: pinned.revision as ArtifactHash,
      base: sceneRef,
      edits: [],
      scene: sceneRef,
      world: { spec: specRef, approved: false },
      authorId: world.ownerId as UserId,
      message: "Furnished and dressed from the asset library",
      createdAt: new Date().toISOString(),
    };
    const pinnedAt = await commitAndPin(
      db,
      { worldId, key: place.key, ownerId: world.ownerId as UserId },
      rev,
      set.scene,
    );
    if (!pinnedAt) {
      console.log(`${place.name}: couldn't save; left as it was`);
      continue;
    }
    console.log(`${place.name}: ${looks.chosen} choices, ${set.added} things added`);
  }
} finally {
  await close();
}
