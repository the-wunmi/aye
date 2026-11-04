# 0011 — House rules are written by a model, bounded by code, approved by the owner

**Status:** superseded by ADR 0013 (the whole world, not just house rules, is model-written) · 2026-10-27

**Context:** the first foundation hand-tuned what everything is for in a `core` catalog: a bed
restores 150 energy an hour, starting the generator costs ₦2,000. That made the game reflect
our assumptions rather than each place, and it over-fitted the brief's examples (generators,
accessibility). Ayé should be a life sim whose rules come from the place itself, and which
respects the physical world.

**Decision:**

1. **A model writes each place's house rules.** From the scene's objects (labels, sizes,
   rooms; no frames), Muse proposes kinds, what people do with each, need effects, durations,
   prices in the world's currency, what needs power or water, what supplies it, how fast needs
   fall and how reliable public supply is. Output is constrained to `RulesProposal` (JSON
   Schema decoding) and validated again.
2. **Code bounds and compiles it.** `compileRulebook` derives every key from the scene hash
   and the names, maps objects back by index, clamps every number to `RULE_BOUNDS` (no money
   printers, no needs that never fall), cleans all text. The result is a `Rulebook`: a
   catalog pack plus assignments plus world rules. It is data, never code.
3. **Play-tested before anyone sees it.** `evaluateRules` plays two simulated days with two
   ordinary residents. Errors (an action needs a supply nothing provides; nobody can do
   anything) block the proposal. Findings go back to the model once (`revise-rules`) and the
   revision is kept only if it is better. The live run proved the point: the first answer made
   the toilet need running water in a flat with 65% water uptime; the evals caught residents
   stuck for hours; the revision modelled bucket-flushing from stored kegs.
4. **The owner approves.** A rulebook arrives on a revision as `{approved: false}`. Only
   `approveRules` (owner-only, the exact rulebook at the head they reviewed) commits an
   approved revision. Ordinary edits must carry rules unchanged, so nobody hand-writes a
   rulebook into a shared world. Until approved, the place runs on the `core` baseline.
5. **Physics stays in code.** Bodies can't climb more than they can; furniture can't overlap
   walls or other solid things and must be carriable to where it goes through openings wide
   enough for its slimmest side (`PlacementField`). The accessibility _mode_ is removed; the
   limits it measured are now simply how the world works for everyone.

**Determinism:** Muse's `seed` is deprecated and best effort, so reproducibility comes from the
recipe cache as before: the model id, prompt, request, effort (and for revisions, the
findings) key every call. A stored answer replays byte-for-byte with no call; a different
model or prompt is a new, separately evaluated answer.

**Consequences:** the `core` pack becomes the offline baseline and the fake provider's
answer, not the source of truth. Live evals (`packages/pipeline/test/muse.live.test.ts`,
skipped without `MUSE_API_KEY`) assert meaning, not numbers: beds restore energy, generators
supply power only once started, big furniture blocks movement, days are livable. The model id
doubles as the privacy mode (Standard vs Contributor) and is configured in `.env`.
