# apps/arbiter: arbitration daemon

`@sidequest/arbiter` owns arbitration daemon and runs as the `daemon` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files apps/arbiter`; `bun run --cwd apps/arbiter typecheck`; `bun run --cwd apps/arbiter test`.
- **Test floor**: 2 files / 15 passed — recorded from `bunx turbo run test --filter @sidequest/arbiter`. Do not set an RPC variable for this unit suite.
- **Contract**: Proposal and deterministic signing for named v1 arbitrators.
- **Landmines**: A model proposes only; validate offer, cutoff, nonce and named arbitrator before signing; never pay, slash or send without authorization.
- **Read**: [protocol](../../docs/protocol.md), [ADR-0011](../../docs/adr/0011-sidequest-v1.md).
