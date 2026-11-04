# Ayé architecture

How the pieces fit together, and why. Decisions are recorded individually in `docs/adr/`.

## The one-paragraph version

Someone describes a **city**. A city harness has a model write its **city spec**: a stylised
map of districts, water, roads and places, how people get around and what it costs, the needs
everyone has, how newcomers start, and the game's interface (theme, HUD layout, apps and the panels they live on).
Each place is then built from its description: a model lays it out as a **scene** (typed,
integer-millimetre geometry) and a world harness has a model write its **world spec** (kinds of
things with state, actions and looks; resources; people), with the city's needs and money. Code
checks everything, the simulation play-tests it, and findings go back to the model until it
works. Every model call is a memoised stage, so a city replays byte for byte with no calls.
Players sign up, make a character from the city's choices, and live in it together: the
**realm** runs every occupied place's **deterministic sim** on the server in real time and
streams it to its players, who send **intents** only. The client renders the city's interface
exactly as its model designed it, from a closed vocabulary of widgets, blocks and data sources.

## Flow

```
 "Lagos: buka food, danfo buses…" ─► API ─► DBOS "city-build" ─► worker:
     author-city (Muse) → compile + critique (code) → revise … ─► CitySpec
     for each place: describe (Muse) → assemble → Scene
                     author-world (Muse, city needs) → compile → play-test → revise … ─► WorldSpec
                     ─► PlaceRevision, pinned into the world under the place's city key
 (a place can also start from a recording: frames → SAM → pixelate → understand, ADR 0012)

 browser ──HTTPS──► API: accounts, cities, characters, the city spec + what each place offers
         ──WSS────► realm: one room per occupied place (per player for private places)
                    Sim stepping in real time ─ snapshots (5 Hz) ─► client interpolates
                    ▲ intents: go (fare, time) · drive · walk · use · cancel · hold · release
                                · say · buy_home
```

## Packages and boundaries

| Package          | Responsibility                                                           | May depend on                   |
| ---------------- | ------------------------------------------------------------------------ | ------------------------------- |
| `@aye/schema`    | Domain model (Zod): scenes, places, world and city specs, realm protocol | zod                             |
| `@aye/artifacts` | Canonical JSON, BLAKE3, recipe hashes, ids, stores                       | schema                          |
| `@aye/sim`       | Spec interpreter, people coming and going, physics, evals, snapshots     | schema                          |
| `@aye/pipeline`  | Stages, Muse/SAM/ffmpeg ports, assembler, world and city harnesses       | schema, artifacts, sim          |
| `@aye/db`        | Postgres schema, accounts, sessions, actor-scoped repositories           | schema, artifacts               |
| `@aye/engine`    | WebGPU renderers (a place, the city map), realm connection               | schema, sim, three              |
| `apps/api`       | HTTP (accounts, cities, characters) and the realm (WebSocket rooms)      | db, sim, artifacts, worker/jobs |
| `apps/worker`    | DBOS workflows: build a city, build a place                              | db, pipeline, sim, artifacts    |
| `apps/web`       | The game client: screens, model-designed HUD and panels                  | engine, schema, sim             |

## Units and space

- Lengths are **integer millimetres**: exact, canonical when hashed, and int32 range covers
  ±2,147 km.
- Right-handed, **Y up**, floor plane (x, z), matching three.js.
- Each place has its own local frame. An optional `GeoAnchor` (WGS84 + bearing of −Z +
  precision) puts it on the map. Precision is coarsened for non-owners.
- Angles are integer degrees. Money is integer minor units (kobo for NGN). Needs and ratios are
  permille.

## The scene graph

`Scene` holds `levels`, `spaces` (room polygons with floor offset and surface), `walls`,
`openings` (doors and gates with clear width and threshold), `levelChanges` (steps, stairs,
ramps, kerbs, lifts), `objects` (label, transform, size, evidence linking back to a
recording), `portals` (exits) and `entry`. What objects are and do is the world spec's.
Referential integrity and uniqueness are enforced by the schema itself.

Structure is explicit rather than a mesh, because the simulation reasons about it. A 180 mm
step at the front door is a fact the sim acts on: a wheelchair can't climb it. A wall mesh
would not carry that.

## Capture: from a clip to a place (ADR 0012)

Hosted Meta models plus CPU work, every model call a memoised stage:

```
clip ─ ffmpeg keyframes ─ SAM 3.1 (faces, plates; sees raw frames) ─ pixelate
     ─ Muse Spark: map the place from redacted frames ─ assemble (code) ─ scene
```

- Muse returns a `MusePlace` (spaces as ground polygons, walls along frontages, entrances,
  kerbs, fixed objects, exits), constrained by JSON Schema. `placeToUnderstanding` makes its
  keys safe and converts it into the pipeline's contract.
- The layout is estimated from things of known size: a recognisable representation, not a
  survey. Code assigns ids; physics applies to whatever geometry results. What each object
  is, does and looks like comes from the world spec.

## Cities and their interface (ADR 0014)

A `CitySpec` is the whole game around the places. What the city is made of is **kinds** the
model declares and **items** of them on the map (ADR 0022). A kind has a look and the
**traits** code knows how to run: `place` (somewhere people go into: hours, private, tags,
size, what it's like inside), `mover` (a way to get around: network, speed, how many it
holds, fares, hours, how riders reach its stops), `area` (land people live in, or water
nothing crosses), `line` (a road) and `prop` (stands on the map). Items place them (a point,
spots, a polygon, a line) and may override their kind's look and parameters. Code reads a
city only through one view per trait (`placesOf`, `moversOf`, `districtsOf`, `waterOf`,
`linesOf`, `propsOf`), so nothing in code knows what any kind is. Beside them: the city's
needs, its economy (what an hour of ordinary work pays, which sets what money is worth to
people), its sun (sunrise and sunset), the words the interface needs in its own voice, starts
(money and a private home), character palettes, headlines, and the interface:

- **theme**: colours, a font style from a fixed set, a corner radius (applied as CSS variables);
- **HUD**: for the map and for inside a place, eight screen regions, each a list of widgets
  (brand, wallet, clock, needs, doing, resources, ticker, presence, chat, people, feed, life,
  plan, trip, threads, panel, text, button);
- **apps**: columns of blocks (heading, text, stat, list, button), grouped into **panels**
  the model names (a phone, a laptop, a notice board) and draws in one of a few forms
  (ADR 0017); things in places can open a panel too;
- **sources**: what lists show, as generic queries the client evaluates (actions that pay or
  help a need, places by tag and hours, travel, people, players, headlines, events);
- **intents**: what buttons do (open an app or a panel, show a place, the map, the tour).

`compileCity` turns the model's flat draft into this, deriving keys from names and rejecting
anything that isn't a colour, an emoji or a known reference; `critiqueCity` checks that the
city is playable and legible (wallet, needs, chat and a way back to the map in a place; a free
way to travel; enough public places; every mover drawn; WCAG contrast). Findings go back to
the model, and the look critic judges every building and every kind seen on the map.

## Worlds: what a place contains (ADR 0013)

Nothing about a world's contents is in code. A `WorldSpec` defines:

- **needs** (what drives people here, with decay rates) and **resources** (grid power, tap
  water, cooking heat… with how reliable public supply is, if any);
- **kinds** of things, each with **vars** (small integer state: `covered`, `door_open`,
  `fire_lit`), **actions** (duration, capacity, cost, income, need rates, conditions on vars
  or resources, var changes when done, optionally timed, optionally leaving with the thing),
  **supplies** (resources it provides while conditions hold) and a **look** (coloured
  primitives relative to its size, some shown only in certain states);
- **things** (each scene object's kind and starting state) and **people** (look, body,
  money, starting needs).

The harness: a model writes a `WorldDraft`; `compileWorld` derives keys from names, maps
objects and spaces back by index, clamps every number to `WORLD_BOUNDS`, and lists every
inconsistency; `evaluateWorld` reads the spec for things that can never happen and plays it
(two days for lived-in places, six hours for visited ones); findings go back for revision, up
to three rounds, keeping the best. `improvise` extends one kind on request the same way.

## Looks: designed, then seen (ADR 0015)

Everything visible is built from primitives (box, rounded box, cylinder, sphere, hemisphere,
cone, capsule, torus, wedge; any of them can glow), defined once in
`packages/schema/src/meshes.ts` so the game and the pipeline draw identically. Models write every look: things (relative to their
size, with shapes per state), people (a rig of parts that move: body, head, arms, legs),
buildings and scenery (relative to their map box), and the looks new players choose from.

After a city or place works, **dressing** makes it look right:

```
looks ─ rasterise into numbered contact sheets ─ critic (vision model) scores each tile
          ▲                                                   │ weak ones, with fixes
          └── designer (vision model): this look, a picture of it, the notes → whole new look
```

up to three redesigns per look, each look keeping its best version; only looks change. Every
sheet and redesign is a memoised stage.

**Arranging (seen, not assumed).** After a place is furnished and dressed, the harness draws
every thing the world says people sit or lie on (in red) with what's around it, from the
library models' real geometry (`readLibraryMesh`/`fitMesh`, fitted exactly as the game fits
them) and the walls as low stubs, leaving out overhead parts as the game's camera does. A
vision model says which way each should face (seat toward the table it serves, back to the
wall, a bed's head to a wall) and how far to turn it; code takes a turn only if placement
physics allows it and the place plays no worse, then shows the turned things again so the
model confirms its own work (`arrangePlace`, two rounds, memoised). Nothing in code says
what a seat is or where a model's front is.

## The asset library (ADR 0016)

Primitives are the fallback; a curated library of CC0 models, rigged outfits and textures is
what most things are drawn with. Code curates it (`pnpm library:fetch`: downloads, packs,
pins SHA-256s, measures, writes the catalog); models only _choose_ from it by id:

```
world written ─ furnish (Muse: a model per kind, an outfit per person, floors, walls, which
                 panel a thing opens) ─ code checks every id and category
              ─ decorate (Muse proposes set dressing; placement physics places it; a replay
                 checks nothing got blocked) ─ spec and scene carry ids, never files
city written  ─ furnish (outfits new arrivals pick from, a building per place, scenery, and
                 the buildings each district's streets are lined with)
```

The renderer fits each model into its thing's measured box, keeps primitive shapes that only
show in other states drawn over it, textures floors and walls in metres, and animates outfits
(walk, run, idle, interact; sitting and lying bend the skeleton). Missing files mean
primitives, never a broken game.

## City life (ADR 0018)

A model writes who lives in the city (groups, home districts, weekday routines); the city sim
plays them on the road graph minute by minute: shortest routes, vehicles queueing for room as
roads fill, deterministic from the spec and seed. Every client
runs it on the shared clock, so all players see the same traffic; the map draws it and a card
summarises it. A sketched city is plausible, not calibrated.

A real city (ADR 0020) plays the same population on OpenStreetMap's main roads, frozen at their
first fetch, with a queue model of traffic and routes rebuilt every 15 city minutes. Its roads
are real; its demand is still a model's estimate, and the interface says so. Planning scenarios
(ADR 0021) change roads and compare two whole days in the player's browser.

## Asking for more, live

A player taps a thing and asks for something it can't do ("wash it"). The API checks they can
play the world and rate-limits them, and queues a durable job: the improvise harness rewrites
that kind, the sim play-tests the place, dressing gives the new state its look, and the result
is committed as the place's next revision and pinned. Rooms playing the place check their pin
every ten seconds and rebuild the sim onto the new world (time, state, needs and money carry
over); players see it without reconnecting.

## The realm: playing together (ADR 0014)

- **Rooms.** The first player to enter a place starts its room: the pinned scene and spec
  loaded, a Sim created on the city's clock (`ticksPerRealSecond`, 30 by default: a day is 48
  real minutes). It steps every 100 ms and sends snapshots at 5 Hz; empty rooms linger two
  minutes, then stop. Private places (homes) have one room per player.
- **Players.** A WebSocket connects a signed-in player of the world (origin, session,
  membership and character checked before the upgrade; one connection per player per world).
  Their character arrives at the entrance (`arrive`, controlled), and leaves with its state
  (`depart` → `departed` event, saved). Going somewhere checks hours, mode and money, charges
  the fare, wears needs down for the trip's minutes and arrives after the trip's time, sped up
  so no trip takes longer than `tripMaxRealSec`.
- **Playing others.** A player can hold one person the world wrote (`control` on), commanding
  them like their character; others see who is playing whom.
- **Abuse.** Messages are capped at 2 KB, schema-checked and rate-limited (token buckets),
  with strikes for junk; commands per room per tick are capped; slow sockets skip snapshots.

## Determinism

**Generation:** a stage's `Recipe` = {stage, stageVersion, model ref with immutable version,
prompt hash, input artifact hashes, params, seed derived from the rest}. Its hash keys the
`recipes` memo table. Recompiling an unchanged capture makes zero model calls and yields
byte-identical output; the same holds for worlds and improvisations. A new model or prompt
produces new artifacts beside the old ones, never silently replacing them.

**Simulation:** fixed one-second ticks, integer state, seeded per-subsystem RNG streams,
committed integer trig tables, stable iteration order. `Sim.hash()` covers the state that decides
what happens next, though not yet people's planned paths and speeds. Tests assert that identical inputs give identical hashes even when the
character input order differs.

**Why both matter:** reproducible worlds can be shared, replayed, debugged and verified.
Re-running a command log and comparing hashes is what would let a server check a room's history
(the realm doesn't persist one yet; see Known next steps).

## Rendering

The city map draws districts, water and roads as flat shapes, every place as its building,
props where they stand, and city life's travellers as their mover's own look facing the way
they go; pins and labels are DOM elements placed each frame, so text stays crisp and accessible.
Inside a place, everything drawn comes from data: ground and walls in the spec's colours, and each thing from
its kind's shapes, re-evaluated as its state changes (the cover disappears once it's off; a
thing someone has driven away is gone until it's back). The style is a clean representation:
flat colours, soft daylight with shadows, real proportions, an orbit camera, and walls dropping
to stubs so you can see in (when the camera follows someone, those on its side of them). Tapping a thing shows what it can do (greyed when its conditions don't hold),
tapping a person offers to play as them, tapping the floor walks there; speech floats over
whoever said it. Someone rearranging their own home, or a place they own, drags things against
placement physics; the renderer only proposes, and a worker job checks and commits the move.

## Places, revisions, worlds

- `Place`: a mutable identity (owner, visibility, geo, `head`).
- `PlaceRevision`: immutable, identified by the hash of its content: `{ parent, base, edits,
  scene }`. `base` is the generated scene. `edits` are typed, idempotent operations keyed by
  entity id. `scene` is the materialised result, kept as a cache.
- Recompiling rebases the owner's edits onto the new base. This works because generated ids
  are derived from provenance (capture + track), so they survive regeneration.
- Commits use optimistic concurrency on `head` (a `ConflictError` means rebase and retry).
- `World`: a playable city: its city spec, its places under the keys that spec gives them,
  each **pinned** to a revision like a lockfile, and shared simulation settings (seed, grid
  resolution, start time, clock). How people get between places comes from the city spec, what
  happens in each place from its world spec.

## Simulation model

- **Interpreter:** a spec compiles to integer tables (needs, resources, kinds, actions,
  conditions, effects). Thing state lives in one typed array; timed changes revert on
  schedule; things can be away (taken by someone) for a while.
- **Navigation grid** per level (default 100 mm cells): walkable flags, floor heights (steps,
  ramps, thresholds), clearance from a chamfer distance transform, and attribution.
- **Movement** is checked per body at query time: clearance ≥ width/2, rise ≤ max step, slope
  ≤ max slope, no corner cutting. Bodies come from each person's spec.
- **Regions** are labelled once per body type, so "can I ever reach that?" is O(1); A* runs
  only when a path exists. People arrive at the entrance opening onto the most ground their
  body can reach.
- **Choosing:** each available action is valued by the needs it meets, weighted by urgency
  (quadratic), plus income, discounted by distance. Actions that only change state are worth
  half of what they unlock, two steps ahead (uncover → open → drive), including resources a
  thing would start supplying. A weighted pick among the top three uses the seeded RNG.
- **Money:** costs are paid at the start, income at the end. Only purely need-driven actions
  may end early when the needs are met; paid work always runs its full duration.

## Physics

Code, never model output:

- **Bodies:** each person's width, step, slope and stairs (from their spec) drive movement,
  so a wheelchair can't climb a 180 mm step and nobody walks through a wall.
- **Use:** a thing is usable only from floor within reach that connects to it without
  passing through anything solid.
- **Placement (`PlacementField`):** things stay inside the place and off walls, solid
  things (as the spec says) don't overlap, and an object must be carriable to its new spot through openings
  wide enough for its slimmest side.
- The renderer sweeps drags through the same check, sliding along obstacles. The worker
  re-checks every edit authoritatively.
- **Ways through (assembly):** a layout is made walkable before anything plays in it. A
  space nobody can walk into from a way in gets a doorway in its longest wall that has
  walkable floor beyond (`openSealedSpaces`), and anything standing in a doorway's approach
  slides the least distance out of it within its own space (`clearWays`). Doors are cut
  along their wall whatever angle a model gave them, and a door's lip at the top of a step
  is stepped over on its own (wheels still have to roll over it).
- **Resting on things:** bodies stay on the floor beside what they use (that is physics);
  the renderer draws someone sitting or lying ON a thing (`ActionDef.on`, written by the
  model; judged by height for older worlds) on its seat or surface, side by side when
  several share it, facing away from a seat's back. Someone sitting AT a table or desk takes a
  free seat within 1.5 m, facing the table, or stands at it if there is none.
- **Overhead parts** (an awning's canvas, a canopy) that are broad and wholly above 1.6 m
  go on a layer the camera doesn't draw, like the wall cutaway; posts and small things up
  high stay. Only what the camera sees changes.

## Security model (summary; see ADR 0008)

- Actor-scoped repositories with authorisation in SQL predicates. Not-found and not-allowed
  look the same.
- Artifacts are content-addressed, but **a hash is not a capability**. Downloads are
  authorised through `artifact_refs` → a readable record, and served under a sandboxing CSP.
- Raw video is owner-only. SAM sees the sampled keyframes, because finding faces and plates is
  its job (ADR 0012); every other model gets only redacted frames (enforced by the types).
  Private tracks never become objects.
- Model output is hostile input: strict bounded schemas, cleaned text, code-derived keys,
  `WORLD_BOUNDS` and `CITY_BOUNDS`, play-tests. Others can see a city only if its owner makes it
  public, and only once it's built (ADR 0014).
- Clients send intents. The sim validates them, and only the server steps it. The realm doesn't
  yet write them to the `command_log` table (see Known next steps).
- Config is validated at boot, there are no secrets in the repo (enforced by `check:source`),
  dev auth is refused in production, and every schema is bounded.

## Known next steps

- Persist room state and a per-room command log, so a place carries on exactly where it was
  and any moment can be replayed and checked. Several realm processes with sticky routing by
  world.
- Adding a place to a city from words (a recording already can).
- Passkeys alongside passwords; moderation for chat (report, mute, block); Postgres row-level
  security as a second layer under the repositories.
- Multi-level navigation (stairs and lifts between level grids); the people a world wrote
  talking to each other (today they answer players, ADR 0022).
