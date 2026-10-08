# Sidequest v1 contract surface

This document describes the only supported protocol surface. The v1 deployment is a fresh ERC-8183 core, one
`SidequestHolding`/`SidequestEvaluator` pair, and the SIDE v2 token. The `legacy-final` tag preserves the retired protocol.

## Core contracts

- `SidequestHolding` is the ERC-8183 client. It publishes fixed-reward hires, reserves creator and worker SIDE
  stake in `StakeVault`, activates a signed selection, accepts top-ups, and settles the reward or refund. A refused
  token transfer becomes an `owed` balance that can be withdrawn separately.
- `SidequestEvaluator` is the per-offer evaluator. The approver accepts or rejects, an arbitrator rules during the
  frozen appeal window, and permissionless timeouts settle silence, missed delivery, and arbitration expiry. It records
  evidence and feedback without allowing a classifier to move money.
- `StakeVault` tracks delegated SIDE shares and reservations. `reserve` requires an admitted Holding; `release`, `slash` and treasury `forfeit` consume only the caller's own reservations; unstaking uses a fourteen-day production cooldown and Holding admission uses its timelock.
- `Factory` is SIDE v2: a fixed one-billion supply, ERC-20 permit support, and burn with no mint or admin hook.
- `FeeSchedule` supplies the worker's fee rate and treasury address; schedule changes have a three-day notice.
  `SidequestHolding` pays earned-work fees and never-activated creator-bond forfeitures to the current treasury.
- `TeamVesting` releases the fixed team allocation after its configured cliff and duration.
- `EpochDistributor` and `MiningReserve` distribute posted Merkle roots into stake. Mining is a funded, permissionless
  claim path and makes no promise of earnings.
- `SeedHelper` is the one-shot SIDE/USDC liquidity helper. `TestnetFaucet`, `BlocklistUSD`, and `GasBurnerUSD` are
  testnet-only fixtures. The faucet constructor and odd-token deployment script refuse chain 143.

## Hire lifecycle

`publish` escrows the reward and reserves the creator bond. The selected worker calls `activate`, which verifies the
creator's EIP-712 Selection, registered ERC-8004 wallet, frozen terms, and worker bond before funding the core with the
quoted net reward. The worker submits once. Acceptance, rejection, ruling, or a timeout records the outcome before core
settlement. `settle` releases or burns due reservations and pays the recorded beneficiary; payout failures remain owed.
Every publish requires at least the live creator-bond floor (initially 10 SIDE testnet / 10,000 mainnet). The Safe
can adjust it up to the immutable 1,000 / 100,000 SIDE cap. New listings snapshot `publishedAt` and the unfilled
forfeit rate (initially 2500 bps, owner-adjustable from 0 to the constant 5000 bps cap). Cancellation before
`publishedAt + CANCEL_GRACE` (600 seconds) releases all backing. Never-activated cancellation after that boundary,
or expiry regardless of grace, forfeits `creatorBond * snapshotBps / 10_000` rounded down to the current treasury.
`BondForfeited` records the transfer; `BondReleased` records the remainder. This is the explicit exception to HR-001;
activated jobs still release rather than burn at/after expiry. `StakeVault.forfeit` removes only this Holding's
reservation and pool assets without reducing SIDE supply, including pro-rata queued backing and empty-pool reset.
A core pause is recorded by `notePause` and excuses a deadline that falls inside the pause interval.

Review, dispute, and arbitration windows are frozen per offer. Silence after a timely finalized submission is acceptance.
A rejection penalty needs an undisputed window or arbitrator ruling. Missing delivery can settle permissionlessly after
its deadline. An arbitrator signature is portable EIP-712 data and may be relayed until the cutoff.

## Deployment recipe

`DeploySidequest.s.sol` reads the `sidequest` input block from `config/<network>.json`, deploys a fresh core and all v1
components, wires the evaluator and registries, bootstraps the Holding, funds mining, and transfers ownership to the Safe.
`PromoteSidequest.s.sol` verifies successful receipts and live wiring before writing `.deployment`; `SafeAccept.s.sol`
accepts the six ownership transfers. The core's `ADMIN_ROLE` and `DEFAULT_ADMIN_ROLE` are granted to the Safe and
renounced by the deployer in the same fresh deployment.

The input includes `safe`, `defaultArbitrator`, `margin`, `minimumCreatorBond`, `maxMinimumCreatorBond`,
`unfilledForfeitBps`, four fee thresholds and rates, three allocation addresses,
vesting parameters, mining genesis, and optional clock values. Mainnet requires the production clock tuple. The output
contains `core`, `factory`, `rewardTokens`, `sidequest` (block, safe, factory, vault, feeSchedule, distributor,
miningReserve, teamVesting, t0, clocks), and `main` (`kind: "sidequest-v1"`, factory, holding, evaluator,
`openTokens: true`).

The script sends four transactions from the seeder: deploy the `SeedHelper`, approve SIDE, approve USDC, and call
`seed()`. The helper initializes or repairs the target pool, mints the full-range position to the Safe, and clears its
allowances. `SeedPool.s.sol --sig "verify()"` reads the receipts and verifies the live owner, pool key, liquidity, and
allowances.

## Launch checks

`MainnetRunbook.t.sol` pins the launch order, RPC guards, Safe custody readback, mining signature checks, and script
existence. `LaunchLock.t.sol` checks that launch and rehearsal scripts take the lock before work and isolate forge logs.
The seed transaction count is pinned by `MainnetRunbook.t.sol`:

| step | txs |
| --- | ---: |
| SeedPool (helper, 2 approvals, seed) | 4 |

All contract tests under `test/sidequest/`, testnet fixtures, and the retained fork rehearsals exercise this v1 surface.
Fork tests are skipped when their RPC variable is absent. A local fork is not live deployment evidence.

## Settlement and authority

The vendored ERC-8183 core stores the provider, token, budget, and submission. Holding is the client and evaluator is
its terminal-call authority. `claimRefund` moves escrow back into Holding custody; it does not override a recorded
worker outcome. Core expiry includes delivery, review, dispute, arbitration, and margin so an early core refund cannot
remove payment or appeal rights. Evidence signatures authenticate an attestation and do not establish its truth.

Evaluator decisions survive a failed bounded core call. Collect calls `retryDeferred` followed by `settle`; a separate
`withdraw(token)` retries refused pushes. Hostile reward tokens cannot trap bonds: exact inflows, non-reentrancy, and
bounded pushes protect the settlement path. The quoted activation rate also applies to paid top-ups; refund outcomes
leave each contribution discoverable through `claimTopUpRefund`.

The Safe controls fee proposals, Holding admission/revocation, verifier configuration, default arbitrator, mining roots,
and reserve funding. The core admin can pause, upgrade, and withdraw escrow while paused. Pause and evaluator
`notePause` must be batched atomically by the Safe. The protocol therefore depends on these disclosed admin powers.

## Stake and fees

`delegate`, `delegateWithPermit`, and `delegateFor` mint a delegator's shares backing an account. Only the share owner
can request or cancel undelegation and withdraw after cooldown; queued shares remain exposed to pending reservations.
Slashing burns SIDE and changes every position's asset value pro rata. Admission has a fifteen-day notice, free exit has
a fourteen-day production cooldown, and callers can deny a Holding new reservations for their own account. Revocation preserves
settlement of existing reservations. See `test/sidequest/StakeVaultDelegation.t.sol`, `StakeVaultLedger.t.sol`,
`StakeVaultInvariants.t.sol`, and `Invariants.t.sol`.

`FeeSchedule` starts at 0 / 10k / 100k / 1M SIDE with rates 30 / 10 / 3 / 1 percent. The worker signs a core budget for
`net = reward - ceil(reward * feeBps / 10000)`, freshly quoted before activation. SIDE allocations are mining 500M,
treasury 200M, team vesting 150M, ecosystem 100M, and liquidity 50M. The configured beneficiary owns `TeamVesting`.
Tests: `test/sidequest/FeeSchedule.t.sol`, `Factory.t.sol`, `V1Activation.t.sol`, and `V1Lifecycle.t.sol`.

## Mining and testnet tokens

`MiningReserve.fund(epoch, amount)` funds an ended epoch within the cumulative fixed allocation schedule.
`EpochDistributor.setRoot(epoch, root, total, dataHash)` promises funded stake; a root may be replaced until its first
claim. `resizeRoot` cannot reduce below claimed amounts. A valid posted proof is required to claim and every claim
stakes through `vault.delegateFor(account, account, amount)`. The tree contains one aggregated leaf per account/epoch.
Production epoch zero is 72 hours; later epochs last seven days. See `test/sidequest/Mining.t.sol`.

`MockPaymentToken` has six decimals and open test minting. `BlocklistUSD` and `GasBurnerUSD` also have six decimals;
their owner can block transfers or consume gas at a recipient to exercise deferred/owed behavior. `TestnetFaucet.drip`
transfers funded SIDE and mints each payment token at most once per recipient per day. Anyone can request a drip for
another address; only its owner adjusts amounts or withdraws funds. Test tokens have no value. Tests are
`test/testnet/OddTokens.t.sol`, `TestnetFaucet.t.sol`, and `test/sidequest/V1ArbitraryTokens.t.sol`.

## Clock configuration and evidence

Production minimum review/dispute windows are one hour and arbitration is twelve hours; all three maxima are fourteen
days. Other production clocks are fourteen-day unstaking, fifteen-day Holding admission, three-day fee notice, seven-day
proposal grace, a three-day first epoch, and seven-day later epochs. Testnet may use the bounded faster tuple from its
config. `SidequestClocks` validates the whole tuple; no setter changes these immutable values. `ClockConfig.t.sol` and
`Clocks.t.sol` cover bounds and timing.

`test/sidequest/Recipe.t.sol` covers fresh-core roles, atomic setup, output shape, receipt checks, and idempotent
promotion. `Signatures.t.sol` checks EOA, ERC-1271, and EIP-7702 signatures. Retained optional rehearsals are
`test/fork/SidequestRehearsal.t.sol`, `SafeAcceptRehearsal.t.sol`, `SeedPoolRehearsal.t.sol`, `UniswapRouterSwap.fork.t.sol`,
`Erc8004Fork.t.sol`, and `Erc8004RolesFork.t.sol`. Only dated receipts in `../docs/reality-check.md` establish live flows.
