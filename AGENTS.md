# AGENTS.md

Guidance for anyone, human or AI agent, changing this repository. Read this before writing code.
Deeper reasoning lives in `docs/architecture.md` and `docs/adr/`.

## What Ayé is

Ayé is a multiplayer life simulation of any city someone describes. A model designs the
**city** (the kinds of things it is made of and where they are, its places, travel and fares,
needs, economy, how newcomers start, and the game's own
interface: theme, HUD layout, apps and their panels), then every place in it is built. Players sign up,
make a character, and live in it together in real time; they can also take over the people
the world wrote. Each place starts from words or (opt-in) a phone recording. A model lays the
place out as a **scene** (ground, walls, openings, steps, things). The **world harness** then
has a model write the place's whole **world spec** as data: the needs its people have, the
resources there are, every kind of thing with its own state (a car `covered`, its `door_open`)
and the actions that read and change it (uncover → open → drive off), how each kind looks in
each state, and the people. Code checks it, plays it, and sends problems back until it works.
When someone tries something new ("can I wash this?"), the harness extends the world on
demand. A deterministic engine plays it all, inside physics that code owns (bodies, walls,
doors, solid things).

**Nothing about what a world contains is hardcoded.** No needs, utilities, object kinds,
looks, places, transport, apps or screens live in code. The one list code keeps is the
**asset library** (ADR 0016): CC0 models, outfits and textures, described by what they look
like, which models _choose_ from by id; it never says what anything is or does. If you are
about to write a world noun into code (`"power"`, `"car"`, `"jobs"`, `"danfo"`), stop: it
belongs in a spec a model writes. Code owns the vocabularies specs are written in (effects, widgets, data
sources), physics, bounds and security.

## Repository map

```
apps/
  web/        Vite + React game client: accounts, cities, characters, the map, places, the
              HUD and panels as each city's model designed them. No game rules here.
  api/        Hono HTTP API (accounts, cities, characters) and the realm: WebSocket rooms
              that run each occupied place's sim in real time for its players.
  worker/     DBOS durable workflows: a city (city spec → every place), or one place from a
              description or recording (scene → world).
packages/
  schema/     Zod domain model. THE source of truth for every persisted or transmitted shape.
              Also: world specs + WORLD_BOUNDS, city specs (kinds, items, interface) +
              CITY_BOUNDS, the realm protocol, applyEdits, test fixtures.
  artifacts/  Canonical JSON, BLAKE3 content addressing, recipe hashes, ids, artifact stores.
  sim/        Deterministic interpreter for world specs: needs, actions, state, resources,
              money; plus physics (nav grid, pathfinding, placement) and world evals.
              Pure TS: no DOM, no I/O, no clocks.
  pipeline/   The "AI compiler": the city harness, layout from words or recordings, the world
              harness (author → check → play-test → revise), improvising; memoised stages.
  engine/     Browser runtime: three.js WebGPU renderers (a place from its spec's shapes, the
              city map) and the realm connection.
  db/         Drizzle/Postgres (PostGIS) schema, migrations, actor-scoped repositories.
docs/         architecture.md, adr/ (decision records).
```

Dependency direction: `schema` ← `artifacts` ← `sim` / `pipeline` ← `db` ← `api` / `worker`.
`engine` depends on `schema` + `sim` only; `api` may import `worker/jobs` to enqueue. Never import "upwards" (e.g. `sim` must not import
`db`), and never import `node:*` from `schema`, `sim` or `engine`.

## Commands

```sh
pnpm install                 # Node ≥ 24.11, pnpm 11
cp .env.example .env         # fill in POSTGRES_PASSWORD (openssl rand -hex 24), DATABASE_URL, MUSE_API_KEY
pnpm db:up                   # PostGIS on 127.0.0.1
pnpm --filter @aye/db migrate
pnpm library:fetch           # CC0 models and textures, not in git
pnpm dev                     # web on :5173 (proxies /api), api + realm on :8787, worker
pnpm verify                  # biome + typecheck + all tests: run before calling work done
```

DB-backed tests (db, api, worker) are **skipped** when `DATABASE_URL` is unset. Load `.env`
before claiming they pass (`set -a; . ./.env; set +a; pnpm verify`). A skipped test is not a
passing test.

## Non-negotiable invariants

### 1. Generated content is compiled, not improvised

- Every model call happens inside a pipeline **stage** with a **Recipe**: stage name and
  version, exact model ref, prompt hash, input artifact hashes, params, derived seed.
  Same recipe → cached artifact, byte for byte, with no model call. This is how AI output
  is reproducible.
- Changing a stage's code or prompt behaviour? **Bump its version** (`WORLD_HARNESS_VERSION`,
  `WORLD_COMPILER_VERSION`, `ASSEMBLER_VERSION`, …). Prompt text is hashed into recipes.
- Models _write_, code _bounds and checks_, play _tests_, owners _publish_ (ADR 0014). A
  model writes a whole world as a `WorldDraft`; `compileWorld` derives every key from the
  model's names, maps objects back by index, clamps every number to `WORLD_BOUNDS`, and
  reports anything that doesn't add up; `evaluateWorld` plays it; findings go back for
  revision. Others can see a city only if its owner makes it public, and only once it's built.
  (`approveWorld` records approval of one place's world, but nothing gates play on that flag.)
- A spec is **data, never code**: conditions are integer comparisons, effects are integer
  assignments and rates. The sim interprets it; nothing in a spec is ever evaluated as code.
- A model never chooses ids, never writes code, and never changes physics. Physics (bodies,
  walls, openings, placement) is code.
- Model output is **untrusted input**. It is validated with strict, bounded schemas, and its
  text is cleaned and is display-only. Never interpolate model text into HTML, SQL, prompts for
  other stages, file paths or code.
- Generated entity ids are **derived from provenance** (`deriveId`), so regeneration keeps ids
  stable and user edits (keyed by id) rebase cleanly.

### 2. The simulation is deterministic

Same scene + world spec + settings + command log ⇒ same `Sim.hash()` on every machine.
- One tick = one simulated second. State is integers: needs in permille × 3600, money in
  minor units, positions as grid cells. Lengths everywhere are **integer millimetres**.
- Allowed math: `+ - * /`, `Math.floor/round/abs/min/max/sqrt/imul`, and the integer trig in
  `sim/src/trig.ts`. **Forbidden** in `sim`: `Math.random`, `Date`, `performance`,
  `Math.sin/cos/tan/atan2/exp/log/pow`, iteration over unordered sources, and comparators that
  aren't total orders.
- Randomness comes only from `Rng` streams seeded from the world seed, with one stream per
  subsystem.
- Every new piece of mutable state must be included in `Sim.hash()`, and must get a
  determinism test.

### 3. Clients send intents, never state

- The only way to change the sim is `Sim.step(commands)`. Commands are intents ("use this
  object") that the sim validates against the same rules agents follow: offered, capacity,
  money, utilities, reachability.
- Nothing from a client may set needs, money, positions or time. Shared places run on the
  server (the realm, `apps/api/src/realm.ts`): it accepts a closed set of client messages
  (`ClientMessage`), size-capped and rate-limited, lets a player command only their own
  character or the one person they hold, and saves money and needs from the sim, never from
  the client. Fares and travel time come from the city spec.
- Reject cheaply before doing expensive work (O(1) region checks before A*), so spam can't
  become a denial of service.

### 4. Every data access is actor-scoped

- Application code reads and writes user data only through `@aye/db` repositories that take an
  `Actor` and put the authorisation rule **in the SQL predicate**. Never fetch by id and check
  afterwards.
- Not-allowed and not-found are indistinguishable (`null` → HTTP 404).
- `system*` functions in `db/src/system.ts` bypass actors. They are only for trusted job
  handlers whose input our API already authorised. Never call them from HTTP handlers.
- Raw captures (video) are **owner-only, always**. Knowing an artifact hash grants nothing: it
  is served only through a readable record that references it (`canReadArtifact`).
- Because referencing grants access, **a user may only reference artifacts they can already
  read** (`commitRevision` enforces this). Newly generated artifacts are linked only by trusted
  code that derives the list from the content itself (`systemCommitRevision`). Never accept a
  caller-supplied list of hashes to link.
- Locations shown to non-owners are coarsened (`geoForViewer`).
- Identity is a session: HttpOnly, SameSite=Lax cookies (Secure in production) holding a random
  token; only its SHA-256 is stored. Passwords are scrypt-hashed and never logged or returned.
  `accounts.ts` is the only code that turns credentials into an `Actor`.
- A character belongs to one player; only they read or save it. Private places (a home) are a
  room per player; their chat is the owner's alone.

### 5. Privacy boundary in the pipeline

Frame sampling and redaction run on our infrastructure. Segmentation (SAM 3.1, hosted) is the
one call that sees unredacted keyframes, because finding faces and number plates is its job
(ADR 0012); never send it more than the sampled keyframes. Everything after it (`Understander`,
anything a player sees) only accepts `RedactedFrameSet` (enforced by the types),
and what the segmenter finds (faces, plates, documents, screens) is pixelated on every frame first.
A model's objects aren't tied to those detections, so people and identifying items are also
refused by name when a scene is assembled (`isPrivateThing`). A TV stays a thing; its picture doesn't. Rebuilding a
filmed thing in 3D (ADR 0023) sends only redacted frames, to whichever reconstructor is
configured, and its output is checked as untrusted bytes before anyone can load it.

### 6. Bounded everything

Every array and string in a schema has a maximum (`LIMITS` in `schema/src/primitives.ts`). New
schemas must too. Request bodies, queues, sim ticks per wake and command queues are capped.

## Security checklist for every change

- Model API keys (`MUSE_API_KEY`, `FAL_KEY`, `MODAL_RECONSTRUCT_TOKEN`) are server-side only: worker and dev scripts, never the
  browser bundle or any response. Errors from model APIs carry status and error type only.
- No secrets in code, config, fixtures or logs. Config comes from env, validated with Zod at
  boot (`apps/api/src/env.ts`). Error messages name bad keys, never values.
- Inputs are validated at every trust boundary: HTTP, worker messages, queue payloads, model
  output, files. Use `z.strictObject` for anything a client sends (no mass assignment).
- New table holding user data? Add repository functions with actor predicates, a policy
  function in `policy.ts`, and integration tests showing another user gets `null`.
- New endpoint? Add an HTTP test for unauthenticated, wrong-user and malformed input.
- State-changing HTTP requests must be JSON and, when the browser names an origin, ours (no
  cross-site forgery). The realm's WebSocket checks origin, session, membership and character
  before upgrading (no cross-site WebSocket hijacking).
- Model-designed interfaces are data: widgets, blocks, sources and intents from a closed set,
  colours as `#rrggbb` set via `style.setProperty` on known names, icons as single emoji. Never
  render a model's string as markup, a URL, a class name or a style.
- Rendering untrusted text: React text nodes only. Never `dangerouslySetInnerHTML`. SVG and
  XML from models must be escaped (`escapeXml`).
- No invisible or bidi control characters in source, and no committed secrets:
  `pnpm check:source` (part of `verify` and CI) fails on both. Build such characters from
  code points if code needs them.
- New dependency? Pin it in the `catalog:` of `pnpm-workspace.yaml`, prefer releases at least
  two weeks old, and do not add it to `allowBuilds` unless it truly needs an install script.

## Performance rules

- Zod validation happens at boundaries only, never in the sim's per-tick path.
- The sim uses struct-of-arrays typed arrays. No per-tick allocation in hot loops. Reuse search
  buffers (`PathFinder`).
- Rendering: merge static geometry and instance repeated meshes. Keep draw calls in the
  single digits per scene. Places run on the server and city life in a Web Worker. The renderer
  interpolates between snapshots.
- Measure before optimising, and say what you measured (e.g. "one simulated day: 49 ms").

## Code style

- TypeScript 7, strict, `erasableSyntaxOnly` (no enums, namespaces or parameter properties),
  `.ts` import extensions, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- Biome formats and lints (`pnpm fix`). Double quotes, semicolons, 100 columns.
- Each module starts with a doc comment explaining **why** it exists and the constraints it
  upholds. Comment intent and invariants, not mechanics.
- Name units in identifiers: `widthMm`, `durationMin`, `uptimePermille`, `wallet` (minor units).
- Prefer pure functions and explicit dependencies over singletons, and pass `Db`, stores and
  providers in.

## How to…

- **Change how worlds are written:** edit the prompts in `pipeline/src/muse.ts` (their hashes
  are in the recipes, so worlds regenerate), the draft contract in `pipeline/src/contracts.ts`
  or `compileWorld` (bump `WORLD_COMPILER_VERSION`), or balance limits in `WORLD_BOUNDS`. Then
  run the live evals (`set -a; . ./.env; set +a; pnpm --filter @aye/pipeline test`) and
  build a city in the app (`pnpm dev`, then "Make a city") to play the results.
- **Let worlds express something new** (a new kind of effect or condition): add it to
  `WorldSpec` with bounds and `specIssues` checks, to `WorldDraft` and `compileKind`, to the
  interpreter in `sim/src/sim.ts` (into `hash()` if it is state), to `staticFindings` if it
  can be unreachable, and to the prompt. Test it with a spec that uses it, and with one that
  abuses it.
- **Change how cities or interfaces are designed:** edit the city prompt in
  `pipeline/src/muse.ts`, `compileCity` / `critiqueCity` in `pipeline/src/city.ts` (bump
  `CITY_COMPILER_VERSION` / `CITY_CRITIQUE_VERSION`), or `CITY_BOUNDS`. Live eval:
  `pipeline/test/city.live.test.ts`.
- **A city needs a new concept** (ADR 0022): it is a kind the model declares, with traits
  code already runs. Don't add a field, a stage or a list for it. Only when no trait can say
  it, add a trait to `schema/src/city-kinds.ts` (bounded, with a view and `kindIssues`
  checks), to `DraftCityKind` and `compileKinds`, to the prompt, and to whatever runs it.
  Read cities only through the trait views (`placesOf`, `moversOf`, ...).
- **Let interfaces express something new** (a widget, block, data source or intent): add it to
  `city-spec.ts` (and `cityIssues` if it references anything), to `CityDraft` and
  `compileCity`/`draftOfCity`, to the critique if it's essential, to the prompt, and render it
  in `apps/web/src/game` (`Hud.tsx`, `Panel.tsx`, `sources.ts`). Test the source in
  `apps/web/test/sources.test.ts`.
- **Change how things look:** never in code. Looks are primitives models write; improve them
  through the prompts in `pipeline/src/muse.ts` (authors, `LOOK_PROMPT` for the critic,
  `DESIGN_PROMPT` for redesigns) or the knobs of `refineLooks` (pass score, rounds). A new
  primitive goes in `Primitive` and `meshes.ts` (shared by the game and the rasteriser).
- **Grow the asset library** (ADR 0016): add CC0 sources to
  `packages/engine/scripts/library-sources.ts` (label and tags say what it looks like, never
  what it does), run `pnpm library:fetch` (pins SHA-256s, rewrites the committed catalog),
  then `pnpm --filter @aye/worker refinish <worldId> <attempt>` to furnish existing cities.
  Bump `FURNISH_VERSION` if what furnishing sends or applies changes.
- **Add a pipeline stage:** define its contract in `pipeline/src/contracts.ts`, run it through
  `runStage` with a full `StageSpec`, version it, and test that a re-run makes zero provider
  calls.
- **Add a model provider:** implement the port in `pipeline/src/providers.ts` with an
  immutable `ModelRef.version`. Keep raw-media providers on our infrastructure (segmentation is
  the one exception, invariant 5).
- **Change the DB schema:** edit `packages/db/src/schema.ts`, run
  `pnpm --filter @aye/db generate`, review the SQL, and commit it. Never edit applied
  migrations.
- **Add sim state:** use typed arrays on `Sim`, include them in `hash()`, and add a
  determinism test.

## Definition of done

`pnpm verify` passes **with `DATABASE_URL` set** (`set -a; . ./.env; set +a; pnpm verify`), and
you report the actual test counts, including any that were skipped. New behaviour has tests,
including the abuse case. Docs and ADRs are updated when an invariant or major choice changes.

Any UI change has been looked at in a real browser: run `pnpm --filter @aye/web dev` and check
the console for errors, the rendering backend shown in the top bar, and the behaviour you changed.

When unsure whether something touches an invariant above (determinism, actor scoping, the
redaction boundary, untrusted model output), stop and ask instead of guessing.
