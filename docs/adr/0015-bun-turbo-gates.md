# ADR-0015: Bun, Turbo and myapps' gates

Date: 2026-10-07. Status: accepted. Supersedes [ADR-0001](0001-toolchain.md).

## Context

The repository has Bun workspaces, Turbo task dependencies, Effect packages, Alchemy stacks, Oxlint/Oxfmt gates and
Foundry contracts. Effect is pinned to 4.0.1 and Alchemy to 2.0.0-beta.81. A single broad command hides which workspace failed and lets expensive work contend on a shared box.

## Decision

Bun 1.4.2 and Node 22 are the supported runtimes. Turbo 2.11.7 runs workspace scripts and uses explicit source inputs.
`bun run check:files <paths...>` is the scoped format, lint, typecheck, graph and agent gate; `bun run check` is the full
release gate. `agents:check` is part of the root check. Expensive commands run through `heavy`; exit 75 means contention
and is retried. Oxlint runs type-aware correctness, anti-slop and size rules against a ratchet; Oxfmt is configured, and a repository-wide
reformat is still pending. Knip, jscpd, `tools/graph.ts` and the migration lock are repository gates. The lint baseline is
ratcheted downward or held, never weakened. Deployments, migrations and transactions
run deliberately and are never accepted from a cached task result.

## Consequences

Every workspace can report its own check and test floor. CI and local runs use the same task graph, while shared-box
contention is visible as a retryable condition. The older toolchain record remains available for historical context.
