# 0007 — Postgres + PostGIS, Drizzle, DBOS durable workflows

**Status:** accepted · 2026-10-27 (DBOS replaced pg-boss the same day)

**Decision:** One Postgres, with PostGIS for place geography (GiST index, `ST_DWithin` search).
Drizzle for schema, migrations and typed queries. Capture compilation runs as a **DBOS**
durable workflow (`captureCompile` on the `capture-compile` queue). Every step is checkpointed
in DBOS's system schema, workflow ids are derived from the job (enqueueing is idempotent), and
input is validated with Zod on every invocation, including recovery. Large blobs live in
content-addressed storage (a filesystem store; S3-compatible storage is a plan, not yet code).

**Why DBOS over a plain job queue:** compiling is a multi-step workflow. DBOS gives crash
recovery from the last completed step, observability and queue concurrency limits on
Postgres, with no new infrastructure. Because pipeline stages are memoised, the compile step
can be one DBOS step: a retried compile replays finished stages from cache.

**Notes:** `postgis/postgis` has no arm64 image, so `imresamu/postgis` (multi-arch build) is
used. The DBOS SDK is pinned to a release at least two weeks old.
