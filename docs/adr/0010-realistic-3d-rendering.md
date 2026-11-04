# 0010: Realistic 3D rendering, with stand-in models until objects are reconstructed

**Status:** superseded by ADR 0013 (no model library or photoreal materials; things are drawn from their spec) · 2026-10-27

**Context:** The proof of concept has to _look like the place it came from_ and let people
rearrange it. Painted isometric volumes (ADR 0009) were correct and reproducible, but
they read as blocks, not as a home.

**Decision:**
- **Rendering.**
  - A perspective camera you can orbit, pan and zoom, opening from the entrance side.
  - Image-based lighting from a real HDRI, plus a warm sun casting soft shadows.
  - PBR floors and walls with UVs in metres.
  - Floor slabs at their real heights, so steps look like steps.
  - Walls between the camera and the room cut away, re-evaluated as the camera moves.
- **Objects.** In order of preference:
  1. The object's own reconstructed mesh (future: SAM 3D-style image-to-3D from the capture).
  2. A **stand-in** from the model library: photoreal CC0 models (Poly Haven), chosen by
     closest proportions to the object's _measured_ size and scaled with at most ±20%
     distortion per axis.
  3. A procedural fixture with physically based materials (fridge, toilet, basin, shower,
     bathtub, flat-screen TV, fan, split AC, water tank, bin).
  4. A massing box.
- **People.** Simple walking figures. Wheelchair users sit in a real wheelchair model.
- **Editing.**
  - Furniture is selected, dragged (5 cm snap) and turned (R).
  - The UI sends `EditOp`s. The worker validates and applies them and checks placement, then
    rebuilds the simulation with time, money, needs, randomness and positions carried across
    (`Sim.rebuild`, deterministic).
  - The worker sends back the authoritative scene and refreshes the accessibility report.

**The model library is fetched, not committed.** `scripts/fetch-library.ts` downloads it, checks
every file against the source's MD5s, only allows HTTPS from the source's domain, and keeps
relative paths inside the library. It records source and licence per asset. The manifest is
validated at load (`ModelLibrary`), so a bad path cannot point outside the library.

**What stays from ADR 0009:** sprite generation, the art checks and the content-addressed
asset packs remain in the pipeline. They will serve as catalog and buy-mode thumbnails and as
the input to image-to-3D reconstruction. The art bible (palette, light direction) still
governs generated art.

**Known limits:** people stand rather than sit or lie while acting, single level only, and no
windows in the sample scene. Edits are not yet in the persistent command log (the worker
applies them locally). The library is 65 MB at 1k textures, which needs compressed glTF and
KTX2 textures before production.
