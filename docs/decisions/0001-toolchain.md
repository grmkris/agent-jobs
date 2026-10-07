# ADR-0001: Toolchain

Date: 2026-09-25. Amended: 2026-10-07. Status: accepted.

## Decision

Bun 1.4.2 manages workspaces and the committed `bun.lock`. Turbo 2.11.7 runs package scripts and caches their results.
TypeScript 7.0.2 uses the single-threaded compiler; Oxlint 1.87.0 applies the repository's correctness and suspicious
rules without type-aware lint. Node 22 or newer runs Vitest 5.0.3. Vite 8.3.3 builds Explore and the Fumadocs/TanStack
Start docs app. Foundry remains the Solidity compiler and test runner.

Effect and every installed `@effect/*` package are pinned to 4.0.1. Alchemy 2.0.0-beta.81 owns Cloudflare resources.
The root includes `@effect/platform-bun` so Alchemy can load under Bun. Only `workerd` is a trusted install script.

## Tasks and caching

Each TypeScript workspace declares `typecheck` and `test` scripts. `contracts` declares `forge test`.
`bun run typecheck` checks mining scripts, then runs the workspace graph; `bun run test` runs two tasks at a time.
`bun run check` runs typecheck, tests, mining's Bun tests, then lint. CI installs Bun and Node 22 on a GitHub-hosted
runner, checks out submodules, installs Foundry, uses the frozen lockfile, and runs that command.

`turbo.json` declares root configuration, lockfile, contracts configuration and cross-package source inputs explicitly.
Tests exclude Alchemy state; generated workerd, Vite and Foundry directories remain gitignored. RPC variables,
HyperSync credentials, fork timeouts and stage/profile variables participate in test cache keys. Basic host variables
including `HOME` and `PATH` pass through so Foundry can locate solc. Deployments, migrations and transactions never
run as cached tasks.

## Local stack tests

Worker and Durable Object tests use Alchemy's own harness (`alchemy/Test/Vitest`) with `dev: true`, which boots the
real bindings in local workerd. API test configuration supplies placeholder Cloudflare credentials when none are
set, limits parallel stack boots, and omits Explore's remote development child. Local evidence does not establish a
deployment. Production remote state and signing/readback gates remain separate in the mainnet runbook.
