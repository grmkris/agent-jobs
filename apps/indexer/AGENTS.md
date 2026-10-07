# apps/indexer: hosted chain indexer Worker

`@sidequest/indexer-worker` owns hosted chain indexer Worker and runs as the `cloud` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files apps/indexer`; `bun run --cwd apps/indexer typecheck`; `bun run --cwd apps/indexer test`.
- **Test floor**: 1 file / 9 passed — recorded from `bunx turbo run test --filter @sidequest/indexer-worker`. Do not set an RPC variable for this unit suite.
- **Contract**: HyperSync/event ingestion, checkpoints, D1 folds and notification delivery.
- **Landmines**: Never infer live state from a local fold; keep checkpoint and migration writes idempotent and preserve `readReplication` settings.
- **Read**: [stages](../../docs/stages.md), [packages/indexer](../../packages/indexer/AGENTS.md).
