# Research: real 3D for Ayé (generated meshes, GPU cost, Muse Wonder)

**Status:** exploration, not a decision · 2026-11-01 · a dated snapshot: the library of Phase 1
shipped as ADR 0016, and the prices and links below haven't been rechecked since

Ayé draws everything from model-written primitives (ADR 0015). That is safe and reproducible
but tops out at a toy look; the feel we want uses real meshes, textures and
rigged characters. Phase 1 adds a curated CC0 asset library the model chooses from. This note
records what was checked online about the next steps: generating 3D from a recording, what it
costs, who could host it, and whether Muse Wonder's "3D game from images" can help without a
model writing code.

Figures marked **(est.)** are our own arithmetic or estimates; everything else is from the
sources at the end, checked 2026-11-01. Third-party price aggregators disagreed; confirm on the
vendor's own pricing page before committing.

## 1. What Meta's Model API offers (no 3D)

From Meta's model page [1]:

| Model                             | Kind                        | Price                                       |
| --------------------------------- | --------------------------- | ------------------------------------------- |
| `muse-wonder-1.0`                 | frontier text/agent model   | $4.00 in · $20.00 out per M tokens          |
| `muse-spark-1.3` / `-contributor` | text + vision (what we use) | $1.25 / $4.25 (contributor $0.10 / $0.20)   |
| `muse-image-1.0`                  | image generate + edit       | $0.01 / image                               |
| `sam-3-1`                         | segmentation                | $2.50 / 1k images · $0.20 / 1k video frames |
| `muse-voice-transcribe-1.0`       | speech to text              | $0.18 / hour                                |
- **No hosted 3D model.** SAM 3D is not on the Model API.
- **Muse Image** [2]: `POST /v1/images/generations` and `/v1/images/edits` (multi-image
  compose), OpenAI-compatible, up to 1600 px. Meta notes calls are non-deterministic and
  "exact text rendering varies", so signs should be lettered by code with Muse Image doing
  the backgrounds. Non-determinism is fine for us: every result is a memoised artifact.

## 2. Generating 3D: the candidates

| Model                         | Output                                                                  | Hardware                   | Speed                                       | Licence                                                      |
| ----------------------------- | ----------------------------------------------------------------------- | -------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| **TRELLIS.2** (Microsoft) [3] | textured PBR **mesh**, 1 image                                          | NVIDIA, ~24 GB+ (disputed) | H100: 3 s @512³ · 17 s @1024³ · 60 s @1536³ | MIT                                                          |
| **SAM 3D Objects** (Meta) [4] | image + mask → **Gaussian splat** (`.ply`); mesh not clearly documented | Linux, NVIDIA **≥ 32 GB**  | not stated                                  | SAM License (commercial use not mentioned; needs legal read) |
| **SAM 3D Body** (Meta) [5]    | human mesh (Meta's MHR rig)                                             | not stated                 | not stated                                  | SAM License                                                  |
| Hunyuan3D (Tencent) [6]       | textured mesh                                                           | ~24 GB+                    | not stated                                  | more restrictive                                             |
| Meshy / Tripo / Rodin [7]     | hosted image → mesh APIs                                                | none (paid API)            | ~10 s (Tripo) to 2–3 min (Rodin)            | per vendor; Tripo free tier non-commercial                   |

SAM 3D Objects is also offered hosted by third parties (Runware, Scenario, Segmind) [8].

**Fit for Ayé:** TRELLIS.2 is the best self-hosted candidate: it outputs the mesh format a game
uses, it is MIT licensed, and it is fast. SAM 3D Objects pairs naturally with our SAM 3.1
masks but its documented output is a splat, which would need converting, and its licence needs
review. Either way the pipeline would be:

```
keyframe ─ SAM 3.1 mask ─ crop ─ Muse Image restyle (shared style reference)
         ─ image→3D (GPU) ─ clean up in code: decimate, scale to measured size, KTX2 ─ GLB artifact
```

Restyling the crop before 3D keeps every object in one art style (the brief's "anchored to a
shared style reference"). Physics still uses the scene's measured boxes; the mesh is only a look.

## 3. Cost of running it ourselves

GPU rates, per hour (aggregators quoting the vendor pages; confirm before committing):

| Host           | H100   | A100 80 GB | L40S   | Billing                      |
| -------------- | ------ | ---------- | ------ | ---------------------------- |
| Modal [9]      | ~$3.95 | ~$2.50     | ~$1.95 | per second, scale to zero    |
| Baseten [10]   | ~$6.50 | ~$4.00     | n/a    | per minute of active compute |
| Fireworks [11] | ~$6–7  | ~$2.90     | n/a    | per GPU-second               |

Per object with TRELLIS.2 on a Modal H100 (~$0.0011/s) **(est.)**:

| Quality | GPU time | GPU cost | With overhead (load, clean-up) |
| ------- | -------- | -------- | ------------------------------ |
| 512³    | 3 s      | ~$0.003  | ~$0.01                         |
| 1024³   | 17 s     | ~$0.02   | ~$0.03–0.04                    |
| 1536³   | 60 s     | ~$0.07   | ~$0.08–0.10                    |

Scaled up **(est.)**, assuming ~30 objects per place, 10 places per city, at 1024³:

| Unit                   | Self-hosted (Modal H100) | Paid API (~$0.20–0.50/object) |
| ---------------------- | ------------------------ | ----------------------------- |
| One place (30 objects) | ~$1                      | $6–15                         |
| One city (300 objects) | ~$10                     | $60–150                       |
| 1,000 recorded places  | ~$1,000                  | $6,000–15,000                 |

Plus Muse Image restyles at $0.01 each (~$3 per city) and SAM 3.1 (negligible).

**What drives the bill is idle time, not the per-object cost.** Scale-to-zero costs nothing idle
but each cold start loads a 4B-parameter model (likely tens of seconds to a minute or two
**(est.)**, to be measured). Keeping one H100 warm around the clock costs ~$3.95 × 720 ≈
**$2,850/month (est.)**. Practical shape: scale to zero while volumes are low, keep one GPU warm
only when "near real time" matters, and batch a place's objects onto one warm container.

**Latency for "near real time" (est.):** 30 objects at 17 s each is ~8.5 min on one GPU, or
~1 min across 10 parallel GPUs at the same total cost (per-second billing). At 512³ it is ~1.5
min on one GPU. So the place appears at once with library stand-ins, and its own objects swap
in over a minute or two.

**Size (est., to be measured):** raw generator output is heavy. After code clean-up (about
10–20k triangles, a 1024² KTX2 texture), expect roughly 0.5–2 MB per object GLB, so 15–60 MB
per place before reuse. That needs streaming (nearest first), LODs, and keeping only the
cleaned GLB plus the source crop in the artifact store, not the raw output. Phones are the
binding constraint, not storage.

## 4. Managed hosts: which help

- **Modal: best fit.** It runs any container (Python + CUDA), bills per second, scales to zero,
  and has sandboxes (relevant to §5). TRELLIS.2 and SAM 3D both deploy as plain functions. $100
  of credit is ~25 H100-hours, roughly 5,000 objects at 1024³ **(est.)**.
- **Baseten: works, costs more.** Custom models deploy through Truss (`model.py` with load and
  predict) [10]. Good production autoscaling, about 1.6× Modal's H100 rate.
- **Fireworks: not for 3D.** It is built around LLM serving; deploying a non-LLM image→3D
  model is not documented [11]. Useful only if we later serve Meta's open-weight LLMs (Muse
  Spark Open, Muse Glimmer) ourselves.
- **The $100 credits** (Baseten, Modal, Fireworks) are described as being _for Meta's
  open-weights models_. SAM 3D (Meta, open weights) likely qualifies; TRELLIS.2 (Microsoft)
  may not. Terms not found online; check with the program.

Privacy: AGENTS.md keeps raw-media providers on our infrastructure. A GPU host running our own
container on our account is close to that, but sending object crops off our servers still needs
ADR 0012 amended, and only redacted crops (never faces or plates) may go.

## 5. Muse Wonder and "3D from images" without a model writing code

**What's known.** Meta says Muse Wonder "builds a playable 3D kitchen game from customizable image
inputs" [12]. It does this by writing game code (three.js-style), not by producing 3D assets;
Meta has not published how. Hands-on reviews are mixed: a consistent Rubik's cube, but
flickering, clipping and bad shadows in three.js scenes, and Meta's Alexandr Wang said they
"did not explicitly train our model on 3d demo games" [13]. Ayé's invariant is that a model
never writes code that runs, so we can't use it as shown.

**Ways to build on it without breaking that rule:**

1. **A richer look language, still data (recommended to explore first).** The model writes
   descriptions our code turns into geometry, as with primitives today, but with more
   expressive pieces:
   - _profiles_: a 2D outline lathed (bottles, pots, lamp bases, columns) or extruded (sofa
     arms, counters, window frames, signboards);
   - _repeats_: arrays and grids (pews, shelves of goods, tiles, railings) drawn instanced;
   - _materials_: PBR parameters (roughness, metalness) and textures from Muse Image (wood,
     tiles, ankara, painted walls), mapped by code;
   - _decals_: posters, signs and labels, lettered by code;
   - _bevels and booleans_ for cut-outs (windows in walls, doors in cabinets).
     It stays bounded, hashable and safe, it works in the existing critic → designer loop, and
     Muse Wonder or Spark can be the author. It narrows the gap for furniture and buildings. It
     will not produce believable people or cars; the library or generated meshes cover those.
2. **Model-written code run only at build time, in a sandbox, kept as data.** The model writes
   a modelling script; it runs once in an isolated sandbox (e.g. Modal Sandboxes) with no
   network or secrets, CPU and time capped; only its output, a GLB, is kept, validated (size,
   triangle count, bounds) and memoised. No model code ever reaches a client or the sim.
   More expressive, but it amends the "a model never writes code" invariant in AGENTS.md, so
   it needs an ADR and a security review first.
3. **Muse Wonder as a better author/critic** for today's looks and worlds (it is a frontier
   agent model), measured against Spark on the existing live evals before switching; ~3× the
   input price of Spark 1.3.

**Next step for this track:** prototype option 1 with three additions (lathe, extrude, repeat)
plus Muse Image materials, and compare critic scores against today's primitives on the same
places.

## Open questions

- SAM 3D Objects: is there a supported mesh export, and is commercial use allowed under the SAM
  License?
- TRELLIS.2: actual VRAM and cold-start time on Modal; quality on restyled crops of real
  objects (sofas, generators, kiosks).
- Rigging generated characters: SAM 3D Body's MHR rig vs auto-riggers. Players stay on library
  bodies until this is proven.
- Terms of the $100 open-weights credit program.

## Sources

1. Meta Model API, models and pricing: https://dev.meta.ai/products/meta-model-api/
2. Build with Muse Image (Meta, 2026-08-25): https://dev.meta.ai/resources/blog/build-with-muse-Image
3. TRELLIS.2 project page: https://microsoft.github.io/TRELLIS.2
4. SAM 3D Objects: https://github.com/facebookresearch/sam-3d-objects (setup: `doc/setup.md`)
5. SAM 3D / Body: https://github.com/facebookresearch/sam3d · https://huggingface.co/facebook/sam-3d-body-dinov3
6. Hunyuan3D overview: https://trellis2.app/hunyuan-3d
7. Hosted 3D API comparisons: https://picoberry.ai/ai-3d-generator-pricing-comparison · https://www.3daistudio.com/blog/best-3d-model-generation-apis-2026
8. SAM 3D Objects hosted by third parties: https://runware.ai/docs/models/meta-sam-3d-objects · https://docs.scenario.com/get-started/generation/3d-model-generation/3d-model-generation-meta · https://www.segmind.com/models/sam-3d-objects
9. Modal per-second GPU rates (aggregator): https://www.spheron.network/blog/modal-gpu-pricing-2026-per-second-billing/
10. Baseten rates and Truss: https://www.morphllm.com/baseten-pricing · https://docs.baseten.co/development/model/custom-model-code
11. Fireworks rates and custom models: https://www.morphllm.com/fireworks-ai-pricing · https://docs.fireworks.ai/guides/ondemand-deployments
12. Muse Wonder (Meta): https://research.meta.ai/blog/muse-wonder · https://about.fb.com/news/2026/10/introducing-muse-wonder-models/
13. Muse Wonder reviews: https://4sysops.com/archives/meta-muse-wonder-review/ · https://venturebeat.com/technology/metas-new-muse-wonder-and-muse-wonder-full-models-achieve-frontier-performance-but-only-the-weaker-one-is-available-via-api
