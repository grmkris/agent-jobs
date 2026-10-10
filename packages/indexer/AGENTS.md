# packages/indexer: indexing and notification domain logic

`@sidequest/indexer` owns indexing and notification domain logic and runs as the `shared` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files packages/indexer`; `bun run --cwd packages/indexer typecheck`; `bun run --cwd packages/indexer test`.
- **Test floor**: 10 files (9 passed, 1 skipped) / 56 passed (1 skipped) — recorded from `heavy bun run check` on 10 October 2026 (seven-day completed counts for services). Do not set an RPC variable for this unit suite.
- **Contract**: Network readers, event folds, checkpoints, feeds, webhooks and Telegram outbox logic.
- **Landmines**: Folds are additive and replayable; chain receipts outrank hosted records; Telegram delivery is at-least-once and claim-token guarded.
- **Read**: [apps/indexer](../../apps/indexer/AGENTS.md), [deploy](../../docs/deploy.md).
