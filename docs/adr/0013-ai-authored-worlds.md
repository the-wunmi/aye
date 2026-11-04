# 0013 — Worlds are written by a model, checked by code, played by a generic engine

**Status:** accepted · 2026-10-27 · supersedes 0004 (catalogs), 0009 and 0010 (art and model
library), 0011 (house rules); amends 0012 (recording is one source of two); amended by 0016 (a
library is back)

**Context:** the foundation still fixed the world's vocabulary in code: seven needs, four
utilities (with "NEPA" in the UI), postures, place and space kinds, a catalog of object kinds,
and a library mapping kinds to photoreal models, which is why every car wore a dust cover
(Poly Haven's only car is `covered_car`). Nothing could know that a covered car can be
uncovered, opened and driven. Ayé should be dynamic: an intelligent system writes the world,
and a harness makes it work.

**Decision:**

1. **The world is a spec a model writes.** `WorldSpec` holds the needs, resources, kinds of
   things (each with state vars, actions gated on and changing that state, resources it
   supplies, and a look made of simple shapes per state), the things (scene objects mapped to
   kinds, with starting state) and the people (name, look, body, money, needs). No needs,
   resources or kinds exist in code.
2. **The engine is a generic interpreter.** The sim compiles a spec to integer tables and runs
   it: conditions are comparisons on thing vars or resource availability; effects are need
   rates, state assignments (optionally timed), money, and leaving with the thing for a while.
   People choose for themselves, valuing actions by what they do and what they unlock (two state
   changes ahead), so a bored person uncovers the car, opens the door and drives off. It stays
   deterministic and hash-checked; physics (bodies, walls, placement) stays code.
3. **A harness makes it work.** author (model) → compile (code: keys from names, objects by
   index, clamps to `WORLD_BOUNDS`, every inconsistency reported in words) → play-test
   (`evaluateWorld`: things that can never happen, unsupplied resources, nobody doing anything,
   lived-in needs bottoming out) → revise (model, given every finding), up to three rounds,
   keeping the best. All memoised.
4. **Improvising on demand.** Asking a thing for something new rewrites its kind (new state,
   steps and looks), compiled and play-tested against the whole world, then picked up by the
   running sim without a restart.
5. **Looks are data.** Each kind's look is up to 20 coloured primitives relative to the
   thing's size, some shown only in certain states. The renderer draws them simply: a clear
   representation, not photorealism. The model library, HDRI and textures are gone.
6. **Words or a recording.** A place starts from a description (the model imagines a layout)
   or a recording (ADR 0012's capture path); both produce the same scene, and the model also
   judges the local currency.

**Consequences:**
- The spec format is now the contract to evolve carefully: adding an effect type touches
  schema, compiler, interpreter, evals and prompt (AGENTS.md, "Let worlds express something
  new").
- Bounds and evals carry the weight that hand-tuning used to. The live run found and closed
  one exploit: actions ended early when needs were met, so paid work finished in one tick and
  paid in full; now only purely need-driven actions can end early.
- Worlds vary between models and prompts by design; reproducibility comes from the recipe
  cache (a world replays byte for byte), and quality from the live evals in
  `packages/pipeline/test/muse.live.test.ts`.
