# 0012 — Captures run on Meta's APIs; a place is a representation, not a survey

**Status:** accepted · 2026-10-27 · amends invariant 5 in AGENTS.md (privacy boundary); recording is opt-in since ADR 0013, and things are drawn from world specs and the asset library since 0013 and 0016, not procedural fixtures

**Context:** Ayé must work for any place someone films: a road, a market, a taxi rank, not
just a home. Copying the world exactly (metric 3D reconstruction, photoreal splats) needs our
own GPUs. The product needs a _representation_ people recognise, which hosted models can do.

**Decision:**

1. **The whole capture path uses hosted Meta models plus CPU work.**

   ```
   clip ─ ffmpeg keyframes (CPU) ─ SAM 3.1: faces, number plates ─ pixelate (CPU)
        ─ Muse Spark: map the place from redacted frames ─ assemble (code) ─ scene
        ─ Muse Spark: the world ─ play-test ─ revise
   ```

   Every model call is a memoised stage, as before. Objects are drawn from the model library
   or procedural fixtures, so captures need no generated art.
2. **Layout is estimated.** Muse maps metres from what it sees, using things of known size
   (lanes, cars, doors). A road may be 7 m wide when it is really 6.2 m. Code still owns ids,
   kinds and physics, so the result is internally consistent: people can't walk through a stall
   or climb a kerb in a wheelchair.
3. **Privacy boundary, amended.** Finding faces and number plates is SAM's job, so SAM sees
   unredacted keyframes, sent to Meta for that one call. Everything after it, including Muse and
   anything a player sees, gets only pixelated frames (`RedactedFrameSet` in the types). Private
   detections never become objects. Keyframes, not whole videos, leave our infrastructure.
4. **Places have a purpose.** Homes are play-tested as somewhere people live (every need, for
   days). Streets, markets and shops are tested as somewhere people visit (things to do, a few
   hours), so a road isn't marked broken for lacking a toilet.

**Demo:** `docs/demo-clips.json` lists ten openly licensed (CC BY / BY-SA) street clips from
Wikimedia Commons, from Lagos, Cotonou, rural Benin, Accra, Ljubljana, Tehran, Funchal, Dubai,
Bangkok and Shanghai, with their credits. The script that turned them into places no longer
exists, so the list is a record and nothing reads it now. Their footage was never committed.

**Consequences:**
- Contributor mode (`MUSE_TEXT_MODEL=*-contributor`) means Meta may train on what Muse sees,
  which for captures is redacted frames. Meta's docs describe Contributor variants for Muse
  only, so check SAM's data terms before sending real users' footage.
- Monocular estimates drift over long clips. 10–30 s segments are the sweet spot; longer
  places should be several captures joined by links.
- If precision ever matters more than representation (planning work), a GPU reconstruction
  stage can replace the layout estimate behind the same `Understander` port.
