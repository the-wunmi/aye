# 0005 — Places are versioned: generated base + edit ops

**Status:** accepted · 2026-10-26

**Decision:** A `PlaceRevision` is `{ parent, base, edits, scene }`, identified by its content
hash. Edits are typed, idempotent `put`/`remove` ops keyed by entity id. Recompiling rebases
the owner's edits onto the new base. Worlds pin each place to a revision.

**Why:** users must never lose work when models improve. Sharing places across users needs
immutable, verifiable snapshots, so someone else's edit cannot silently change your world.
`head` moves with optimistic concurrency.
