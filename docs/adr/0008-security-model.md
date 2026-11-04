# 0008 — Security model

**Status:** accepted · 2026-10-26 · point 3 amended by 0012

1. **Object-level authorisation in the data layer.** Repositories take an `Actor` and encode
   access in SQL predicates. Unauthorised rows are never loaded. Not-found equals not-allowed
   (404). `system*` functions exist only for trusted jobs. Next: Postgres RLS as a second layer.
2. **A hash is not a capability.** Artifacts are served only through readable records
   (`artifact_refs`), with `private` caching, `nosniff` and a sandboxing CSP.
   Since a reference grants access, users may only reference artifacts they can already read.
   Only the trusted worker links new pipeline output, deriving the list from the scene itself.
   (This closed a hole where an owner could "reference" someone else's video by hash; there
   is a regression test.)
3. **Privacy boundary.** Raw video stays on our infrastructure and is owner-only. SAM sees the
   sampled keyframes to find what must be hidden (ADR 0012); every other model gets only
   `RedactedFrameSet`. Private tracks never become objects. Locations are coarsened for non-owners.
4. **Model output is hostile.** Strict bounded schemas, unsafe characters stripped, text display
   only, behaviour only as bounded spec data (ADR 0013). SVG text is escaped.
5. **Clients send intents.** The sim validates every command, and only the server steps it.
   Replaying a log and comparing `Sim.hash()` would detect tampering, but the realm doesn't
   persist its commands yet (ADR 0014). Cheap rejection comes before expensive work.
6. **Bounded inputs everywhere.** Schema limits, body limits, rate limits, capped queues and
   ticks.
7. **No secrets in the repo.** Env is validated at boot without echoing values. Dev auth is
   refused in production. `check:source` blocks committed keys and Trojan Source characters.
   CI generates its own database password per run.
