# Testnet demand bot (C2)

The crew explicitly migrated the original journal to G1c and started the bot on
2026-10-05. The first prepared offer had no chain effect because the hosted response
omitted the inline manifest. DIRECTIVE 20:00 requires abandoning that expired offer
and releasing its reservation; Claude owns the reviewed source restart. There is
no automatic reset, replacement wallet, refill or deployment fallback.

The independent creator runs against `https://dev.sidequest.exchange`, Monad testnet
10143, using the current `main` v1 pair from `contracts/config/monad-testnet.json`.
It posts one quote request every 90 minutes, alternating public-safe geometric
images and small dependency-free code tasks. A missed interval produces one new
request, with no catch-up burst. Quote collection lasts 20 minutes, and the request's
quote deadline is 30 minutes after creation. Picking rechecks the clock after quote
validation and refuses at or after that deadline. Delivery lasts three hours.
Creator and worker bonds are zero. The review window is at least one
hour; dispute and arbitration windows follow the deployed minimum bounds.

The bot picks the cheapest valid registered-agent quote in mUSD, within available
funds and the **12 mUSD per UTC-day cap**. Equal prices break ties by quote ID.
Amounts use exact six-decimal integers. Every selected reward is reserved before
the hosted pick or payment. An unresolved reservation carries into each new UTC
day before fresh demand; the successful publication receipt determines the actual
spend day. Refunds do not reopen the budget. An unfunded or unmatched quote closes
that request without signing. The bot receives **50 mUSD and 0.5 MON** from the
configured ecosystem deployer once; setup retries retain the original amounts,
signed bytes and hashes. It needs no creator registration or SIDE stake.

Hosted request and pick calls use durable idempotency keys. The private journal
pins creator, contracts, token, cadence, cap and templates. It stores exact signed
transactions before broadcast and reconciles the original receipt before retrying.
The journal lock serializes setup and runtime. Setup also takes a deployer lock
and refuses unsaved funding when the deployer has another pending nonce. An
ambiguous send interrupts the tick before a fresh request or another signature.
Never delete or transplant a journal to recover an operation.

Before processing saved operations, the runtime checks request `fbf0e1288716ad34` / task
`5b6bb5e461f9e85f`, its exact 3 mUSD reservation, no board job, no signed operation
sends or receipts, and the independent EOA's zero latest/pending nonce and absent
account code. Under the journal lock it records `closed: abandoned` and releases
only that reservation. Any possible chain effect refuses reconciliation. The check
is idempotent, and the runtime never republishes the abandoned task. Claude stopped
the old container while retaining the journal; reconciliation runs on the reviewed
source restart. No competing journal edits are required.

For hosted URL-only preparations, the bot fetches the exact hash-addressed offer
from the configured board with no redirects, a 256 KiB limit and a 20-second timeout.
It checks the hash of the response bytes and saves the manifest under the existing
operation before validation. Inline manifests receive the same size and hash checks.
Before signing, the bot verifies the canonical manifest, its terms hash, deployment,
chosen quote, zero bonds, deadlines, explicit arbitrator, deliverable/check policy
and absence of an execution budget. It permits only an exact mUSD approval to
Holding followed by the exact `publish`. The receipt's Holding event pins the job
ID. Selection is signed locally only for the saved worker, registered agent,
job and terms. Review verifies the onchain provider and `JobSubmitted` receipt.

Approval requires an automated check of that exact submission:

- Images: immutable public raw GitHub URL in `grmkris/sidequest-demo-deliveries`,
  bounded fetch without redirects, matching SHA-256, and PNG/JPEG structure.
- Code: the exact public repository and immutable 40-character commit SHA; the
  newest matching GitHub Actions check named `test` must have completed with
  `success`. Submitted code is never executed by the creator.

Failed, missing, rate-limited or unavailable checks leave the review untouched.
The bot never rejects automatically and never finalizes silence itself. Protocol
windows and permissionless actors decide those jobs. Hash and CI checks establish
integrity and test outcome; they do not establish a human judgment of image quality
or code usefulness.

## Setup and operations

Run from the repository root with pnpm:

```sh
pnpm exec bun packages/sdk/scripts/demand-bot.ts setup
pnpm exec node scripts/demand-bot.mjs prepare
pnpm exec node scripts/demand-bot.mjs spec
pnpm exec node scripts/demand-bot.mjs status
```

Setup creates `DEMAND_BOT_PRIVATE_KEY` and `DEMAND_BOT_ADDRESS` in `.env.local`
without printing the key. Re-running setup reconciles the original sends and does
not refill a spent wallet. The private journal and sanitized status live under
`.crew/demand/` (0700 directory, 0600 files, gitignored). The private environment
file `.crew/demand.env` contains only the demand key and testnet RPC URL; it never
includes DEPLOYER, other worker keys, GitHub credentials, or cliproxy credentials.

**Claude owns starting the container after `READY-C2`:**

```sh
pnpm exec node scripts/demand-bot.mjs start
pnpm exec node scripts/demand-bot.mjs status
pnpm exec node scripts/demand-bot.mjs stop
```

Container `sidequest-crew-demand` uses Docker bridge `sidequest-crew`, publishes no
ports, has `--memory 2g` and `--restart unless-stopped`, and runs as the host UID/GID.
Source is an immutable git archive labeled with its commit; dependencies and Bun
are read-only mounts. The journal is writable at `/state`. It uses the existing `aj-worker`
image, needs no model/provider service and never mounts the host `.env.local`.
Stop retains its journal. Signals stop scheduling new work while allowing a
durable current step to finish; Docker waits 180 seconds before terminating it.
`status.json` has the creator, funds, cap accounting, operation IDs, review result
and heartbeat. No private signed bytes are included.

To update source, stop and explicitly remove the old container (without deleting
`.crew/demand`), review/commit the change, then start. A routine restart preserves
the existing immutable container. The standalone launcher is the integration
point for the crew agent's `scripts/crew.mjs` start/stop/status wiring; build does
not edit crew-owned files.

## Verification

The SDK policy tests cover deadline boundaries, strict decimals, cheapest valid quote, cap exhaustion,
UTC rollover and receipt reconciliation, immutable artifact URLs and newest-check
selection. Real local HTTP tests exercise URL-only preparation, byte-hash verification,
durable save-before-validation, bounded streams, timeouts and redirect refusal.
Filesystem regressions cover abandonment, carried reservations and refusal of
ambiguous effects. A real local Monad fork with an in-memory board database exercises
quote-to-hire, poisoned calldata refusal, a crash after persisting publication,
next-day recovery with the same transaction hash, selection, activation and accept.
The new script has a separate typecheck config because adding existing tsconfig
includes is outside the new-files-only scope:

```sh
heavy pnpm exec tsc -p packages/sdk/scripts/demand-bot.tsconfig.json
heavy pnpm check
```

SDK and board fork suites require the private testnet RPC environment and run
through `heavy`. Live funding and read-only board authentication are setup evidence;
they do not prove an always-on demand flow. The first request, worker quote,
delivery and approval are live evidence only after Claude starts the container.
