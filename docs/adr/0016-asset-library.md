# 0016 — A curated asset library that models choose from

**Status:** accepted · 2026-11-01 · amends 0013 (no model library) and 0015 (looks only from
primitives); revisits the library of 0010

**Context:** primitives (ADR 0015) made every look model-written and safe, but they top out
at a toy look: people of boxes, rooms of coloured blocks. The feel we want
uses real meshes, textured floors and rigged, animated people. No model we can call generates
game-ready 3D (checked 2026-11-01, `docs/research/3d-generation.md`); hosted image-to-3D is a
later phase. Meanwhile there is a large body of openly licensed (CC0) models and textures.

**Decision:**

1. **A library, curated by code, chosen by models.** `packages/engine/scripts/fetch-library.ts` fetches CC0 models
   (Poly Haven, Quaternius, KayKit), rigged outfits (Quaternius) with shared animations, and
   surface textures (Poly Haven); packs each into one file, pins it by SHA-256, measures it,
   and writes the committed catalog (`packages/schema/src/library-catalog.ts`). Files are
   fetched (`pnpm library:fetch`), not committed, except the shared animations
   (`apps/web/public/library/outfits/animations.glb`), whose source often refuses downloads. Labels and tags say what an entry _looks
   like_; nothing says what anything in a world _is_ or _does_.
2. **Furnishing is a stage.** After a world is written (and again when it's dressed), a model
   chooses by id: a model per kind of thing, an outfit per person, a surface per floor and
   for the walls; for a city, the outfits new arrivals pick from. Constrained decoding limits
   answers to catalog ids; code re-checks every id and its category, never overwrites an
   earlier choice, and changes only looks. It is memoised like every stage (inputs include
   the catalog), and it never blocks a build: on failure, things stay primitives.
3. **Specs carry ids, never files.** `KindDef.asset`, `PersonDef.outfit`,
   `ground[].surface`, `walls.surface`, `CitySpec.outfits`: all optional, all `AssetId`
   (`^[a-z][a-z0-9_]{1,47}$`). Only the catalog maps an id to a path, and catalog paths are
   validated to stay inside the library.
4. **Primitives stay the source of truth for state.** A library model shows a thing as it
   starts; shapes that only appear in other states (an open door, a running generator's glow)
   still draw over it. Anything without a choice, or whose file is missing, is drawn from its
   primitives, so the game never depends on the library being there.
5. **Physics is unchanged.** Models are fitted into each thing's measured box (turned to match
   its footprint, scaled evenly across the floor); people keep their bodies' numbers. The
   simulation never sees the library.

**Consequences:**
- A city looks far more like a place: real furniture, tiled and cement floors, laterite and
  pavers outside, people in clothes who walk, run, work and sit.
- The vocabulary of looks is now partly a list code maintains. A thing nothing in the library
  fits (a danfo, an okada, a generator-powered barbing salon chair) is still drawn by models
  from primitives; growing the library is how that improves, until generated meshes arrive.
- Downloads: the fetch shrinks every file before pinning it: model textures to 512 px
  (JPEG unless they need alpha), geometry meshopt-compressed (three's bundled decoder reads
  it, so the game gains no dependency), surfaces re-encoded at 1k. The whole library went
  from 92 MB to 26 MB; a place typically loads 5–8 MB of it. The shrink is deterministic, so
  the pins still detect upstream changes. GPU-compressed textures (KTX2, which needs a
  native encoder) and level of detail are still to do.
- The look critic and designer still judge primitives; furnished things are not yet judged by
  a picture of the model itself.
