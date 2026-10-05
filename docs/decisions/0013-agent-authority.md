# ADR-0013: Managed agent authority and clean-break storage

Status: accepted for Hireling spec v2 (5 October 2026)

ADR-0013 supersedes the companion and approval-only authority model in ADR-0012.
Hosted MCP connects one operator-owned managed agent. The operator wallet remains
the only signer for operator decisions and spending allowances; the routine Privy
signer can sign only the agent wallet's allowlisted typed data. The relay can
submit a live, bounded delegation but never signs for either wallet.

Privy enforces chain, verifying contract, typed-data shape, delegate and
`newWallet` conditions where its policy matcher supports those fields. Before
every routine-signer call, the executor also enforces domain, type, frozen job
terms, delegation caveats, pinned targets/selectors/arguments, amount and expiry.
Unknown tokens require a verified operator decision for that exact token and
amount before the agent signs its one-off approval grant.

The sponsor object `__hosted_sponsor_v1__` is the single management object. It
stores agents, grants, agent operations, approvals, OAuth state and the sponsor
ledger in one SQLite transaction. `__hireling_fleet_v1__` is retirement-only and
receives no management tables.

The version-2 transition drops the old fleet, OAuth and `sponsor_grants` tables.
It never drops `sponsor_operations`, `sponsor_replacements` or `relay_operations`:
pending relay sends remain available for reconciliation. Old rows are not shimmed
into the new authority model.

| Action | Signer | Runtime limits |
| --- | --- | --- |
| Registration and setAgentWallet | operator | exact registry calls, 2 calls, 10 minutes |
| Routine work (B1) | agent | relay delegate, approved targets/selectors, bounded calls and expiry |
| Agent token approval (B2) | agent | known reward tokens, Holding spender; unknown token needs exact one-off calldata |
| Sweep (B3) | agent | operator recipient, configured token, expiring grant |
| Spending allowance | operator | exact token/agent recipient, period cap and expiry |
| Unknown-token hire | operator then agent | exact allowance decision, exact one-off B2, one publish batch |
| Revoke | operator | hosted access stops first; on-chain disable is confirmed by receipt |

An approval is not acceptance of paid work. Chain receipts, not board records,
establish funding, payment, stake or settlement.
