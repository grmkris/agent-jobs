# ADR-0011: Hireling v1 contracts

Date: 2026-10-02. Status: **implemented and unit-tested (C1–C7); not deployed**. The recipe, the fork rehearsal and the audit pass follow in
C2–C9 (`~/code/agent-jobs.wt/briefs/plan.md`). Decided in myplan note 17 (`doc_eea3BzAG1fugdaPf`, rev 8) and the
v1 build plan. Supersedes the contest parts of ADR-0004 and ADR-0007 for new jobs; the legacy pairs keep them.

## Context

The 2 Oct ethskills review found two High findings in `JobPool` (H1: a curator-signed permit drains pledges; H2:
`reclaimHold` sweeps the whole FACTORY balance) and four Medium findings in the pair (M1: a reward-token hook can
recover the creator bond before a ruling's burn; M2: a token that refuses the worker blocks a ruling for the worker
and the timeout then refunds the creator; M3: anyone can front-run `publish` with a copied `policyHash`; M4: a reward
owed to a pool can never be withdrawn). Note 17 also drops contests, adds per-offer windows and arbitrators, platform
fees by staking tier, top-ups instead of pools, a fixed-supply FACTORY with a staking vault that holds every bond,
and Merkle work mining. Mainnet launches on 9 Oct with these contracts, all or nothing.

The legacy `JobHolding`, `JobsEvaluator` and `JobPool` are byte-for-byte unchanged: their ABIs, the legacy test
suite and the indexer's decoding of the live testnet pairs depend on them. Every v1 contract is a new file in
`contracts/src/hireling/`, against interfaces in `contracts/src/hireling/interfaces/` that freeze at F0 (3 Oct 20:00).

## Decision

### One pair, no contests, per-offer terms

- `HirelingHolding` + `HirelingEvaluator` replace the main, demo and fast stacks. There is no `Mode`, `Candidate`,
  `award`, `expireContest` or `completeAward`, so nobody can create a contest on the v1 pair, even by a direct call.
  Discovery is request → quotes → selection off-chain; on-chain every job is one hire.
- Each offer sets its own `reviewWindow` and `disputeWindow` (1 h–14 d) and `arbitrationWindow` (12 h–14 d), and its
  own `arbitrator` (zero = `defaultArbitrator`). All are frozen into the listing at publish and are part of the terms
  the worker activates against. The evaluator reads them through `termsOf` everywhere; it has no window of its own.
- `publish` refuses an arbitrator equal to the creator or the approver, and requires
  `expiredAt ≥ deliveryDeadline + review + dispute + arbitration + margin` so the core's own expiry can never
  pre-empt a settlement still in progress.
- `activate` refuses a worker who is the listing's creator, approver or arbitrator. The plan named the approver and
  arbitrator; the creator is added because it is the same conflict (the approver defaults to the creator anyway).
- `defaultArbitrator` is settable by the owner (the Safe, `Ownable2Step`), not immutable: it is resolved and stored per
  listing at publish, so changing it never touches a live job, and arbiter keys may need to rotate.
- The EIP-712 domains ("AgentJobsHolding" / "AgentJobsEvaluator", version "1") and the `Selection`, `Ruling` and
  `EvidenceAttestation` type strings are unchanged. `verifyingContract` separates the pairs, so the SDK's
  `typed-data.ts` signs for v1 unchanged.

### The review fixes

- **M1, ruling order.** Every terminal path in the evaluator runs: checks → record `outcome` and `slashed` → emit →
  slash the loser's bond → release the other bonds → core call → feedback. A hostile reward token that re-enters
  `HirelingHolding.settle` during the core call finds both bonds already settled, and `settle` itself consults
  `creatorPenaltyDue` and `workerPenaltyDue`, so even a re-entry before the slash would slash rather than release.
- **M2, `_payWorker`.** Accept, silence and a ruling for the worker `try core.complete`. On failure the evaluator sets
  `payoutDeferred`, emits `PayoutDeferred`, and `try core.reject("payout-deferred")` so the net reward lands in Holding;
  if that fails too, the core's permissionless `claimRefund` brings it there after expiry. `earnedByWorker` is true
  for a deferred payout and for an `Accepted`, `Silence` or `RuledForWorker` outcome, so `settle` pays the worker or
  records the amount as `owed`. Gas starvation of the inner call changes only the route, never the payee. A ruling for
  the creator tries `core.reject` the same way. If the core is paused the whole call reverts instead, so a pause never
  turns into a deferred payout. Once an outcome is recorded every other terminal path reverts (`AlreadyResolved`); the
  arbitration timeout reverts `AlreadyRuled`, so a deferred ruling for the worker can never become a refund.
- **M3.** `policyListed` is keyed by creator and hash. A copied hash published by someone else no longer blocks the
  real creator; a creator still cannot fund the same offer twice (R114-07).
- **H1, H2, M4** go with `JobPool`, which has no v1 successor. Top-ups replace it.
- **Ruling nonces** are per arbitrator (`rulingNonceUsed[arbitrator][nonce]`), since arbitrators are now per offer and
  one arbitrator's nonce must not burn another's.

### Fees and top-ups

- `FeeSchedule` maps the worker's stake to a rate: thresholds 0 / 10k / 100k / 1M FACTORY at 30 / 10 / 3 / 1 %, the
  treasury Safe as recipient. The Safe retunes it through `propose` → `execute` (anyone, after 3 days) → `cancel`. A
  proposal needs a zero first threshold, strictly ascending thresholds, rates ≤ 3000 bps that never increase, and a
  nonzero treasury. Four tiers, fixed-size arrays: a bounded loop and a simple ABI.
- At `activate`, Holding snapshots `feeBps = feeSchedule.feeBps(vault.stakeOf(worker))` (reservations included,
  cooldown excluded) and `fee = reward · feeBps / 10 000`, and funds the core with `net = reward − fee` only. The
  worker's `SetBudgetAuthorization` names `net`, so its signature pins the fee it agreed to; `quoteActivation` tells it
  the number. A schedule change never touches a live job. The core's own fee stays 0.
- Holding keeps the fee until `settle`: to the treasury when the worker is paid, back to the creator on a refund.
  `FeeCharged(jobId, token, worker, creator, amount, bonusPart)` is emitted on a paid settlement and is the input to
  mining. The treasury is read at payout time.
- `topUp` lets anyone add a bonus in the reward token after activation, while the core job is Funded or Submitted. The
  bonus pays the worker with the reward at the same rate (`bonusFee = bonus · feeBps / 10 000` to the treasury), or is
  refundable per contributor with `claimTopUpRefund` (pull-based; anyone may trigger it, the money goes to the
  contributor). The worker agreed to "at least the reward"; the bonus sits outside the signed terms.
- Every outflow (worker, treasury, creator, contributor) is a push with a fixed gas budget (`TRANSFER_GAS` = 300k,
  reading at most 32 bytes back) and falls back to `owed[token][account]`, withdrawn with `withdraw(token)` (no gas
  cap). A refusing, reverting or gas-burning token never blocks bonds or other payees. The caller must leave room for
  the full budget (`TransferGasTooLow` otherwise), so starving the call cannot push an honest payee into `owed`.
- Accepted griefing vector: anyone can `stakeFor` a worker just before its activation and move it to a cheaper tier;
  the worker's budget authorization then names the wrong `net` and activation reverts until it re-quotes. It costs the
  griefer the gifted stake and harms no funds.

### FACTORY v2, the vault and mining

- `Factory`: ERC-20 + ERC20Permit + ERC20Burnable, 18 decimals. The constructor takes `(recipients[], amounts[])`,
  requires a sum of exactly 1e9 · 1e18, mints once, and has no owner: no mint, pause, blocklist or upgrade, so nobody
  can freeze stake or bonds. Allocation: mining 500M (`MiningReserve`), treasury 200M (Safe), team 150M (OZ
  `VestingWalletCliff`, parameters from config, default `start = T0 + 1 y`, duration 3 y), ecosystem 100M (Safe; the
  deployer on testnet), liquidity 50M (deployer, then the pool seed).
- `StakeVault` (`Ownable2Step`, owner the Safe; `ReentrancyGuardTransient`) holds all stake and every bond. A bond is a
  reservation, so no token moves at publish or activate: `reserve` (authorized Holding only), `release`, `slash`
  (burns via `Factory.burn`). A Holding can release or slash only its own reservations (`reservedBy`), so a revoked
  Holding still settles its live jobs and no Holding can touch another's bonds. `reserve(account, 0)` still checks
  authorization, so revoking a Holding is also the stop switch for its new listings and activations. Unstaking:
  `requestUnstake` (unreserved stake only; restarts the 7-day cooldown for the whole amount) → `withdraw`, or
  `cancelUnstake`. Holdings are authorized through `proposeHolding` → `acceptHolding` (anyone, after 8 days, longer than
  the cooldown) and removed instantly with `revokeHolding`. `bootstrapHolding` authorizes the first Holding without the
  delay, once, and only while nothing is staked. Invariants: `reserved ≤ staked` per account, `totalReserved ≤
  totalStaked`, balance ≥ `totalStaked + totalUnstaking`.
- `MiningReserve` holds the 500M and funds the distributor for epochs that have ended, capped so the total ever funded
  stays within the cumulative schedule (epoch 0: 72 h and W · 3/7; epoch k ≥ 1: a week and `W >> ((k − 1) / 26)`,
  W = 500M / 52). Unspent budget rolls over. The α = 0.5 cap on emissions against fee value is applied off-chain.
  The schedule sums to more than the reserve: `cumulativeBudget` converges to W · 3/7 + 26 · W · (1 + 1/2 + …) =
  500M + W · 3/7, so after about seven halving eras (about 3.5 years) it promises more than the 500M the reserve holds.
  The tail is simply truncated by the reserve's balance: `fund` reverts once the balance is spent.
- `EpochDistributor`: the Safe posts `setRoot(epoch, root, total, dataHash)` after the epoch ends, backed by funds
  already in the distributor and not promised to an earlier root. `claim` is permissionless and stakes straight into
  the vault with `stakeFor`. Leaves are OZ double-hashed `(epoch, account, amount)`. A root can be replaced only while
  nothing was claimed from it, so a wrong root is correctable and a bad one can drain at most its own funded total.

### Admin

Every owner is the Safe (`Ownable2Step`; the deployer hands over at the end of the recipe). The Safe's powers: the fee
schedule (3-day timelock), Holding authorization on the vault (8-day timelock, instant revoke), mining funding and
roots, the evaluator's verifier set, the default arbitrator for new listings, and the core's pause. None of them can
move escrowed rewards or reserved stake.

### Gas (Monad charges the gas limit)

Floors measured by `test/hireling/GasFloors.t.sol` (binary search for the smallest execution gas that succeeds, EVM
pricing, excluding the 21k intrinsic). They are dominated by the fixed reserves the contracts require: 315k per payout
push and 416k for the ERC-8004 feedback call. Monad prices cold state access above the EVM, so a client sets its limit
above the floor; the limits below are what the SDK and the relay should use (decisions D4, adjusted).

| Call | Floor (EVM) | Limit to send |
| --- | --- | --- |
| `HirelingHolding.settle`, worst case (2 bond releases, worker and treasury pushes) | 587k | 1,000,000 |
| `HirelingHolding.settle` after an accept (bonus and fee pushes) | 446k | 1,000,000 |
| `HirelingHolding.claimTopUpRefund` | 337k | 450,000 |
| `HirelingEvaluator.accept` / `completeAfterSilence` | 708k | 1,100,000 |
| `HirelingEvaluator.rule` (with a slash) | 732k | 1,100,000 |
| `HirelingEvaluator.ruleWithSignature` (with a slash) | 747k | 1,100,000 |

The evaluator limits are above D4's 900k because the 416k feedback reserve and the work before it leave little
headroom once Monad's cold-access pricing is applied; the C8 Monad fork rehearsal re-measures them.

## Consequences

- Indexers and the SDK choose the ABI per stack by `kind` (`hireling-v1` vs legacy). The provisional v1 ABIs are
  generated from the interfaces (`scripts/gen-abi.ts`: `hirelingHoldingAbi`, `hirelingEvaluatorAbi`, `stakeVaultAbi`,
  `feeScheduleAbi`, `factoryV2Abi`, `miningReserveAbi`, `epochDistributorAbi`) and switch to the implementations under
  the same names; legacy exports are untouched.
- Bonds require stake: a creator stakes before publishing a bonded offer, a worker before activating one.
- The vault is the highest-value contract and the focus of the C9 audit.
- Not in v1: contests, pools, x402, cross-chain FACTORY.
