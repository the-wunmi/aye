# 0002 — Generated content is compiled and content-addressed

**Status:** accepted · 2026-10-26 · the assembler part amended by 0013: there is no catalog, and
models now write the world's rules as well as describing

**Context:** Model output varies between calls and model versions. Ayé needs places that
replay identically, can be shared and can be debugged.

**Decision:** Every model call happens inside a pipeline stage with a `Recipe` (stage + version,
immutable model ref, prompt hash, input artifact hashes, params, derived seed). The recipe's
BLAKE3 hash keys a memo table, and outputs are stored content-addressed. A matching recipe
returns the stored bytes without a model call. Models only describe. A pure assembler maps
their output onto the catalog, quantises it to mm, and derives ids from provenance.

**Consequences:** reproducibility is a property of the system, not a hope about sampling.
Upgrading a model creates new artifacts beside old ones. Retries and crash recovery are cheap
(finished stages are cache hits). Storage grows with every variant, so garbage collection by
reachability from revisions is needed later.
