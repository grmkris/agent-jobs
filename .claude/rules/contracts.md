---
paths:
  - 'contracts/**'
---

# Solidity and chain operations

- Read <https://ethskills.com/SKILL.md> before writing Solidity or shipping anything on-chain. Monad reference: <https://docs.monad.xyz/llms.txt>.
- Preserve [protocol law](../../docs/protocol.md). V1 uses `contracts/src/sidequest/**` and the single `main` testnet pair of kind `sidequest-v1`.
- Any mainnet transaction needs Kris's explicit go. Sign only through encrypted Foundry keystores; never pass a mainnet private key in argv or `.env.local`.
- Addresses and network parameters come from `contracts/config/<network>.json`. A dry run never proves a live deployment.
- Use `heavy` for forge build/test; exit 75 means retry after contention clears, and never pipe it.
- Preserve the exact strings checked by `contracts/test/MainnetRunbook.t.sol` when changing the [mainnet runbook](../../docs/mainnet-runbook.md), and run its targeted test afterwards.
