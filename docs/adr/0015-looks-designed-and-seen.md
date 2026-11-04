# 0015 — Looks are designed by models and checked by looking at them

**Status:** accepted · 2026-10-27 · builds on 0013 (worlds) and 0014 (cities)

**Context:** places and the city still looked like a demo: people were capsules, buildings were
coloured slabs, and nothing told a model that its "danfo" was a blue cone. A fixed code
vocabulary of hair styles or building types would have been a hardcoded world again. Looks
need to be as model-driven as rules are, and checked as rigorously.

**Decision:**

1. **Everything is built from primitives.** Box, rounded box, cylinder, sphere, hemisphere,
   cone, capsule, torus, wedge: geometry only, defined once (`@aye/schema` meshes) and drawn
   the same by the game and the pipeline. A shape can `glow` (lamps, screens, signs, flames),
   drawn unlit so it shines at night. Things' looks, buildings, scenery and people are all
   made of them; no look exists in code.
2. **People are a rig of model-designed parts.** A person's look is primitives tagged with the
   part they move with (body, head, two arms, two legs), in millimetres from the feet; colours
   may be slots (skin, top, bottom, hair, accent). The engine finds joints from each part's
   bounds and animates them. Cities design the looks new players choose from.
3. **The harness looks.** A deterministic software rasteriser draws looks into numbered
   contact sheets. A vision model (the critic) scores each tile against what it should be and
   says what to fix in terms of primitives. Weak looks go to a designer model with a picture of
   themselves, the frame they're drawn in and the notes, and come back whole; they are judged
   again, up to three times, keeping each look's best version. This _dressing_ phase runs after
   a city or place works (`dressCity`, `dressWorld`) and only ever changes looks. Every
   critique and redesign is a memoised stage.
4. **Buildings are drawn chunkier than life** (`mapBlock`), like a city-builder board, in both
   the game and the critic's sheets.

**Consequences:**
- Look quality now improves with the critic's eye rather than with code. In the first live
  run, dressing lifted a city's looks from 2–6/10 to mostly 8–9/10 in about six minutes.
- Building a city costs more model calls (critiques in batches of 16, a redesign per weak look
  per round); places build in parallel and everything replays from cache.
- The critic is a model too: its standards live in a prompt, and the pass score (8) and
  rounds (3) are knobs in `refineLooks`.
