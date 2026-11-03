/**
 * Lay existing real cities on their real roads: the same `groundCity` new builds
 * run (a model locates the city and its places; OpenStreetMap's main roads for the box around
 * them, and its water and land use; code builds the network and moves the places). The network is stored, linked to the
 * world so its players can read it, and the city's new spec is set. A trusted dev tool: it
 * acts only on the worlds you pass.
 *
 * With --repopulate, also rewrites who lives there at the real city's size (trips to its
 * districts as well as its places), as new builds do.
 *
 * Usage: node --env-file=../../.env scripts/ground.ts [--repopulate] <worldId> [...]
 */
import { fileURLToPath } from "node:url";
import { encodeJson } from "@aye/artifacts";
import { FsArtifactStore } from "@aye/artifacts/node";
import {
  connect,
  PgRecipeIndex,
  systemGetWorld,
  systemLinkWorldArtifacts,
  systemRecordArtifacts,
  systemSetWorld,
} from "@aye/db";
import {
  groundCity,
  museConfigFrom,
  museFurnisher,
  museLocator,
  overpassSource,
  populateCity,
  readJson,
} from "@aye/pipeline";
import { type ArtifactHash, CitySpec, moversOf, WorldId } from "@aye/schema";

const { db, close } = connect(process.env["DATABASE_URL"] as string, { max: 2 });
const store = new FsArtifactStore(
  fileURLToPath(new URL("../../../.aye/artifacts", import.meta.url)),
);
const index = new PgRecipeIndex(db);
const ref = (h: string) => ({ hash: h as ArtifactHash, mediaType: "application/json", bytes: 0 });

try {
  const repopulate = process.argv.includes("--repopulate");
  // --again: ground a real city once more (new grounding: occupancy, positions), keeping who
  // lives there.
  const again = process.argv.includes("--again");
  for (const raw of process.argv.slice(2).filter((a) => !a.startsWith("--"))) {
    const worldId = WorldId.parse(raw);
    const world = await systemGetWorld(db, worldId);
    if (!world?.city) continue;
    const city = CitySpec.parse(await readJson(store, ref(world.city)));
    if (city.real && !again) {
      if (!repopulate) {
        console.log(`${city.name}: already on its real roads`);
        continue;
      }
      const peopled = await populateCity(
        { ...city, population: { groups: [] } },
        {
          furnisher: museFurnisher({ ...museConfigFrom(process.env), effort: "low" }),
          store,
          index,
        },
      );
      for (const issue of peopled.issues) console.log(`  ${issue}`);
      const specRef = await store.put(encodeJson(peopled.spec), "application/json");
      await systemRecordArtifacts(db, [specRef]);
      await systemLinkWorldArtifacts(db, worldId, [specRef.hash]);
      await systemSetWorld(db, worldId, { city: specRef.hash });
      const total = peopled.spec.population.groups.reduce((n, g) => n + g.count, 0);
      console.log(
        `${city.name}: ${total.toLocaleString()} people in ${peopled.spec.population.groups.length} groups`,
      );
      for (const g of peopled.spec.population.groups) {
        const zones = g.routine.filter((r) => r.district).length;
        console.log(`  ${g.name}: ${g.count.toLocaleString()} (${zones} district stops)`);
      }
      continue;
    }
    const t0 = Date.now();
    const g = await groundCity(city, {
      locator: museLocator(museConfigFrom(process.env)),
      maps: overpassSource(),
      store,
      index,
    });
    for (const issue of g.issues) console.log(`  ${issue}`);
    if (!g.networkRef || !g.network) {
      console.log(`${city.name}: stays sketched`);
      continue;
    }
    const specRef = await store.put(encodeJson(g.spec), "application/json");
    const refs = [specRef, g.networkRef, ...(g.landRef ? [g.landRef] : [])];
    await systemRecordArtifacts(db, refs);
    await systemLinkWorldArtifacts(
      db,
      worldId,
      refs.map((r) => r.hash),
    );
    await systemSetWorld(db, worldId, { city: specRef.hash });
    const n = g.network;
    const lineCounts = [6, 7, 8].map(
      (c) => n.links.filter((v, k) => k % 7 === 5 && v === c).length,
    );
    console.log(
      `  lines: ${lineCounts[0]} ferry, ${lineCounts[1]} rail, ${lineCounts[2]} access links; ways: ${moversOf(
        g.spec,
      )
        .map((m) => `${m.key}=${m.way}`)
        .join(", ")}`,
    );
    if (g.land) {
      console.log(`  land cover: ${g.land.kinds.length} rings, ${g.land.points.length / 2} points`);
    }
    console.log(
      `${city.name}: ${n.extentM[0] / 1000} × ${n.extentM[1] / 1000} km, ${n.nodes.length / 2} junctions, ${n.links.length / 7} links, ${n.names.length} street names (${((Date.now() - t0) / 1000).toFixed(0)} s)`,
    );
  }
} finally {
  await close();
}
