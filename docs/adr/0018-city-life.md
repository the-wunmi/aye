# 0018 — City life: a population on the roads

**Status:** accepted · 2026-11-01 · builds on 0014 (cities) and 0016 (furnishing); the traffic
model in point 2 was replaced by 0020's queues, for sketched cities too

**Context:** places were alive but the city between them was a still picture. The aim reaches
past a game: a city that lives like a real one, so people (eventually planners) can see how a
population uses it: who goes where, when, by what, and where the roads fill up.

**Decision:**

1. **A model writes the population** (`CitySpec.population`): 5–12 groups of people, each with
   a size, a home district and a weekday routine (time, place or home, travel mode). A
   memoised stage (`populateCity`) writes it for any city that lacks one; code resolves its
   names to the city's keys, bounds it (`POPULATION_BOUNDS`), puts each day in order, and
   sends unknown places, districts or modes back once to be fixed.
2. **Code plays it** (`CitySim`, `@aye/sim`): roads become a graph (split where they cross,
   joined where they nearly meet). Agents (one per person, or one standing for several in a big
   city: at most 3,000) keep personal habits of ±35 minutes, take the shortest road route, and
   move at their mode's speed. Vehicles slow as a road fills (Greenshields speed–density, jam
   density from lanes and length) and queue at junctions when a road is full; people on foot
   don't congest roads. One step is one city minute; integers throughout; one seeded stream;
   `hash()` over all state. A whole day for 3,000 agents takes about 60 ms.
3. **Everyone sees the same city**: the client runs it on the shared city clock from the same
   spec and seed (deterministic), interpolating between minutes. The map draws vehicles and
   people (instanced) and colours each road segment by load; a card shows people out, on the
   roads, average traffic speed and the busiest road.

**What it is not:** a calibrated model of a real city. The roads, population and routines are
a model's plausible invention; the traffic model is a standard, generic one with assumed
constants (8 m of lane per vehicle in a jam, 2 people per vehicle, a lane per 3 m of width).
The card says so. Planning-grade use needs real inputs (road geometry and capacities from
e.g. OpenStreetMap, census population, travel surveys) and calibration against measured
counts; the population and road graph are the seams where real data would plug in.

**Consequences:**
- Cities with sparse road networks jam: the city prompt now asks for a connected network of
  20–40 roads (main roads and streets). Older cities keep the roads they were drawn with.
- Bodies walk at their speed in _real_ time inside places (a step costs `ticksPerRealSecond`
  ticks), so people no longer race around at ten times walking pace while the clock runs fast.
