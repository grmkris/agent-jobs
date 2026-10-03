# Testnet acceptance handoff — 3 October 2026

This continues conversation `01a101de-4982-7143-90c9-4311c28a3ccf`, whose local
source is `.codex/sessions/2026/10/03/rollout-2026-10-03T15-05-07-01a101de-4982-7143-90c9-4311c28a3ccf.jsonl`
under the user's home. The requested outcome was to take over the rate-limited
Opus coordinator, finish testnet end to end, support both website users and
external developers bringing ERC-8004 agents, and prepare for a small friends'
pilot. Mainnet deployment remains a separate decision.

## Recovered decisions and completed foundation

The original coordinator's D24 replaced the old G1 stack with G1b and short
**testnet** clocks. The normative v1 specification remains MyPlan note 17,
`doc_eea3BzAG1fugdaPf`, reflected in [ADR-0011](decisions/0011-hireling-v1.md).
The fast testnet clocks do not change the production specification's windows.

G1b is deployed and funded. Jobs 82–99 completed the contract flow matrix,
including paid work, silence, cancellation, both ruling directions, slashing,
refunds, top-ups, fee tiers, hostile reward payouts and legacy flows. Historical
G1b epoch 0 was separately funded and published; its worker claimed 5,250
FACTORY into stake. See [the dated receipts](reality-check.md).

Archive fixes were released from `c9f924c`. The approved indexer replay preserved
existing events and jobs, recovered all 16 G1b publications/settlements, retained
archived G1 v1 history and legacy jobs, and was followed by two successful cron
observations. This was checkpoint recovery, not a new chain deployment.

The last original-conversation handoff left website sends, a fresh worker crew,
real Privy login, human sessions and approval amount copy unverified. The user
then explicitly approved completing all remaining testing on **Monad testnet
10143**, including the related tmux cleanup.

## Current acceptance evidence

The [parity matrix](testnet-parity.md) distinguishes coordinator contract testing,
website testing with an injected provider, real worker artifacts, independent
arbitration, earned mining and human login. The
[acceptance receipt ledger](evidence/testnet-g1b/2026-10-03-acceptance.json) records
fresh canonical reads and excludes private journals, signing bytes and sessions.
The website sessions use `release1317560` and the current G1b addresses.

Pixel's UI hire is job 100; the unactivated cancellation fixture is job 101.
Ship, Quill and Mint's real worker jobs are 102, 103 and 104. Mint's separate
arbitration fixture is job 105 and reuses the same real weak artifact; it is not
a claim that a second worker generated new work.

Mint's original prepared ruling for job 104 remained unsigned when its cutoff
passed during sandbox network failures. The original proposal was preserved;
the job was closed by the explicit **arbitration timeout** refund path. Job 105
then independently established the model → deterministic validation → portable
signature → confirmed ruling → settlement path. The model chose a creator win
**without slash**. A planned burn is not evidence of an actual burn.

## Remaining acceptance and readiness work

- **Real Privy login and human pilot:** the automated browser injects EIP-1193 at
  the released Privy boundary. It does not establish Privy authentication or a
  friend's successful session. Follow [first-use](../apps/explore/docs/first-use.md)
  and the K6/K8 session sheets with the user's real wallet.
- **Approval amount copy:** the released confirmation says the agent receives
  the gross listing reward and its success toast repeats that amount. The
  confirmed worker receives the net reward; top-up net is collected separately.
  For a 1 mUSD reward and 0.5 mUSD top-up at 30%, the confirmed totals are
  1.05 mUSD to the worker and 0.45 mUSD to the treasury. Correct this display
  before inviting friends; these tests do not claim that a correction is live.
- **Credential security follow-up:** diagnostic outputs exposed credentials
  during this work. Coordinate rotation of affected testnet worker, cliproxy,
  Cloudflare and other exposed service credentials with their consumers. No
  shared credential was blindly rotated. Values are excluded from this handoff.
- **Mainnet:** production preflight, fresh role/key provisioning, mainnet core
  authority handoff, audited readiness and a mainnet opening are separate. No
  mainnet transaction or invitation was performed by this acceptance run.

Use the original journals to reconcile a lost response. Never republish a
completed job, replace a signed authorization, repeat an already-mined claim,
or treat an archived deployment's stake/fees as current G1b evidence.

Final live verification covers 55 successful unique receipts. Pixel, Ship and
Quill received 2.8 mUSD, treasury fees totaled 1.2 mUSD, and three creator
refunds totaled 3 mUSD. Epoch 5 completed with a 1,350 FACTORY Ship claim; its
final stake is 1,369 FACTORY. Repeating that claim in simulation returns
`AlreadyClaimed`. All acceptance-wallet reward owed balances and job bond
reservations are zero. Earlier C browser phases had transient 502 resource
errors; the final five-page read-only smoke passed without signatures or sends.
