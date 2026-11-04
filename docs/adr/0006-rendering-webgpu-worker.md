# 0006 — three.js WebGPU renderer, simulation in a worker

**Status:** accepted · 2026-10-26 · the place sim's worker superseded by 0014: places run on the
server and clients interpolate its snapshots; only the city-life sim runs in a Web Worker. Nothing
uses a SharedArrayBuffer yet

**Decision:** `three/webgpu` (`WebGPURenderer`, automatic WebGL2 fallback) driven
imperatively, not through a React reconciler. React only renders the UI chrome. The sim runs in
a module Web Worker at a fixed tick and posts compact typed-array frames (~30 Hz,
transferred). The renderer interpolates. Static geometry is merged, and objects and agents are
instanced (about five draw calls per scene). three.js and React ship as separate long-cached
chunks. COOP/COEP are set so a SharedArrayBuffer channel can replace `postMessage` later.

**Why:** WebGPU is the best-performing web graphics API and three.js has the largest ecosystem.
Keeping simulation off the main thread keeps input and rendering smooth at any sim speed.
