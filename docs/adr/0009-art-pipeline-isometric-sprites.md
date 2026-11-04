# 0009 — Art: isometric sprites from one pipeline, held to an art bible

**Status:** superseded by ADR 0013 (looks are shapes in the world spec; the sprite pipeline was removed) · 2026-10-27

**Decision:** Ayé's art is 2.5D isometric sprites under a fixed camera: 2:1 dimetric (azimuth
45°, elevation 30°), turned in quarter turns, with four facings per object. Every piece of art
comes through one function, `generateSpriteSet`, whether it is a captured object redrawn from
its redacted video crop or a catalog **archetype**. Archetypes form an **asset pack** per
world style, and they are the fallback when an object has no art of its own. There is no
hand-coded art path.

**The art bible is a contract, enforced in code:**
- `StyleGuide.art`: projection, pixels per metre (one scale for all art), light azimuth,
  palette (the darkest colour is reserved for ink outlines), and outline style.
- `spriteFrame(size, facing, ppm)` computes the exact canvas and ground anchor from the
  object's **real measured size**. Generators paint into that frame, so scale and alignment
  are guaranteed by geometry.
- `checkSprite` decodes the PNG (hardened decoder) and rejects the wrong canvas, opaque margins
  or art that doesn't fill its footprint. Rejected art is never cached. The object falls back
  to its archetype, and the compile still succeeds.
- Facings 1–3 are generated with facing 0 as their reference, keeping one look all round.
  Each facing is a memoised stage.

**Rendering:** the three.js camera is the art bible's camera (tests check pixel agreement in
all four rotations). Objects are upright billboards stretched by 1/cos 30°. Each sprite writes
the depth of its object's real box (a ray–box test in the shader), so occlusion against walls,
people and other objects is per-pixel correct with no sorting. Sun light comes from the art
bible's direction. The fallback order is: own sprite → archetype → massing box.

**Until an image model is connected:** the fake Stylizer paints the object's true volume in the
house palette and light. These placeholders pass every check and travel the whole path
(stages → checks → content-addressed storage → renderer), so swapping in Muse Image changes
only the provider.

**Why not 3D meshes or camera-facing cards:** image models are strongest at 2D art and the
isometric look is the most painterly. Cards look like cut-outs, and generated meshes are
heavier and harder to keep on-style. The simulation stays fully 3D, so true 3D can be added
later as another representation of the same objects.

**Known limits:** objects at non-right-angle yaw show the nearest facing. Each object is one
draw call (atlas later). People are still capsules until character sprites exist.
