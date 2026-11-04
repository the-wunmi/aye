# 0020 — Real cities: real roads, true scale, a queue model of traffic

**Status:** accepted · 2026-11-01 · builds on 0014 (cities) and 0018 (city life)

**Context:** city life (0018) played on 20–40 roads a model sketched on a 4 km square: a
plausible picture, useless for anyone asking how a real city moves. The aim reaches past a
game, towards a tool a planner could use: real streets, real distances, traffic that queues
and clears the way real traffic does.

**Decision:**

1. **Real places are grounded.** A memoised stage (`groundCity`) asks a model whether the
   city is a real place and where it, its places and its districts really are (lat/lon;
   anything over 30 km from the centre is dropped). It fetches OpenStreetMap's main roads
   (motorway to tertiary, the strategic network) for the box around them from the Overpass
   API, stored as fetched: the map is frozen at its first fetch, so replays are byte for
   byte and nobody's servers are asked twice. Code builds a `RoadNetwork` (junction-to-
   junction links with lanes each way, speed limits and one-ways from the tags, class
   defaults otherwise; only the largest strongly connected part, so every junction can reach
   every other the legal way round one-way streets), puts each place where it really
   is, and draws districts as the regions nearest their real centres. Sketched roads, water
   and scenery go; the city spec gains `real` (origin, extent, network artifact).
2. **The network is its own artifact,** linked to the world so its players can read it, and
   validated again on the client (`RoadNetwork`, `networkIssues`).
3. **The city sim plays on it** (`CitySim` with `layout.network`): one-way streets only run
   forwards; each link has its own free speed; routes are fastest at free flow (Dijkstra
   with a binary heap and index-ordered ties), with one tree into and one out of each place
   so a day of a 5,000-link city plays in ~150 ms.
4. **Traffic is a queue model** (as MATSim's): people cross a link at its free speed (or
   their mode's, if slower), leave its far end at most at its flow capacity (1,800
   vehicles an hour a lane) and only into room on the next link, else wait and the link
   fills behind them; anyone stuck 10 minutes squeezes on, so rings of full links can't
   lock forever. Density is judged over at least 200 m of road: one sampled agent stands
   for several people spread along a road, not stacked on a 20 m stretch between junctions.
5. **What covers the ground.** A second frozen fetch (`osm-land`, its own stage version)
   brings OpenStreetMap's water and land use for the same box, built into a `LandCover`
   artifact (`buildLand`): the sea closed from its coastline (water on the coast's right),
   lagoons and rivers with their islands as holes, and land use grouped as built-up,
   industrial and green (OpenStreetMap's own vocabulary, for drawing only). Small areas and
   fine detail are dropped (under 1 ha; 10 m); everything is bounded. A city without it still
   works: just its roads on plain ground.
6. **Ferries and railways are their own networks.** The locator also says which network
   each way to get around travels on (`TravelModeDef.way`: road, water or rail). If any uses
   water or rail, a third frozen fetch (`osm-lines`) brings ferry routes and passenger
   railways with their stations (`addLines`): a ferry is a link between its terminals, a
   railway is split at its stations (snapped on from up to 300 m beside the track) and
   junctions, and each terminal and station is joined to the nearest road junction (within
   2 km) by an access link. Lines that reach no road are left out. In the sim, road traffic
   never uses a line or an access link; a line's riders ride their own lines at line speed,
   and reach the stops along the roads (at 12 km/h when this was written; at their `reach`
   mover's speed since ADR 0022), taking no road room. Nobody lives at, or is sent to, a terminal or a station. Line capacity and
   timetables aren't modelled (a rider boards at once).
7. **Licence:** OpenStreetMap data is © OpenStreetMap contributors under the ODbL. The map
   shows the credit wherever the roads are drawn; a network derived from it (our artifact)
   is under the ODbL too.

8. **Real demand at real scale** (model estimates). For a real city the populate stage asks
   for real numbers (Lagos: 15.35 million) and lets routines go to districts (work, school)
   as well as the game's places; each agent gets its own spot (one of 32 hubs per district,
   or one of the junctions within 600 m of a place), so millions don't converge on one
   junction. The locator also says how many people a vehicle of each mode carries there
   (danfo 14, okada 2, on foot 0); a traveller takes their share of a vehicle's road room.
9. **Congestion-aware routing.** Every 15 city minutes routes are rebuilt by the roads as
   they are (free-flow time × (1 + 3·(load/capacity)²)), so later travellers go around jams
   (routes still being travelled are kept, packed). Someone stuck 10 minutes squeezes on,
   but never past twice what a road holds.
10. **Sampled agents in a Web Worker:** a real city plays 20,000 agents (Lagos: 1 per 768
    people), a sketched one 3,000; the sim runs off the main thread, catching up from
    midnight in a few seconds. Results agree between 20,000 and 60,000 agents; 3,000 is too
    coarse for a city of millions.

**Consequences:**

- The roads are real; the demand is not. Who lives where, what they do and how they travel
  are a model's estimate: no travel survey, no counts to calibrate against. With Lagos's
  estimated demand the strategic network saturates from 08:00 (a few percent of road
  travellers moving), surely worse than reality, which also has the local streets this
  network leaves out, people who don't travel daily, and more walking. The UI says so.
- Next for planning-grade: calibration against observed counts or travel times where a
  planner has them; local streets for short trips; line timetables and capacity. Scenarios:
  ADR 0021.
- Residential streets aren't in the network (city-scale traffic runs on the strategic one).
