# 0017 — Panels, not a phone

**Status:** accepted · 2026-11-01 · amends 0014 (the interface a model designs)

**Context:** the interface vocabulary had a `phone` widget and intent, and every app lived on
that phone. That is a world noun in code: a city might live on laptops, radios, notice boards
or POS terminals, and a thing in a place (the buka's TV, the hub's computers) should be able
to show apps too. Code shouldn't decide what people look things up on; Ayé's cities should.

**Decision:**

1. **A panel is a group of the city's apps that opens as one screen.** The city's model names
   it, picks its icon, the apps on it, and a `form` it is drawn in (`handheld`, `wide`,
   `wall`). Code owns only those shapes, the way it owns how to draw a button or a list.
2. **Panels are opened from the HUD** (a `panel` widget, or a button whose intent is `panel`)
   **or from things in places**: furnishing (ADR 0016) may link a kind of thing to one of the
   city's panels (`KindDef.panel`), checked against the city's real panel keys; tapping it
   offers to open that panel.
3. **The critique** wants every app on a panel and every panel reachable from a screen.
4. **Older cities** read as one handheld panel at first. That shim went when ADR 0022 regenerated
   every city: the schema has no `phone` widget or intent now.

**Consequences:** "phone" isn't a word in the interface vocabulary. A city
can be all handhelds, or have a family TV and a market notice board; whatever it is, players
see the city's own words for it.
