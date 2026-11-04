# Ayé

_Yoruba for "world" and "life"._ Ayé is a multiplayer life simulation of any city you can
describe. Write "Lagos: buka food, danfo buses, Yaba tech hubs…" and a model (Muse) designs the
whole city: its map and places, how people get around and what it costs, the needs everyone
has, how newcomers start, and the game's own interface (its look, its HUD, its apps and what
people open them on). Then every place is built: laid out, and given a world where every thing has state and
things to do with it (uncover the car, open the door, drive off). A harness checks and
play-tests everything the models write until it works.

Sign up, make a character, wake up at home, and live in it with everyone else in real time:
walk around, work, eat, travel by the city's own transport, talk, or take over someone the
world wrote. Nothing about any city is hardcoded; code owns physics, bounds and security.

See [`brief.md`](brief.md) for what it is, [`CREDITS.md`](CREDITS.md) for whose work it's built on, [`docs/architecture.md`](docs/architecture.md)
for how it works, [`docs/adr/`](docs/adr) for why, and [`AGENTS.md`](AGENTS.md) for how to
contribute.

## Quick start

Requires Node ≥ 24.11, pnpm 11 and Docker.

```sh
pnpm install
cp .env.example .env          # set POSTGRES_PASSWORD (openssl rand -hex 24) and the same value in DATABASE_URL, and MUSE_API_KEY (required)
pnpm db:up                    # PostGIS on 127.0.0.1
pnpm --filter @aye/db migrate
pnpm library:fetch            # the CC0 models and textures (about 25 MB, not in git)
pnpm dev                      # web http://localhost:5173 · api http://127.0.0.1:8787 · worker
```

Then open http://localhost:5173, sign up, and describe a place or a whole city. The
worker designs and builds it (a few minutes; model answers are cached under `.aye/`, so
rebuilding is free). When it opens, make a character and play. Open a second browser profile
to play together. `MUSE_API_KEY` is required.

Run all checks (source hygiene, lint, typecheck, every test including the database-backed
ones):

```sh
set -a; . ./.env; set +a; pnpm verify
```

## What's here

- **`packages/schema`**: the domain model. Scenes in integer millimetres, places and
  revisions, world specs and city specs (the bounded data models write), the realm protocol.
- **`packages/pipeline`**: the city harness, words or video → scene, and the world harness
  (author, check, play-test, revise, improvise), through memoised, content-addressed stages
  with a type-enforced privacy boundary.
- **`packages/sim`**: a deterministic interpreter for world specs (people arriving, leaving and
  being played), physics, and world evals.
- **`packages/engine`** + **`apps/web`**: WebGPU renderers for places and the city map, and the
  game client that renders each city's model-designed interface.
- **`packages/db`** + **`apps/api`** + **`apps/worker`**: Postgres/PostGIS, accounts and
  actor-scoped access, the HTTP API and the realm (real-time rooms over WebSockets), and DBOS
  durable workflows that build cities and places.

## License

[MIT](LICENSE). The asset library and models are credited in [`CREDITS.md`](CREDITS.md), under their own licences.
