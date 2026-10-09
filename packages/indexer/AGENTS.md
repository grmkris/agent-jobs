# packages/indexer: indexing and notification domain logic

`@sidequest/indexer` owns indexing and notification domain logic and runs as the `shared` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files packages/indexer`; `bun run --cwd packages/indexer typecheck`; `bun run --cwd packages/indexer test`.
- **Test floor**: 8 files / 50 passed (1 skipped) — recorded from `heavy bun --no-env-file run --cwd packages/indexer test` on 9 October 2026 (UX-03). Do not set an RPC variable for this unit suite.
- **Contract**: Network readers, event folds, checkpoints, feeds, webhooks and Telegram outbox logic.
- **Landmines**: Folds are additive and replayable; chain receipts outrank hosted records; Telegram delivery is at-least-once and claim-token guarded.
- **Read**: [apps/indexer](../../apps/indexer/AGENTS.md), [deploy](../../docs/deploy.md).
