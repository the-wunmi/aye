# 0004 — Behaviour comes from catalogs, not from model text

**Status:** superseded by ADR 0013 (worlds written by a model; no catalogs in code) · 2026-10-27

**Decision:** Object kinds and affordances are versioned, namespaced data packs (`core.*`).
Model labels are mapped onto kinds by deterministic alias matching. Unknown things map to
`core.unknown`, which has no behaviour. Per-object adjustments (`affordances.add/remove`) are
user edits, never model output.

**Why:** behaviour must be reviewable, tunable and safe from prompt injection. It also lets
cultural and domain packs (a Nigerian street pack, hospitals, town planning) extend the world
without code changes.
