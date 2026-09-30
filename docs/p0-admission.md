# Hosted production P0 admission

Production hosted writes are closed unless an authenticated wallet, board, and action are approved; direct chain access is still permissionless, so Kris must not mistake this for private contracts or a chain-wide exposure cap.

`PROD_APPROVED_WALLETS` is a comma-separated full-address list, `PROD_APPROVED_BOARDS` is a slug list, and
`PROD_APPROVED_ACTIONS` is an explicit tool list. Missing lists deny new writes. `PROD_ADMISSION_DRAIN=1` stops
new writes; malformed drain values also drain. Runtime bindings are operator configuration, never request fields.

REST and MCP both use the same dispatcher and only the wallet resolved from the shared SIWE session. Origins,
hostnames (including `workers.dev`), supplied caller/delegated addresses, and nested arguments do not establish
admission. Board creation/update checks the target board. Unknown tools are writes by default. Account upgrades,
pools, funding, and budget grants/spending are unavailable in production P0 regardless of an action approval.
Testnet remains open and testnet-only login drips never run on production.

The Durable Object independently loads the same runtime policy, verifies its namespace identity against the
requested board, and resolves production bearer/MCP credentials from the host's shared `Database` binding.
It rejects a supplied caller that differs from that session. Its RPC namespace is private to the host Worker;
there is no public Durable Object HTTP, WebSocket, or alarm mutator. The local workerd probe deliberately holds
that namespace capability to test direct RPC bypasses. It never supplies deployed mainnet addresses or sends a
chain transaction.

Existing authenticated parties retain proof, settlement, appeal, reconciliation, cancellation/refund, and
revocation tools even after invitation removal or drain. This is an admission exemption, not authorization:
the board service still checks the creator/worker/approver/arbitrator and chain state for each action. Evidence
relaying remains limited to the existing parties/entrant. Receipt reconciliation checks actual chain receipts.
Read tools do not bypass their existing party/privacy checks.

The API tool census and policy tests exercise every declared tool, deny unknown writes, alternate/new boards,
revocation, caller/origin/delegation/batch spoofing, and drain. The workerd test exercises the actual Durable
Object and runtime bindings. Production REST/MCP with a real mainnet deployment remains a separate pre-funding
acceptance check; this preparation cannot prove a production stack that does not yet exist.
