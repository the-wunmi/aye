/**
 * Plays one simulated day of a city's traffic and prints it hour by hour (dev only, reads
 * only): how many are out, on the roads, how fast they're moving. A real city should rise
 * and fall with its day, never lock solid.
 *
 *   node --env-file=../../.env scripts/city-day.ts <worldId> [agents]
 */
import { fileURLToPath } from "node:url";
import { FsArtifactStore } from "@aye/artifacts/node";
import { connect, systemGetWorld } from "@aye/db";
import { readJson } from "@aye/pipeline";
import { type ArtifactHash, CitySpec, RoadNetwork, WorldId } from "@aye/schema";
import { CitySim, cityLayoutOf } from "@aye/sim";

const { db, close } = connect(process.env["DATABASE_URL"] as string, { max: 2 });
const store = new FsArtifactStore(
  fileURLToPath(new URL("../../../.aye/artifacts", import.meta.url)),
);
const ref = (h: string) => ({ hash: h as ArtifactHash, mediaType: "application/json", bytes: 0 });

try {
  const worldId = WorldId.parse(process.argv[2]);
  const agents = Number(process.argv[3] ?? 20_000);
  const world = await systemGetWorld(db, worldId);
  if (!world?.city) throw new Error("no such city");
  const city = CitySpec.parse(await readJson(store, ref(world.city)));
  const network = city.real
    ? RoadNetwork.parse(await readJson(store, ref(city.real.network)))
    : null;
  const sim = new CitySim(cityLayoutOf(city, network), city.population, 7, { maxAgents: agents });
  console.log(`agents ${sim.agents}, each stands for ${sim.scale}`);
  for (let hour = 1; hour <= 24; hour++) {
    sim.runTo(hour * 60 - 1);
    const s = sim.stats();
    console.log(
      `${String(hour - 1).padStart(2)}:59 out ${String(s.travelling).padStart(9)} roads ${String(s.onRoads).padStart(9)} speed ${String(Math.round(s.flowPermille / 10)).padStart(3)}%`,
    );
  }
  const r = sim.report();
  console.log(JSON.stringify(r).slice(0, 300));
} finally {
  await close();
}
