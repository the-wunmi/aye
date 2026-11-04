# 0021 — Planning scenarios: change the roads, compare a day

**Status:** accepted · 2026-11-01 · builds on 0018 (city life) and 0020 (real cities)

**Context:** a real city's life plays on its real roads (0020), and a planner wants to know
what a change would do before it is made: close a bridge for repairs, give a corridor
another lane, take one away for a bus lane. A single run says how busy the roads are. A
change only means something against the city without it.

**Decision:**

1. **A scenario is a list of road edits** by network link: closed, or a new number of lanes
   each way (1–8). `CitySim` takes it as `opts.scenario` when it is built. A closed link is
   left out of routing, and lanes scale what a road holds and lets out. Edits to links that
   don't exist, and lane counts out of range, are ignored.
2. **A comparison is two whole days** of the same city, people and seed, from midnight: one
   as it is, one with the scenario. Both are deterministic, so the difference is the roads'
   alone, and every machine gets the same numbers.
3. **What a day comes to** (`CityReport`, in people, not agents): trips made and the minutes
   they took, trips nobody could make, and people-minutes spent queuing (for room on a road,
   or for a road's exit). A trip with no way there is no longer made "off the roads at once":
   the traveller stays where they are, and the trip counts as impossible. Every counter is
   in `hash()`.
4. **Where it changed:** per link, how much fuller or emptier it was between 06:00 and 21:00
   (permille of what it holds), drawn over the map: the theme's bad colour for fuller, good
   for emptier, wider the bigger the change. Closed and edited roads are drawn on top.
5. **It is the player's own and runs in their browser:** the scenario lives in local storage
   per city (bounded to 200 edits, validated when read back), and the comparison runs in a
   Web Worker on the same sim as city life (Lagos: two days of 20,000 agents in about 7 s).
   Nothing is sent to the server or shown to anyone else.

**Consequences:**

- The comparison is only as good as the demand (0020): with Lagos's uncalibrated estimate the
  strategic network is saturated much of the day, so absolute numbers (two-hour trips) are
  not to be believed. Changes in where traffic goes are more telling than the totals.
- Scenarios can't yet add a road, change a speed limit, or add public transport lines; those
  are the next edits. Saving and sharing scenarios (a table, actor-scoped) can come when
  planners need to share them.
