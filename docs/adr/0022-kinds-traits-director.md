# 0022 — Kinds, traits and a director: the AI defines the city's types, code runs physics

**Status:** accepted and built (see "As built" below) · 2026-11-01 · revisits 0014 (cities) and 0018 (city life); extends 0013
(worlds) to the whole city

**Context:** worlds inside a place are written the right way (ADR 0013): the model invents
kinds of things, their state and actions as data, and one generic interpreter runs whatever
it wrote. The city never got that treatment. Each new idea arrived as a field with its own
name, compiler step, prompt text and renderer: `travel[]` with `perVehicle`, `way` and
`vehicle`; `scenery[]`; `districts[]`; `water[]`; a separate stage to design vehicles. That
never ends, and every one of those is a decision code made about what a city contains.

An audit of the code (2026-11-01) found the same drift elsewhere. Examples:

- **Content decided in code:** the map draws every traveller as one white box. Road-load and
  land colours are fixed. Day is 06:00–19:00 everywhere. "Walking", "Free" and "Open now"
  are written in English by the client. The city-life, planner and trip cards sit outside
  the HUD the model designs.
- **Behaviour decided by heuristics:** anything at 7 km/h or less counts as on foot. Riders
  reach stops at 12 km/h. Money is worth `income / 2000` need points whatever the currency.
  Set-dressing things can never be used.
- **One city's nouns in every prompt:** danfo, okada, buka, kobo, agbada, gele and
  self-contain push every city toward Lagos.

The opposite extreme, letting an agent keep everything as free-form data, fails the fast
loop. Twenty thousand travellers are moved every simulated minute, every player must see the
same city, and model output is untrusted. Whatever the simulation reads must be numbers with
fixed meanings, checked when written.

**Decision:**

1. **Code owns a small vocabulary of physics, and nothing named.** Space (points, areas,
   networks), movement (moves along a network at a speed, holds N people, takes road room),
   time (the clock, sunrise and sunset), money (minor units, plus what an ordinary hour's work
   pays here, which scales how much money matters), needs and effects (ADR 0013's vocabulary,
   unchanged), shapes (the look primitives), the interface vocabulary (widgets, blocks,
   sources, intents) and colour roles. Each piece is a **trait**: a named bundle of bounded
   parameters with one interpreter in code. Code never knows what a danfo, a palm tree or a
   market is.
2. **The model defines the city's types: a kinds stage in the harness.** Before writing any
   instances, the city author writes the city's **kinds**. A kind is a name, a description,
   the traits it has with their parameters, its look, and any attributes it wants to keep.
   - Examples: "Danfo" moves on the road network at 30 km/h, holds 14, and looks like this.
     "Palm" stands still and looks like this. "Market" is a place with these hours, built
     from this description. "Lagoon" is water.
   - Attributes are free-form fields the model declares (`fare_style`, `nickname`, `rivalry`),
     bounded in count and size. They are display-only or model-only: no code interprets them.
     This is where open-ended content lives.
   - Code checks each kind against a meta-schema (traits exist, parameters in bounds,
     attributes bounded), then checks every instance against its kind.
   - Kinds are their own content-addressed artifact. Everything built later shares them, so a
     place built next week uses the city's danfo, not a new invention, and the city stays
     consistent.
   - Travel modes, scenery, vehicles, districts, water and places all become kinds with
     instances. A new concept costs no code unless it needs a genuinely new trait, and traits
     are added rarely and deliberately (AGENTS.md "Let worlds express something new").
3. **Place worlds use the same kinds and traits.** A place's world spec (ADR 0013) refers to
   the city's kinds where they fit (the car in the compound is the city's car), and keeps its
   own state and actions. A world model's ability to invent a kind on demand (improvising)
   remains.
4. **The interface reads the city's own words.** Every player-visible word the client makes
   up today comes from the city's spec: a `words` map ("free", "open now", "on the move",
   the on-foot verb), plus HUD widgets for city life, the planner and trips that the model
   places like any other widget. System chrome stays code: sign-in, refusals, connection,
   the licence credit.
5. **A director runs the slow loop.** Each world gets a director agent: a model that, every
   city hour or on events (a jam, an outage, a player milestone), reads a bounded summary of
   the world and proposes edits as data. Examples: a headline, a price change, a fuel queue,
   a new kind via the improviser, a festival that changes routines.
   - Every edit goes through the same compile and play-test as anything else written, and is
     applied as a command in the world's log at a given minute, so replays stay
     deterministic.
   - It keeps its own free-form memory (bounded per world, read only by itself) and works
     within a budget of calls per hour.
   - Code moves 20,000 people a minute; the director decides what the city is going through.
   - Its first job is the gaps the audit found: when the sun rises here, what money is worth,
     what the city calls walking.
6. **Prompts carry no one city's nouns.** Examples are neutral or are taken from the brief at
   run time. A check in the test suite fails on known city-specific words in prompts.

**What stays code:** physics and its constants (traffic queues, lane capacity, bodies,
reach), the trait interpreters, data-source vocabularies (OpenStreetMap road and land
classes), bounds, security and privacy, performance settings, and the few product rules a
city must meet (a free way to travel, a way back to the map).

**Consequences:**

- The city spec format changes, and every city is regenerated (accepted 2026-11-01).
  Sketched and real cities both become kinds plus instances. Grounding (ADR 0020) places
  instances on real coordinates and roads.
- The model writes more structure up front. The critique gains checks: every kind has a
  look, travellers' kinds have a mover trait, every place kind can be built.
- The director adds cost per world, bounded by its budget, and a new trust question: who may
  approve which edits (see open questions).
- Work in progress that this replaces: the separate vehicle-design stage and the travel-mode
  fields added on 2026-11-01. They are removed in the migration.

**As built (2026-11-01):**

- `schema/src/city-kinds.ts`: traits (place, mover, area, line, prop), kinds, items with
  overrides, free-form attributes, and one view per trait. City spec version 2 replaces
  districts, water, roads, places, travel and scenery with kinds and items, and adds economy,
  sun and words. Every consumer reads through the views.
- The city author writes kinds then items; `compileKinds` bounds them; the look critic judges
  every kind seen on the map; the furnisher may pick a library model for any kind.
- The city sim reads movers (holds, way, reach); "on foot" is `holds: 0`, not a speed guess;
  line riders reach stops at their `reach` mover's speed. The map draws each traveller as
  their mover's look, facing their way. Road load and ground cover use the theme's colours;
  ferry and rail lines their mover's colour; day and night the city's sun.
- Worlds carry `hourPay`, and the sim values pay as a share of it, not `income / 2000`.
- The city-life, planner and trip panels are HUD widgets the model places. The interface's
  words come from the city.
- Prompts carry far fewer of one city's nouns, though not none (`CITY_PROMPT` still says "keke").
  The separate vehicle designer was removed. The test point 6 calls for wasn't written: nothing
  in the suite checks prompts for such words.

**The director, as built (2026-11-01; the owner chose: it acts on its own, its budget is
configurable with no limit by default, and players don't talk to it):**

- Events are part of the city spec (`CityEvent`: a name, a window of absolute city minutes,
  and effects from a small code-owned vocabulary: a place `closed`, a mover `halted`,
  `slowed` or its `fare` changed). Everything that asks whether a place is open, whether a
  way to get around runs, what it costs and how fast it goes asks through `placeOpen` and
  `moverNow`, so an event is felt in trips (the realm), the place sheet and apps alike. Apps
  can list them (source `events`).
- `directCity` (pipeline) is a memoised stage: it reads a brief of the city now (time and
  daylight, public places open or not and players in them, movers running with their speed
  and fare, a quick reading of city life, current events, headlines, its own notes) and the
  model answers with up to three events, events to end, headlines and a note to itself.
  `compileDirection` resolves names, bounds windows (15 minutes to three days) and changes,
  keeps the city's rules (the free, always-running way to get around is never halted or
  charged), and gives the model one more go with what it got wrong.
- The worker schedules each ready world's turn every `DIRECTOR_EVERY_CITY_MIN` city minutes
  (default 180) as a durable workflow keyed by world and turn; it skips worlds still being
  built or finished, keeps to `DIRECTOR_CALLS_PER_DAY` (unset or 0: no limit), and swaps the
  new city in only if it's still the one it read. `DIRECTOR=off` turns it off.
- Its notes live in `world_directors`, read and written only by trusted jobs; no player
  ever reads them. The realm re-reads a world's city before a trip, so events apply at once.
- Not yet: events don't change city life's simulated traffic (a halted mover still appears
  on the roads there), and the director can't yet invent new kinds or places.

**A reason to play, and people who notice you (2026-11-01):**

- Threads: the director gives each player around (played in the last two days) their own
  thread now and then: a title, a line, and up to 5 steps from a code-owned vocabulary (`be_at` a
  place, `do` one of its actions, `have_money`, `meet` one of its people, or a `mark` reaching a
  value), a deadline and a reward (at most eight hours' pay here). Every name resolves to a key code can check, or the step
  is dropped and the model told. At most one new thread a turn, three open at once.
- The realm checks steps as players play, from the sim (where they are, actions they
  finished, their wallet, who's there), advances them in order, marks missed ones, and pays a
  finished thread into their wallet through a server-only `grant` command. Threads live in
  their own table: a player reads and advances only theirs. A `threads` widget, which the
  city's model must place on both screens, shows them.
- Conversations: when a player speaks in a place (or walks in; greeted at most every three
  hours), one of the people there may answer, in character, through a memoised `converse`
  stage in the worker. Only someone actually there may speak; the words are cleaned, bounded
  and posted to the room's chat under that person's name. Each person keeps one short note
  about the people they've met (model-only, per copy of a private place, never crossing
  players' homes).
- Players' first places are dressed before they arrive; the movement stick is part of the
  HUD layout; standing work reaches now and then instead of holding a pose.
