# Hosted v1 admission

Mainnet hosted writes are open to every authenticated wallet and board from day one. There is no wallet,
board or action invitation list. Direct chain access remains permissionless. `PROD_ADMISSION_DRAIN=1`
stops new hosted writes; missing, empty or malformed drain values also drain. Only explicit `0`/`false`
opens deployment admission and runs the pinned production readiness gate. Runtime bindings are operator configuration,
never request fields. The obsolete `PROD_APPROVED_*` bindings are retained, empty and ignored, solely to
preserve existing staging bindings.

REST and MCP use the same dispatcher and only the wallet resolved from the shared SIWE session.
Origins, hostnames (including `workers.dev`), supplied caller/delegated addresses, and nested arguments
do not establish authentication. Unknown tools fail closed. Account upgrades and execution budget grants
and spending are enabled. Pool creation, pledging and launch remain disabled on mainnet. The board service
still checks parties and chain state for every action. Testnet policy is unchanged and login drips never
run on production.

Production writes have shared counters across every board, REST and MCP: 60 calls per wallet and 240 per
IP in a 60-second window starting with the first call. Account upgrades additionally allow three attempts
per wallet and twenty per IP in 24 hours. Refused calls do not debit other counters. Retries of attempted
writes count, including service-level failures. Read tools do not consume counters; sign-in challenge and
login consume IP counters (and wallet counters when already signed in). REST returns HTTP 429 with
`Retry-After`; MCP returns a `rate-limited` tool error. These limits are distinct from sponsorship's relay
balance floor and total daily cap.

The existing **Board** Durable Object namespace contains one reserved counter object,
`__hosted_admission_v1__`. It runtime-creates an additive SQLite counter table; no new binding keys,
Worker, Durable Object class or D1 migration are needed. Counter checks and updates run in one synchronous
storage transaction, survive object restarts, and prune expired rows. Wallets come from the shared D1
session store. The Worker supplies only Cloudflare's `CF-Connecting-IP`, never forwarded headers or tool
arguments. IPv6 is canonicalized and IPs are stored only as hashes. Missing IPs or unavailable counters
refuse writes. These checks currently apply to production; local/testnet behavior remains unchanged.

The board DO independently loads runtime drain policy, verifies its namespace identity, resolves credentials
from the shared `Database`, and rejects a supplied caller that differs from the session. Board tools consume
limits inside the DO so direct RPC cannot skip them. Worker-local registry tools, profile registration preparation and sign-in consume the same limits. Directory
prepare/submit tools derive their rate identity from the actual action/signed kind inside their own DO,
re-check shared sessions and runtime policy, and validate the canonical chain/registry/origin/agent object name. Its RPC namespace is private to the host Worker; there is no public DO
HTTP, WebSocket, or alarm mutator. Directory mutations are enabled behind these gates; their signed record remains the authority.

During drain, authenticated parties retain proof, settlement, appeal, reconciliation, cancellation/refund
and revocation paths, subject to the same short rate windows and service authorization. Read tools retain
their party/privacy checks. This emergency stop cannot change chain payment rights.

Unit tests cover the complete tool census, open admission, caller spoofing, drain, persistent counters,
wallet/IP scope and expiry. A local workerd integration exercises the actual DO, shared D1 sessions,
concurrent calls and direct RPC rejection without chain writes. Deployed production REST/MCP admission
and real mainnet integration require separate live evidence.
