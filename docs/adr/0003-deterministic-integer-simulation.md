# 0003 — Deterministic, integer, fixed-tick simulation

**Status:** accepted · 2026-10-26

**Decision:** The sim uses one-second ticks and integer state (mm, permille × 3600, minor
units, grid cells). Randomness comes only from seeded SFC32 streams, one per subsystem.
Transcendental `Math` functions are banned, and trig comes from a committed integer table.
State is stored as struct-of-arrays typed arrays. `Sim.hash()` covers the sim's state (not yet people's planned paths and speeds). Places
run on the server (the realm, ADR 0014); the city-life sim runs in a Web Worker in the browser.

**Why:** IEEE `+ - * / sqrt` are exactly specified in JS, but `sin`/`cos`/`pow` are not, and
neither is anything involving clocks or `Math.random`. Integer state makes replays, saves,
lockstep multiplayer and tamper detection possible. (The realm is authoritative rather than
lockstep, and doesn't yet persist the log that replays need.)

**Alternatives:** an ECS library (bitECS, Koota). Deferred: at current entity counts plain SoA
arrays are simpler and fully under our control. Revisit when component variety grows.
