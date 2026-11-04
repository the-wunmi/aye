# 0014 — Cities, an interface a model designs, and a shared realm

**Status:** accepted · 2026-10-27 · builds on 0013 (worlds written by models); the phone became
panels in 0017, and the map's and travel's fields became kinds in 0022

**Context:** places were playable one at a time in a developer viewer: a fixed side panel of
debug data, no player, no city, no other people. The goal is a game people live in together
(a city map with places, a character, a phone, chat),
but with nothing about a city, its interface or its rules hardcoded: models write them.

**Decision:**

1. **A city is a spec a model writes** (`CitySpec`): a stylised map (districts, water, roads,
   where each place stands, its icon, colour and hours), how people get around (modes, speeds,
   fares, hours), the needs everyone has, how a new arrival starts (money, home), palettes for
   characters, headlines. A city harness (author → compile → critique → revise, ADR 0013's
   pattern) bounds it to `CITY_BOUNDS`, accepts only real colours and single emoji, and checks
   it plays and reads: free travel exists, enough public places, readable contrast (WCAG).
   Each place is then built from its description, with the city's needs and currency, by a
   durable worker job, and pinned into the world.
2. **The interface is part of the city.** The model chooses the theme (colours, font style,
   radius), what the HUD shows and where (eight regions, a closed set of widgets), and the
   phone's apps (columns of blocks: headings, text, live stats, lists, buttons). Lists bind to
   generic queries code evaluates (`actions` that pay or help a need, `places` by tag and
   opening hours, `travel`, `people`, `players`, `headlines`); buttons do closed intents
   (open an app, show a place, the map, the phone, the tour). It is server-driven UI made of
   data: no markup, no code, no URLs, so any city renders safely and none can break the game.
   The critique holds the essentials (wallet, needs, chat, a way back to the map, the phone).
3. **Players live as a character, and can play others.** A character is a `PersonDef` owned by
   one player in one world, made from the city's choices by the server. In a place, a player
   controls their character and may take over one person the world wrote (one holder at a
   time); everyone else lives on their own.
4. **The realm runs places on the server.** Each occupied place is a room: one authoritative
   sim stepping in real time on the city's shared clock (`ticksPerRealSecond`), streaming
   snapshots to its players over a WebSocket; private places (homes) are one room per player.
   Clients send intents only (walk, use, hold, say, go). The sim gained arrivals, departures,
   holding and walk-to commands, all in `step()` and `hash()`. Money and needs live in the sim
   while in a place and are saved from it on leaving; travel charges the city's fare and takes
   the trip's time.
5. **Real accounts.** Handles and scrypt-hashed passwords; HttpOnly SameSite cookies holding a
   random token whose hash alone is stored. State changes must be JSON from our origin; the
   WebSocket checks origin, session, membership and character before upgrading. Chat is
   stored, bounded, cleaned of control characters and rendered as text.
6. **Publishing a city is the owner's approval** of everything its models wrote. Cities are
   private while building; the owner chooses whether to open them to everyone.

**Consequences:**
- The UI vocabulary (widgets, blocks, sources, intents) is a contract like the world spec:
  extending it touches the schema, the city compiler and critique, the prompt, and the
  client's renderers (AGENTS.md, "Let interfaces express something new").
- Building a city costs one city call plus a few calls per place (minutes, all memoised); a
  place that fails leaves a gap on the map rather than failing the city.
- Rooms keep state only while occupied (plus a short linger). Persisting room state and the
  command log per room, and running more than one realm process (sticky routing by world),
  are next steps. The sim worker and its in-browser play path were removed: the realm is the
  only way places are played.
- Dragging things to rearrange a place was left out at first. It has since arrived for your own
  home and places you own: the renderer proposes, a worker job checks and commits.
