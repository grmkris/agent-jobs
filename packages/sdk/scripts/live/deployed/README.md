# Deployed P8 fixture acceptance

This harness drives the real testnet website in Chromium and uses a real isolated
Codex as its hosted MCP client. Every result is **fixture**. It does not establish
genuine-user consent, wallet rotation or mainnet readiness.

Setup is the harness brief's frozen pnpm install, submodule initialization and
`heavy forge build` in `contracts`. Chromium must already be installed; set
`PLAYWRIGHT_CHROMIUM_PATH` if the box's default executable differs.

Anonymous smoke needs no credentials and may run before the v2 release:

```sh
heavy bun packages/sdk/scripts/live/deployed/smoke.ts
```

Full acceptance requires Claude's exact `RELEASED <full sha>` line in
`/home/kristjan/code/agent-jobs.wt/status/triage.md`. Read triage between steps for
coordinator directives. Source the existing environment only in the invoking shell:

```sh
set -a
source /home/kristjan/code/agent-jobs/.env.local
set +a
export P8_RELEASED_SHA=<full released commit>
export P8_RELEASE_STATUS_FILE=/home/kristjan/code/agent-jobs.wt/status/triage.md
export P8_RUN_ID=p8-fixture-20261005
export P8_GROK_AGENT_ID=<reviewed registered Grok demo worker ID>
pnpm live:deployed
```

Select individual cases with `pnpm live:deployed A01f`. Cases depend on the same
run's A01 agent, A02 job/earnings and A03 signed allowance calldata. Default order
is A01f, A02f, A03f, A04f, A05f, A07f, A08f, then A06f: revocation ends the client
connection. A03 proves the named-worker atomic publish; it does not wait for the
Grok supervisor to accept or deliver. Build owns the creator-list change; Claude
owns its coordination and restart. A01f appends `NOTE A01F-OPERATOR <address>` to
the sibling `status/harness.md` after verified onboarding, including retained proofs.

The required environment names are `MONAD_TESTNET_RPC_URL`, `PRIVY_TEST_EMAIL`,
`PRIVY_TEST_OTP`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_SIGNER_ID`,
`PRIVY_POLICY_ID`, `PRIVY_SIGNER_KEY`, and `TESTNET_CREATOR_PRIVATE_KEY`, plus the
selected Codex provider's environment key. They are never printed or copied into
artifacts. Only the selected provider tables are copied to a temporary Codex home;
user Codex and Claude configuration is untouched.

The fixture creator funds 40 mUSD of the configured testnet faucet reward into the
operator wallet for allowance tests. Reward-token amounts are separate from MON
costs. A shared private budget ledger charges gas and successful native transfers
for fixture wallets and **all** relay traffic observed since the run began,
including unrelated traffic. Reservations retain explicit gas, fee and native-value
bounds and refresh retry quotes without discarding unresolved costs. Direct signed
sends are checked before broadcast. Hosted/browser effects are accepted only after
their complete observed transaction set fits the reservation; those external sends
can be inspected only after broadcast. Every recorded receipt checks the cumulative
2 MON cap immediately. An unbounded or excessive external send blocks completion
and retains its reservation for reconciliation. This conservative account may block
before actual fixture-only spend reaches 2 MON. Do not reset the ledger to bypass a refusal.

A04's period/expiry proofs and A03's failed-publish rollback use real signed
browser grants and deployed bytecode on a local Anvil fork; evidence labels these
separately from live chain receipts. Each A05 denial records its enforcement layer
and path: `provider-policy` for direct policy probes, `provider-authorization` for
routine-quorum mutation/export refusals, and `hosted-application` for deployed
HTTP/MCP input refusals. Direct provider probes use the deployed-created wallet;
the hosted suite exposes no raw signing endpoint. A07 kills the real
Codex process after the server confirms an economic effect and before a durable
client result; its next process must recover the same operation ID and hash.
A06 aborts relay routes with Playwright, executes a real Privy-owner/RPC recovery
sweep, and checks receipt-confirmed disablement after restoring relay access.

Private browser state, OAuth credentials, exact intents, signed bytes, spend and
metadata-only client logs stay in ignored `packages/sdk/scripts/live/.local/deployed/`, with a
shared runner lock. Temporary Codex homes retain OAuth credentials for retries.
Never delete these records after an interruption. Rerun with the same release,
run ID and arguments; passed proofs are retained. A failed case stops the suite,
records sanitized blocked evidence, and retains pending reservations. Raw provider
and browser error text is suppressed. Missing services or changed UI block a proof.

Sanitized results are written to `docs/evidence/agent-first-v2/p8-A01f.json` through
`p8-A08f.json`, with source/release commits, network, fixture label, checks, receipt
hashes, gas and cumulative spend. The console reports cumulative MON and pending
reservations. No deployment or mainnet operation exists in the harness.

Run `heavy pnpm check` and the SDK/board fork suites with the sourced testnet RPC
before committing. Do not wrap the full live suite in `heavy`: its A08 mining gate
uses `heavy` internally. Run one acceptance runner at a time and keep Chromium,
Codex and Anvil cleanup enabled.
