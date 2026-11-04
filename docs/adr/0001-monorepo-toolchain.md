# 0001 — Monorepo and toolchain

**Status:** accepted · 2026-10-26

**Decision:** pnpm 11 workspaces with a version `catalog:` and an install-script allowlist
(`allowBuilds`). Turborepo for task orchestration. TypeScript 7 (native compiler), strict, with
`erasableSyntaxOnly` so Node 24 runs `.ts` directly (no build step for packages or servers).
Biome for formatting and linting. Vitest 5.

**Why:** one install, one place to pin versions, fast typechecks (TS 7), and no transpile step
between source and runtime: packages export `src/*.ts`, and Vite and Node consume it directly.
`erasableSyntaxOnly` bans enums, namespaces and parameter properties, which keeps the code
runnable by type-stripping.

**Trade-offs:** TypeScript-only syntax like enums is unavailable (use `as const` objects).
Packages are not published, so not having build artifacts is fine.
