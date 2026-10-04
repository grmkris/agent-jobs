# P1 clean break

The [sanitized inventory](inventory.json) identifies the existing management and sponsor objects. Live DO rows
remain unknown; the existing Worker offers owner-scoped reads only. Direct chain reads at block 68224648 confirm
Kris's test wallet has 1 MON, 100 FACTORY, 2 mUSD, no stake, and no jobs in the public index. An unauthenticated
`sponsor_status` request for Kris's operator returns 401, because the existing tool requires its wallet session.

The companion, runtime pairing/health/gateway, browser wallet selection, four-transfer funding and browser-agent
approval execution are deleted. The old management, OAuth and MCP transports and their UI are deleted along
with them; P3–P5 build the replacement. Operator-only Privy login, normal wallet REST tools, directory discovery,
and operator sponsorship remain. No release occurs during this temporary gap.

An atomic schema-version transition drops the old fleet/OAuth tables and `sponsor_grants` once. New operator grants
use the hash-keyed `grants` table. `sponsor_operations`, `sponsor_replacements` and `relay_operations` are retained
unchanged, including their signed bytes, hashes and nonce reconciliation. A missing old grant stops fresh redemption;
it does not erase a pending send. The migration test proves preservation, restart idempotency and rollback on failure.

Validation: `heavy pnpm check` passed, including typecheck, tests and lint. The real Monad fork sponsorship suite
passed all nine cases against the new grant storage. The migration was exercised only locally; no deployed DO
schema, site or on-chain permission was changed. Live P0 evidence remains in [README.md](README.md).
