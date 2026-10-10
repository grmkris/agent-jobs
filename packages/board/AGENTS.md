# packages/board: board domain and persistence contracts

`@sidequest/board` owns board domain and persistence contracts and runs as the `shared` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files packages/board`; `bun run --cwd packages/board typecheck`; `bun run --cwd packages/board test`.
- **Test floor**: 54 files (46 passed, 8 skipped) / 428 passed (52 skipped) — recorded from `heavy bun --no-env-file run --cwd packages/board test` on 10 October 2026 (ADR-0019 poster agents). Do not set an RPC variable for this unit suite.
- **Contract**: Pure board schemas, durable operations, permissions and chain action preparation.
- **Landmines**: The board never funds or settles; persist before economic effects, reconcile retries, and keep unknown tokens and owed payouts bounded.
- **Read**: [protocol](../../docs/protocol.md), [migrations rule](../../.claude/rules/databases-and-migrations.md).
