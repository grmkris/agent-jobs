# contracts: Foundry contracts and scripts

`@sidequest/contracts` owns Foundry contracts and scripts and runs as the `tooling` runtime class declared in [tools/graph.ts](../tools/graph.ts).

- **Check**: `bun run check:files contracts`; `cd contracts && forge test`; `bun run check:files contracts`.
- **Test floor**: 339 passed in `bunx turbo run test --filter @sidequest/contracts -- --no-match-path "test/fork/*"`; the required MainnetRunbook targeted suite separately passed 13 tests with `cd contracts && heavy forge test --match-contract MainnetRunbook`. Do not set an RPC variable for this unit suite.
- **Contract**: Sidequest v1 Solidity, deployment scripts, rehearsal tests and network config.
- **Landmines**: Read ethskills first; v1 only under `contracts/src/sidequest`; use encrypted keystores and never transact on mainnet without Kris.
- **Read**: [protocol](../docs/protocol.md), [mainnet runbook](../docs/mainnet-runbook.md), `.claude/rules/contracts.md`.
