# ADR-0001: Toolchain

Date: 2026-09-25. Status: accepted (spike S0).

## Decision

pnpm workspaces; Vite+ 1.0.0-rc.0 as the task runner and linter (`vp run`, `vp lint`); TypeScript
7.0.2 (tsgo, single-threaded); Vite 8.3.1; vitest 5.0.1; Effect 4.0.0-rc.117; alchemy 2.0.0-beta.79
for every Cloudflare resource; Foundry for contracts, run through the same `vp run -r test`.

Worker and Durable Object tests use alchemy's own test harness (`alchemy/Test/Vitest`) with
`dev: true`, which deploys the stack into local workerd. `@cloudflare/vitest-pool-workers` is not
used.

## Why

- alchemy peers on `vite ^8.0.7`, so Vite 8 is forced.
- alchemy's harness depends on `@effect/vitest`, which peers on `vitest >=5 <6`, while
  `@cloudflare/vitest-pool-workers` peers on `vitest ^4.1`. The two cannot share a lockfile
  cleanly. Since alchemy already runs the stack in workerd for `dev`, its harness is the smaller
  surface, and it tests the real bindings rather than a hand-built miniflare config.
- Vite+ 1.0.0-rc.0 bundles vitest 5.0.1, matching `@effect/vitest`; 0.2.8 bundles 4.1.10 and would
  have pulled the older set back in.
- Turborepo would have been a second task graph; Vite+ derives ordering from package.json
  dependencies and caches tasks against declared inputs, which the cloudflare-os repo has already
  worked through (scratch-path exclusions, `env` on tasks).

## What S0 established (25 Sep 2026)

- `vp run -r typecheck`, `vp run -r test` and `vp lint` run green under one `pnpm check`; a second
  run replays every task from the cache. The `test` tasks exclude vitest's and alchemy's scratch
  paths (`node_modules/.vite*`, `.alchemy/`) and forge's `out/`/`cache/`, or they never cache.
- alchemy's harness (`alchemy/Test/Vitest`, `dev: true`) deploys the stack into local workerd in
  about 4 s and the four binding probes (runtime, Durable Object, R2, D1) pass in about 8 s.
- The stack file defaults to `Alchemy.localState()`; `ALCHEMY_REMOTE_STATE=1` selects
  `Cloudflare.state()`, which the staging deploy script sets. `Cloudflare.state()` prompts to
  bootstrap a remote store, which is why it cannot be the default under a non-interactive harness.
- alchemy resolves Cloudflare credentials even for local providers, so `apps/api/vitest.config.ts`
  supplies placeholder `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` when none are set. Nothing in
  the suite reaches the cloud; real values win when present.
- `destroy(Stack)` of a local stack hangs the harness in beta.79 (120 s hook timeout), so the suite
  never destroys. The local stack persists in `.alchemy/` (gitignored) and every test uses fresh
  ids. Revisit when alchemy moves off beta.
- Effect's `HttpServerRequest.url` is path-only; parse it against a base.
- `forge-std` is vendored (no submodule) so CI checkout needs no `submodules: true`.
- Foundry 1.4.1 runs the tests but warns about the Monad verification keys in `foundry.toml`
  (`metadata`, `metadata_hash`, `use_literal_content`), which need Foundry >= 1.8. Run `foundryup`
  before the B1 deploy; the keys stay because the deploy needs them.

## Amendment (2026-09-26): typecheck tasks need explicit inputs

Vite+'s automatic input tracking does not see the files tsgo reads: after a source change in
`packages/board`, `vp run typecheck` replayed a stale cache hit over a real TS2367 error that a direct
`tsc -p tsconfig.json` reported. Every `typecheck` task therefore declares its inputs by hand
(`src/**`, `test/**` where relevant, the package `tsconfig.json`, the workspace `tsconfig.base.json`,
`pnpm-lock.yaml`) and `output: []`. Verified: a touched source now misses the cache. The `test` tasks
were not affected in the same way because vitest's reads are tracked, but `pnpm check` should never be
trusted on typecheck alone until this is re-verified after a Vite+ upgrade.

## Consequences

- Bun is not required. Node 24 runs everything; CI uses Node 24.
- A cached `vp run` strips the environment: any variable a task reads must be declared on the task.
- `alchemy dev` and the tests run without Cloudflare credentials when every resource has a local
  provider (ids are `dev:`-prefixed). Staging deploys need `alchemy profile edit --add Cloudflare`.
