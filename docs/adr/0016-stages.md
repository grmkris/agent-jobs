# ADR-0016: Dev and prod stages; prod on testnet until the mainnet gate

Date: 2026-10-07. Status: accepted.

## Context

Sidequest needs a stable public origin while the contracts, hosted board and operator evidence remain testnet-only. A
retired staging release system and legacy protocol pairs must not be mistaken for current deployment state.

## Decision

`dev` is `https://dev.sidequest.exchange` on Monad testnet (chain 10143), and `prod` is
`https://sidequest.exchange` on the same testnet until the A01–A08 acceptance and launch evidence are complete. Work is
merged on `dev`; an accepted SHA is promoted manually to `prod` with Kris's explicit approval. The profile in
`infra/<stage>.json` owns origin, network, relay, bot and resource names. Both stages use the shared remote Alchemy state
store and release guard. A later mainnet cutover changes the prod stage and contract config together, followed by a
fresh guarded deploy and live readback.

## Consequences

Public prod can exercise the same v1 code path without claiming mainnet readiness. Deploy commands have a clear approval
boundary, and old staging names or legacy pairs cannot enter current documentation. Local work remains isolated under the
`local` stage.
