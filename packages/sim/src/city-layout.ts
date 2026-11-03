/**
 * A city as its life sim reads it: its districts, places, roads and movers, from the city's
 * trait views, and a real city's road network. One function, so city life on the map, the
 * planner and the director all play exactly the same city.
 */
import { type CitySpec, viewsOf } from "@aye/schema";
import type { CityLayout } from "./city-sim.ts";

export function cityLayoutOf(
  city: CitySpec,
  network: CityLayout["network"] | null = null,
): CityLayout {
  const v = viewsOf(city);
  return {
    districts: v.districts.map((d) => ({ key: d.key, polygon: d.polygon })),
    places: v.places.map((p) => ({ key: p.key, at: p.at })),
    roads: v.lines.map((l) => ({ points: l.points, widthM: l.widthM })),
    movers: v.movers.map((m) => ({
      key: m.key,
      speedKmh: m.speedKmh,
      holds: m.holds,
      way: m.way,
      reach: m.reach,
    })),
    ...(network ? { network } : {}),
  };
}
