# Production preflight

The proposed chain-143 recipe correctly refuses deployment today; Kris must complete custody, deployment, provider, Privy, and launch approvals before it can pass.

Run `bun scripts/preflight-prod.ts docs/p0-prod-artifact.json` for a no-secret-value structural check. Failure is
expected while provider chain proofs, Privy approval, and freshly deployed contract addresses are missing.
Malformed input produces a generic diagnostic rather than echoing JSON. A synthetic passing fixture proves
validation logic only; it is not live deployment proof or approval.

The Alchemy stack calls `assertDeployConfig` before any resources are evaluated whenever either `prod` stage or
`monad-mainnet` is selected. Both must be selected together, with `AGENT_JOBS_STAGE=prod`,
`ALCHEMY_REMOTE_STATE=1`, and an explicit `AGENT_JOBS_PROD_ARTIFACT` JSON path. There is no production local-state
fallback. The artifact checks network/chain 143, provider URL/chain metadata, approved Privy app and origin,
addresses matching the chain config, no faucet, zero hold gates, USDC, open-token main Holding metadata,
closed legacy flags, and the exact dedicated `HIRELING_PROD_*` secret source names. Deploy preflight also checks
the actual named sources, runtime Privy/HyperSync/RPC mappings, relay/attester public addresses, and read-only
RPC `eth_chainId`. No secret values are printed.

Do not copy testnet signing sources into those production names. Mainnet Worker bindings do not fall back to
generic testnet secrets. The API independently refuses a mainnet/non-prod runtime stage. R2 force-destroy is
disabled for mainnet. Explore uses the dedicated production Privy mapping.

Still required before launch: independently verify actual HyperSync network, deployed code/bytecode hashes,
immutable roles, windows, fee settings, provider/domain mappings, D1/DO/R2 policies, and mainnet read-only
`protocol_info`. An artifact's chain/approval fields are assertions to review, not a substitute for those live
checks. Every production deployment, domain change, and mainnet transaction needs separate authorization.
