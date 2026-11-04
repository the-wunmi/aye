# 0019 — Ownership: whose things are, and riding your own between places

**Status:** accepted · 2026-11-01 · builds on 0013 (worlds), 0014 (realm), 0018 (city life)

**Context:** worlds had cars, motorbikes and bicycles that anyone could drive off in, and
driving one "out" only took the person out of the place for a while: it never took them
anywhere in the city. Real life has owners, and people get around in what's theirs.

**Decision:**

1. **The world says whose a thing is.** `ThingDef.owner` names one of the place's people,
   written by the model ("the Corolla is Tolu's"); code drops owners who aren't people of the
   place and says so. In someone's own home (a private place), things nobody else owns are
   theirs (`SimInit.keeper`). Ownership is static, from the spec, so it isn't sim state.
2. **Only an owner takes a thing away.** The sim refuses anyone else a free action that leaves
   with the thing (`not_yours`; one with a cost is a fare, open to anyone); anyone may still use it in place (sit in the car, start the
   generator). Holding a person the world wrote acts as them, so it carries their ownership.
3. **The world says what carries people between places.** `KindDef.travel.speedKmh`
   (bounded by `WORLD_BOUNDS.travelKmh`), only on kinds with an action that goes out with the
   thing. On the map, the player's own vehicle is a way to travel: free, at its speed (the
   `drive` intent; the server picks the vehicle, never the client).
4. **It goes with them, and comes home with them.** Leaving is an intent like any other:
   `depart` may carry `taking` (the sim checks it's theirs, here and free), and the thing is
   out until its owner arrives back (no new sim state: away-until is already hashed, and
   ownership is static). The character remembers it's out with them (`Character.vehicle`),
   so they can keep going in it from anywhere, and arriving home clears it.

**Consequences:**

- Worlds written before this have no owners and no travel speeds. New worlds and revisions
  (asking for something, which rewrites a kind) get them; nothing is backfilled by code.
- A vehicle out with someone isn't drawn where they are (there is no parking yet); it is
  simply not at home.
- City life (0018) still moves its population by the city's travel modes; car ownership
  rates per group are a planning input still to come.
