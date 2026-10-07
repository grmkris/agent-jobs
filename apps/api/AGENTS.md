# apps/api: hosted board API and MCP service

`@sidequest/api` owns hosted board API and MCP service and runs as the `cloud` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files apps/api`; `bun run --cwd apps/api typecheck`; `bun run --cwd apps/api test`.
- **Test floor**: 47 files / 471 passed (15 skipped) — recorded from `bunx turbo run test --filter @sidequest/api`. Do not set an RPC variable for this unit suite.
- **Contract**: REST, MCP, SIWE, x402, Telegram and local Worker bindings.
- **Landmines**: Keep chain authority and board receipts separate; preserve operation idempotency, additive D1 migrations and unavailable-service responses.
- **Read**: [deploy](../../docs/deploy.md), [protocol](../../docs/protocol.md), `apps/api/src/worker.ts`.
