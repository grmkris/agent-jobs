# ADR-0011: Hireling v1 contracts

Date: 2026-10-02. Status: **implemented, unit-tested and fork-rehearsed on Monad testnet and mainnet (C1–C8); not
deployed**. The audit pass is C9 (`~/code/agent-jobs.wt/briefs/plan.md`). Decided in myplan note 17 (`doc_eea3BzAG1fugdaPf`, rev 8) and the
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
- **M2, `_payWorker`.** Accept, silence and a ruling for the worker `try core.complete{gas: CORE_GAS}` (300k). On
  failure (a refusing or gas-burning token, an expensive worker hook, a paused core), or when the core charges fees,
  the evaluator sets `payoutDeferred`, emits `PayoutDeferred`, and tries `core.reject("payout-deferred")` with whatever
  gas is spare so the net reward lands in Holding; otherwise the permissionless `retryDeferred` (or the core's
  `claimRefund` after expiry) brings it there. `earnedByWorker` is true for a deferred payout and for an `Accepted`,
  `Silence` or `RuledForWorker` outcome, so `settle` pays the worker or records the amount as `owed`. A ruling for the
  creator tries `core.reject{gas: CORE_GAS}` the same way. Before the core call the evaluator requires gas for the full
  `CORE_GAS`, the bookkeeping and the feedback (`CoreGasTooLow`), so a starved core call can never pass for a refusing
  token, and a gas-burning one consumes at most `CORE_GAS` and cannot roll the decision back (C9-001). Feedback is best
  effort. Once an outcome is recorded every other terminal path reverts (`AlreadyResolved`); the arbitration timeout
  reverts `AlreadyRuled`, so a deferred ruling for the worker can never become a refund, and `retryDeferred` only
  finishes the recorded outcome (C9-003).
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
  cooldown excluded) and `fee = ⌈reward · feeBps / 10 000⌉`, capped at `reward − 1` so `net ≥ 1` (C9 MATH-1), and
  funds the core with `net = reward − fee` only. The
  worker's `SetBudgetAuthorization` names `net`, so its signature pins the fee it agreed to; `quoteActivation` tells it
  the number. A schedule change never touches a live job. The core's own fee stays 0: `activate` refuses a core that
  charges one, and a fee set later routes the payout through Holding, so the worker is never charged twice and nothing
  strands in the evaluator (C9 ACL-5).
- Holding keeps the fee until `settle`: to the treasury when the worker is paid, back to the creator on a refund.
  `FeeCharged(jobId, token, worker, creator, amount, bonusPart)` is emitted on a paid settlement and is the input to
  mining. The treasury is read at payout time.
- `topUp` lets anyone add a bonus in the reward token after activation, while the core job is Funded or Submitted. The
  bonus pays the worker with the reward at the same rate (`bonusFee = ⌈bonus · feeBps / 10 000⌉` to the treasury), or is
  refundable per contributor with `claimTopUpRefund` (pull-based; anyone may trigger it, the money goes to the
  contributor). The worker agreed to "at least the reward"; the bonus sits outside the signed terms.
- Every outflow (worker, treasury, creator, contributor) is a push with a fixed gas budget (`TRANSFER_GAS` = 300k,
  reading at most 32 bytes back) and falls back to `owed[token][account]`, withdrawn with `withdraw(token)` (no gas
  cap). The push runs in its own call frame (`pushPayment`, callable only by Holding), which reverts unless the transfer
  clearly succeeded, so a token that moves the balance and then returns `false` is rolled back before `owed` records it
  (C9-002). A refusing, reverting or gas-burning token never blocks bonds or other payees. The caller must leave room
  for the full frame (`TransferGasTooLow` otherwise), so starving the call cannot push an honest payee into `owed`.
  `topUp` is refused once the evaluator has recorded an outcome.
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
  `cumulativeBudget` is therefore capped at 500M, so past that point `fund` reverts `ExceedsBudget` cleanly instead of
  failing a transfer (review C6-002). Both mining contracts take one explicit, nonzero `genesis` (the recipe's `t0`);
  there is no implicit "now", so they can never disagree on an epoch boundary (review C6-001).
- `EpochDistributor`: the Safe posts `setRoot(epoch, root, total, dataHash)` after the epoch ends, backed by funds
  already in the distributor and not promised to an earlier root. `claim` is permissionless and stakes straight into
  the vault with `stakeFor`. Leaves are OZ double-hashed `(epoch, account, amount)`. A root can be replaced only while
  nothing was claimed from it, so a wrong root is correctable and a bad one can drain at most its own funded total.

### Admin

Every owner is the Safe (`Ownable2Step`; the deployer hands over at the end of the recipe and the Safe accepts). The
Safe's powers: the fee schedule (3-day timelock), Holding authorization on the vault (8-day timelock, instant revoke),
mining funding and roots, the evaluator's verifier set, and the default arbitrator for new listings; none of these can
move escrowed rewards or reserved stake. On mainnet the Safe also holds the core's admin roles, which are broader:
pause, `emergencyWithdraw` while paused, the fee setters, the hook whitelist and the UUPS upgrade. Those can move escrow
and are disclosed as such; the README commits to no upgrade during an active agreement.

### Gas (Monad charges the gas limit)

Floors measured by `test/hireling/GasFloors.t.sol`: a binary search for the smallest execution gas that succeeds,
excluding the 21k intrinsic gas and calldata. `foundry.toml` sets `network = "monad"`, and a probe confirms the tests run
with Monad's opcode pricing (a cold account access costs 10,117, not 2,600), so these are Monad floors; the earlier
"EVM pricing" note was wrong. They are dominated by fixed reserves the contracts require: about 345k per payout push
(the `pushPayment` frame), and on every evaluator decision `CORE_GAS` (300k under the 63/64 rule) plus the 446k
feedback reserve. The limits below are what the SDK and the relay should send (decisions D4a); each covers the floor
plus intrinsic gas, calldata and a margin for state that is colder than in the tests.

| Call | Floor | Limit to send |
| --- | --- | --- |
| `HirelingHolding.settle`, worst case (2 bond releases, worker and treasury pushes) | 619k | 1,000,000 |
| `HirelingHolding.settle` after an accept (bonus and fee pushes) | 478k | 1,000,000 |
| `HirelingHolding.claimTopUpRefund` | 367k | 450,000 |
| `HirelingHolding.cancel` (core reject, bond release, reward push) | 523k | 700,000 |
| `HirelingEvaluator.accept` / `completeAfterSilence` | 987k | 1,200,000 |
| `HirelingEvaluator.rule` (with a slash) | 1,011k | 1,200,000 |
| `HirelingEvaluator.ruleWithSignature` (with a slash) | 1,035k | 1,200,000 |
| `HirelingEvaluator.rejectAfterDeliveryDeadline` | 1,034k | 1,200,000 |
| `HirelingEvaluator.retryDeferred` | 133k | 300,000 |

The evaluator limits rose from 1.1M because each decision now reserves the full `CORE_GAS` before the core call
(C9-001). A gas-burning token costs a decision no more than this: the core call is capped, the second core attempt
uses only spare gas, and `retryDeferred` finishes it later. The C8 fork rehearsals run a disputed hire on Monad
testnet and mainnet forks under these limits; the live `eth_estimateGas` in B11 stays the final check.

### Deploy

`script/HirelingRecipe.sol` runs in the plan's order as separate steps (core; vesting, Factory, FeeSchedule, vault,
Holding, evaluator; wiring; `bootstrapHolding`; distributor, reserve, the 500M; handover), every parameter from the
`hireling` config block and no predicted address: the deployer receives the mining allocation at genesis and forwards
it once the reserve exists. Staking stays closed until the bootstrap (C3-001), so nobody can force the launch onto the
8-day path. A reused core must charge zero fees, since Holding keeps the fee itself. The deploy has two steps (review
C8-001): `DeployHireling.s.sol` broadcasts and writes only a gitignored candidate, because forge runs it before anything
is sent; `PromoteHireling.s.sol` then proves the candidate on-chain (`HirelingVerify`: code, wiring, bootstrap, the
untouched reserve, one genesis, owners and core roles) and against forge's receipts, and only then writes `.deployment`
in the D1/D5 shape, with receipt block numbers. A dry run or a failed broadcast leaves the config untouched; promotion is
idempotent and refuses a config it cannot rewrite faithfully.

## Consequences

- Indexers and the SDK choose the ABI per stack by `kind` (`hireling-v1` vs legacy). The provisional v1 ABIs are
  generated from the interfaces (`scripts/gen-abi.ts`: `hirelingHoldingAbi`, `hirelingEvaluatorAbi`, `stakeVaultAbi`,
  `feeScheduleAbi`, `factoryV2Abi`, `miningReserveAbi`, `epochDistributorAbi`) and switch to the implementations under
  the same names; legacy exports are untouched.
- Bonds require stake: a creator stakes before publishing a bonded offer, a worker before activating one.
- The vault is the highest-value contract and the focus of the C9 audit.
- Not in v1: contests, pools, x402, cross-chain FACTORY.
