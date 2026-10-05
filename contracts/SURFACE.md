# The inherited surface

Every externally callable function of the vendored ERC-8183 core (`erc-8183/base-contracts` at
`142e669c1fd318486a4628395b629f033654dd06`), classified against our guarantees (spec §3–§4).

**Local patch (ADR-0010, 29 Sep 2026).** The payment-token allowlist is retired: `_setBudget` no longer checks it,
and `setPaymentTokenAllowed`, `allowedPaymentTokens`, `PaymentTokenAllowlistUpdated` and `PaymentTokenNotAllowed` are
gone. The mapping's storage slot stays, renamed private, so the UUPS layout is unchanged. Every other line is
upstream in `ERC8183.sol`. `fund` still refuses a short delivery (`UnexpectedFundedAmount`), and every entry point stays
non-reentrant.

**Local signature patch (30 Sep 2026).** `ERC8183WithAuthorization._useAuthorization`, Holding selections,
and evaluator rulings/evidence use `Signatures.isValid`: canonical low-s ECDSA recovery first, then ERC-1271.
Code on an EIP-7702 delegated EOA does not suppress its own raw signature. Contract wallets still use ERC-1271;
zero signers, malformed signatures, and wrong keys fail. This changes no storage layout. Unit and mainnet-fork
rehearsals cover the ordering; a fresh mainnet deploy remains separately authorized.
"Supported" is a path our SDK, MCP or contracts use. "Unavailable" is one nothing of ours calls, and
what happens if a participant calls it directly anyway. "Recovery rule" names the test that proves the
guarantee survives.

## Lifecycle

| Function | Who (core) | Ours | If called directly |
| :--- | :--- | :--- | :--- |
| `createJob` | anyone (caller = client) | Supported through `JobHolding.publish` only; the indexer lists only jobs whose client is Holding. | A job with another client is an ordinary 8183 job we ignore. |
| `setProvider` | client | Supported: `JobHolding.activate` (hire, the worker's own transaction) and `JobHolding.award` (contest, by the approver before the selection deadline); agent id required. | Unreachable: the client is Holding. |
| `setPayoutReceiver` | provider, Open | Unavailable. | The worker may route its payout elsewhere; money still only moves on `complete`. Harmless. |
| `setBudget` | provider, Open | Supported: inside `activate` and `award` through the worker's `SetBudgetAuthorization` (Holding fixes token and amount). | An authorization for another amount does not verify (`test_auth_workerCannotUnderfundThemselves`). |
| `fund` | client | Supported: inside `activate` and `award`, after the budget equals the listed reward. | Unreachable: the client is Holding. |
| `submit` | provider, Funded **or Open with budget 0** | Supported after activation. | A hire has no provider before activation, and activation funds in the same transaction, so there is no Open-with-provider window (`test_adversarial_noSubmissionBeforeActivation`). A contest entry is submitted inside `award`, after funding, in the same transaction. |
| `complete` | evaluator, Submitted | Supported: only `JobsEvaluator` (accept, silence, ruling). | Unreachable: the evaluator is our contract. |
| `reject` | client/provider when Open; evaluator when Funded/Submitted | Supported: `JobHolding.cancel` and `expireContest` (Open), the evaluator's terminal paths. | The provider may reject its own Open job: nothing was escrowed in the core; `withdraw` returns the reward and creator bond, `withdrawWorkerBond` the worker's. |
| `claimRefund` | anyone, after `expiredAt` (+1 h when Submitted) | Supported as the outage path: refunds land in Holding as custody, not entitlement; `JobHolding.settle` pays the reward to whoever `JobsEvaluator.earnedByWorker` names (an earned silence payment → worker, R114-03) and returns unsettled bonds (`test_R114_03_*`, `test_moneyPath_thirdPartyClaimRefund_settleReturnsEverything`). | Cannot pre-empt settlement: Holding requires `expiredAt >= deliveryDeadline + settlementWindow` (`test_adversarial_claimRefundCannotPreemptSettlement`). |

## Milestone claims (not a product feature)

| Function | Who | Ours | If called directly |
| :--- | :--- | :--- | :--- |
| `submitClaim` | provider, Funded | Unavailable. | A pending claim blocks the core's own `claimRefund`; `rejectAfterDeliveryDeadline` (a terminal `reject`) clears it and the refund proceeds (`test_adversarial_milestoneClaimCannotBlockRefund`). A later `submit` also clears it. |
| `settleClaim` | client | Unavailable; Holding exposes no path. | Unreachable (`test_adversarial_holdingNeverSettlesClaims`). |
| `approveClaim` | client or evaluator | Unavailable; neither contract exposes it. | Unreachable. |
| `rejectClaim` | client, evaluator or provider | Unavailable. | The provider withdrawing its own claim is harmless. |

## Authorization relay (`ERC8183WithAuthorization`)

Every `*WithAuthorization` executes as the EIP-712 signer; the relayer never holds authority. Replay,
expiry and wrong-signer cases: `test_auth_*`. Supported: `setBudgetWithAuthorization` (inside `activate` and `award`) and
`submitWithAuthorization` (inside `award`, and any relayer for a hire). The others are unavailable and, if used, fall under the same rows as their
direct counterparts. `cancelAuthorization` lets a signer burn its own nonce; harmless.

## Our own surface (v3, spike S7)

| Function | Who | Effect on money |
| :--- | :--- | :--- |
| `JobHolding.publish` | anyone holding >= `minHoldToPublish` FACTORY | Pulls the reward (any ERC-20, ADR-0010; it must arrive in full, else `RewardTokenShortfall`, `ArbitraryTokensTest`) and the creator bond (FACTORY: the immutable bond token, any plain ERC-20; a fee-on-transfer token reverts `BondTokenFeeOnTransfer` at the first bond, `BondTokenTest`). Stores the offer's `approver` (zero = the creator). Refuses a zero or already-listed `policyHash` (R114-07) and a contest with `workerBond > 0` (`ApproverTest`). |
| `JobHolding.activate(selection, creatorSig, budgetAuth)` | **the selected worker itself** (never relayed, R114-01) | Replaced `assign` + `postWorkerBond` + `fundAfterAccept` for hires. Checks the creator's EIP-712 `Selection` (signature, own nonce space, `activateBy` ≤ now allowed at the deadline, `activateBy` < delivery deadline, `termsHash` = listing's `policyHash`), `agentId` ≠ 0, `identity.getAgentWallet(agentId) == msg.sender` and the hold gate; then setProvider, pulls the worker bond, applies the worker's `SetBudgetAuthorization` for exactly the listed token and reward, funds. All or nothing; at most once per listing (`ActivationTest`, `AdmissionForkTest`). |
| `JobHolding.cancelSelection(nonce)` | creator | None; burns a selection nonce. |
| `JobHolding.award(jobId, candidate)` | the listing's approver, until `selectionDeadline` (allowed at it) | Replaced `select` + `postWorkerBond` + `fundAfterAccept`. Checks `getAgentWallet(agentId) == candidate.worker`, then setProvider → `setBudgetWithAuthorization` (exactly the prize) → fund → `submitWithAuthorization` (exactly the named deliverable) → `JobsEvaluator.completeAward`: the entrant is paid and the creator bond returns in one transaction, winner offline. Any failure reverts all; the contest stays open; at most once (`ContestTest`, `AdmissionForkTest`). |
| `JobHolding.cancel` | creator, **hire only, before activation** | `reject` while Open; nothing was in the core. A live contest cannot be cancelled (R16-02). |
| `JobHolding.expireContest` | anyone, after `selectionDeadline`, nothing awarded | `reject` while Open; prize and creator bond recoverable once through `settle`. An awarded contest cannot be expired. |
| `JobHolding.settle` | anyone | After a terminal core status: the reward still in Holding to the worker if `earnedByWorker`, else to the creator; an unsettled worker bond **burns if `workerPenaltyDue`** (missed delivery, undisputed violation), else returns; the creator bond returns; each amount at most once. Replaced `withdraw` / `withdrawWorkerBond` (R114-03). A reward the token refuses to send (a blocklist, a pause) is recorded in `owed` instead of reverting, so the bonds still settle (ADR-0010). |
| `JobHolding.withdraw(token)` | whoever is `owed` a reward | Sends every reward in `token` that `settle` could not send to the caller (`ArbitraryTokensTest`). |
| `JobsEvaluator.completeAward` | Holding only, inside `award` | `complete`, bonds back, feedback. |
| `JobHolding.burnBond` | evaluator only | Burns one side's bond on a final finding (sends it to `BURN_ADDRESS` `0x…dEaD`, so the bond token needs no `burn`): a ruling (`slashLoser`), an undisputed rejection naming a violation, a missed delivery. Holding records each bond's outcome (`creatorBondBurned`, `workerBondBurned`). |
| `JobHolding.returnBonds` | evaluator only | Returns unsettled bonds to their owners; idempotent. |
| `JobsEvaluator.accept` | approver | `complete`; refused while a dispute is open (`DisputeOpen`, R114-02). `dispute` requires a funded Submitted job. |
| `JobsEvaluator.earnedByWorker` / `workerPenaltyDue` | view | Read by `settle`: the silence right (funded, timely, unrejected, review over) and a due penalty (missed delivery past the deadline, undisputed violation past the filing window). |
| `JobsEvaluator.reject(jobId, violation, reasonHash)` | approver, **only until `submittedAt + reviewWindow`**, timely submissions only | None; records `violation ∈ {None, Quality, Falsified}` and opens the dispute window. After the cutoff silence is acceptance even if nobody called the timeout (R16-01). |
| `JobsEvaluator.rule(jobId, forWorker, slashLoser, reasonHash)` / `ruleWithSignature(Ruling, sig)` | arbitrator / anyone relaying the arbitrator's EIP-712 `Ruling` (deadline, nonce), **only until `disputedAt + arbitrationWindow`** | `complete` or `reject`; `slashLoser` burns the creator bond (bad-faith rejection) or the worker bond (violation upheld; refused if the rejection named `None`). After the cutoff only the refund timeout settles (R16-01). |
| `JobsEvaluator.attachEvidence` / `attachEvidenceDirect` | a registered verifier (signed / calling) | None. Per-verifier record with `submissionHash`, `policyHash`, `testedSha`, `validUntil`; policy must equal the listing's; same verifier + same digest is an idempotent no-op; two verifiers on one digest are both kept (R16-06/07). `EvidenceAttached` emits `digest`, `submissionHash`, `policyHash`, `testedSha`, `conclusion`, `validUntil`. |
| ERC-8004 feedback (inside every settlement) | evaluator, as client of record | None. Reason-aware tags `completed`, `not-delivered`, `rejected`, `rejected-quality`, `rejected-falsified`; **none on arbitration timeout** (`skip-arb`). Capped at 400k gas in `try/catch`; `FeedbackRecorded(value, tag)` or `FeedbackFailed`; a registry failure never reverts a payout (R16-10). A transaction whose gas cannot cover the whole cap reverts `FeedbackGasTooLow` instead, so estimation never settles on a limit that starves the feedback (found live: testnet jobs 12 and 34 paid with their first feedback lost; `test_expensiveFeedback_*`). |
| the four timeouts | anyone | `completeAfterSilence` (timely submissions only), `rejectAfterWindow` (**burns the worker bond** if the undisputed rejection named a violation), `refundAfterArbitrationTimeout` (never burns, no feedback), `rejectAfterDeliveryDeadline` = the missed-delivery burn (funded, no timely submission: refund, **worker bond burned**, creator bond back). |

## What S7 changed from v2 (47c4dd2)

The table above is the current surface (v3, ADR-0004, S7). Removed: `assign`, `select`, `postWorkerBond`,
`fundAfterAccept`, `withdraw`, `withdrawWorkerBond`, `creatorReject`. Added: `activate`, `cancelSelection`, `award`,
`settle`, `reject(violation, reasonHash)`, `ruleWithSignature`, `completeAward`, `earnedByWorker`,
`workerPenaltyDue`. Changed: `accept` is the approver's and refused during a dispute; the missed-delivery timeout and
an undisputed violation burn the worker bond (v2's "timeouts never burn" no longer holds); feedback is
reason-aware and skipped on arbitration timeout; `EvidenceAttached` carries every binding field; the CRE receiver
is Chainlink's `ReceiverTemplate`, pinned and ownerless after configuration.

## Admin (deployer EOA)

`pause`/`unpause`, `emergencyWithdraw` (only while paused), `setPlatformFee`, `setEvaluatorFee`,
`setHookWhitelist`, `batchDetachHook`, UUPS upgrade. Deployed by `script/Recipe.sol` from `config/<network>.json`
with fees 0 and no hook whitelisted; any ERC-20 can be a reward (ADR-0010), so there is no token knob. The testnet
core was upgraded in place by `script/UpgradeCore.s.sol`. `JobHolding.setHoldRequirements` and `JobsEvaluator.setVerifier` are the two admin
knobs of ours. The README names the admin and commits to
no upgrade during an active agreement. Pause blocks every lifecycle call above, including the timeouts,
so an outage promise made while paused is void; this is stated rather than mitigated.

## Views

`getJob`, `jobs`, `jobCounter`, `pendingClaimHash`, `submittedClaimHash`, `whitelistedHooks`, fee getters, `DOMAIN_SEPARATOR`, the typehash constants. Read freely; the
indexer builds Explore from events plus `getJob`.

# Hireling v1 (ADR-0011) — draft, frozen at F0 (3 Oct 20:00)

New contracts in `src/hireling/`, against the interfaces in `src/hireling/interfaces/`. The legacy pairs above are
unchanged and keep their jobs. Status: **implemented and unit-tested (C2–C7, `test/hireling/*`)**; not deployed. Testnet deploy is G1 (5 Oct). Every owner is the Safe (`Ownable2Step`); the deployer hands over at the end of the recipe.

## The core under v1

Same vendored core, same rows as above, with these differences:

| Function | v1 |
| :--- | :--- |
| `createJob` | Through `HirelingHolding.publish` only; `expiredAt ≥ deliveryDeadline + review + dispute + arbitration + margin`, from the listing's own windows. |
| `setProvider`, `setBudget`, `fund` | Inside `HirelingHolding.activate` only. The budget is **`net = reward − fee`**, not the reward: the worker's `SetBudgetAuthorization` names `net` (`quoteActivation`). Holding keeps the fee until `settle`. Core fees stay 0. |
| `complete` | Only `HirelingEvaluator`, wrapped in `try` and capped at `CORE_GAS` (M2, C9-001). On failure the evaluator calls `reject("payout-deferred")` if gas allows, else `retryDeferred` does later, and the worker is paid by `HirelingHolding.settle`. |
| `reject` | `HirelingHolding.cancel` (Open) and the evaluator's terminal paths. |
| `claimRefund` | The outage path, as before: the refund lands in Holding and `settle` pays whoever `earnedByWorker` names. |
| `award`, contests | Do not exist on the v1 pair. |

## HirelingHolding

| Function | Who | Effect on money |
| :--- | :--- | :--- |
| `publish(PublishParams)` | anyone | Pulls the reward (any ERC-20; must arrive in full, `RewardTokenShortfall`); **reserves** `creatorBond` from the creator's stake (no token moves). Checks window bounds (review and dispute 1 h–14 d, arbitration 12 h–14 d), arbitrator ≠ creator/approver (`ArbitratorConflict`), a future deadline, the expiry rule, and `policyListed[creator][policyHash]` (M3). Resolves `arbitrator = 0` to `defaultArbitrator` and freezes it. |
| `activate(sel, creatorSig, budgetAuth)` | the selected worker itself | Checks the `Selection` as the legacy pair does, the ERC-8004 wallet, and that the worker is not the creator, approver or arbitrator (`RoleConflict`). Refuses a core that charges fees (`CoreChargesFees`). Snapshots `feeBps` from `vault.stakeOf(worker)`, **reserves** the worker bond, funds the core with `net`. The fee rounds up but never takes the whole reward (`net ≥ 1`). |
| `quoteActivation(jobId, worker)` | view | `(feeBps, fee, net)` the worker's budget authorization must match. |
| `cancel(jobId)` | creator, before activation | `reject` on the core and settle in one transaction: reward back, no fee, creator bond released. |
| `cancelSelection(nonce)` | creator | None. |
| `topUp(jobId, amount)` | anyone, after activation while Funded or Submitted and undecided | Pulls a bonus in the reward token (must arrive in full). Refused once the evaluator recorded an outcome (`NotActive`) or if reward + bonus would overflow (`TopUpTooLarge`). |
| `claimTopUpRefund(jobId, contributor)` | anyone | After a refunded settlement: the contributor's top-ups back to the contributor (or `owed`). |
| `settle(jobId)` | anyone, after a terminal core status | The money table in `IHirelingHolding`: worker paid (fee + bonus fee to the treasury, `FeeCharged`), or reward back to the creator (bonus refundable per contributor). Bonds the evaluator did not settle: slashed if `creatorPenaltyDue` / `workerPenaltyDue`, else released. Every transfer falls back to `owed`. |
| `withdraw(token)` | whoever is `owed` | Everything owed in `token`. |
| `pushPayment(token, to, amount)` | **this contract only** (`OnlySelf`) | The payout push's own frame (C9-002): a transfer that moves the balance and then reports failure (`false`, short return data) reverts here, so `_pay` records `owed` only after the token's move rolled back. Each liability is paid or owed, never both. |
| `burnBond(jobId, side)` / `returnBonds(jobId)` | evaluator only, non-reentrant | `vault.slash` (burns) / `vault.release`. |
| `setEvaluator` (once), `setDefaultArbitrator` | owner | None; the default applies to listings published afterwards. |

Gas floors (Monad pricing, `GasFloors.t.sol`; send the ADR-0011 limits, not viem's bare estimate): `settle` 619k
worst case → send 1,000,000; `claimTopUpRefund` 367k → 450,000; `cancel` 523k → 700,000. Each payout push reserves its
frame (`TRANSFER_GAS` 300k for the token, about 345k in all) and reverts `TransferGasTooLow` rather than silently
falling back to `owed`.

## HirelingEvaluator

Same functions as `JobsEvaluator` minus `completeAward` and `settlementWindow`, with per-listing windows, approver and
arbitrator from `holding.termsOf`.

| Change | Rule |
| :--- | :--- |
| Order (M1) | checks → record `outcome`/`slashed` → emit → slash the loser → release the rest → core call → feedback. |
| `_payWorker` (M2, C9-001) | `try complete{gas: CORE_GAS}` (300k); on failure, or when the core charges fees, `payoutDeferred`, `PayoutDeferred`, and `reject("payout-deferred")` with whatever gas is spare. A ruling for the creator tries `reject{gas: CORE_GAS}` (`RefundDeferred`). The call must leave room for the full `CORE_GAS`, the bookkeeping and the feedback before the core call (`CoreGasTooLow` otherwise), so neither a starved nor a gas-burning core call can roll a decision back. A paused core defers instead of reverting. |
| `retryDeferred(jobId)` (C9-003) | anyone | For a recorded refund outcome, or a worker outcome whose payout was deferred, while the core job is Funded or Submitted: `core.reject` moves the reward to Holding (and closes any pending milestone claim); `settle` then pays under the recorded outcome. Never turns a worker outcome into a refund. Reverts if the token still refuses. |
| Core pause (C9 ACL-2, C9-007) | anyone: `notePause()` | Appends each pause to a history that is never overwritten (`pauseCount`, `pauseAt`; the Safe batches it with `pause`/`unpause`). `rejectAfterDeliveryDeadline` reverts `CorePaused` during a pause, and a delivery deadline inside any recorded pause (ends included; an unrecorded end counts as still paused) refunds the creator without the burn or feedback; `workerPenaltyDue` uses the same lookup. |
| `cancelRuling(nonce)` | an arbitrator | Burns one of its own ruling nonces, revoking a signed ruling not yet relayed. |
| Feedback | best effort | Capped at `FEEDBACK_GAS`; a missing budget or a registry failure emits `FeedbackFailed` (at most 32 bytes of revert data) and never undoes the decision. |
| Evidence | | An attestation that expires sooner than the stored one cannot replace it (`StaleEvidence`); an expiry above `uint48` is refused. |
| Decided once | With an `outcome` recorded, every other terminal path reverts `AlreadyResolved`; `rule` twice and the arbitration timeout after a ruling revert `AlreadyRuled`. |
| `ruleWithSignature` | Signed by the listing's arbitrator; nonces per arbitrator (`rulingNonceUsed[arbitrator][nonce]`). |
| Views for `settle` | `earnedByWorker` (deferred payout, an `Accepted`/`Silence`/`RuledForWorker` outcome, or the R114-03 silence right), `workerPenaltyDue`, `creatorPenaltyDue`. |
| Admin | `setVerifier` (owner). |
| Gas | Floors (Monad pricing): `accept`/`completeAfterSilence` 987k, `rule` 1,011k, `ruleWithSignature` 1,035k, `rejectAfterDeliveryDeadline` 1,034k, driven by the reserves for `CORE_GAS` and the feedback; send 1,200,000. `retryDeferred` 133k → 300,000. |

## StakeVault v2 (ADR-0014)

| Function | Who | Effect |
| :--- | :--- | :--- |
| `delegate(account, amount)` / `delegateWithPermit(account, amount, ...)` | any payer | Caller owns shares backing `account`; self-delegation names the caller. Permit front-running is tolerated when allowance remains sufficient. |
| `delegateFor(account, delegator, amount)` | any payer | `delegator` owns the minted shares; mining names `(account, account)`. |
| `requestUndelegate(account, shares)` | position owner | Queues owned active shares even while bonded; restarts the whole queue's cooldown (production 7 days, testnet 600 s). Queue stops counting for the tier/new bonds but remains slashable. |
| `cancelUndelegate(account)` / `withdraw(account)` | position owner | Restores queued backing / pays its current asset value after unlock. Withdrawal reverts `StillBonded(remaining, reserved)` if remaining assets do not cover existing reservations. |
| `poolOf(account)` / `positionOf(account, delegator)` | anyone | Pool assets, reserved, shares, queued shares, generation; position total/queued shares, unlock and generation. An old-generation position reads zero in the current generation. |
| `convertToAssets(account, shares)` / `convertToShares(account, assets)` | anyone | Full-precision floor quotes. Empty pools quote shares 1:1 and assets zero; the last redeemed shares receive all assets. |
| `stakeOf` / `availableOf` / `reservedOf` / `reservedBy` | anyone | Active total backing sets the fee tier; available is `max(active - reserved, 0)`; reservations are per account and per Holding. |
| `totalAssets` / `totalReserved` | anyone | Sum of pool assets, including queued backing / sum of reservations. No aggregate `totalQueued`; value each pool's queue at its current price. |
| `reserve` | authorized Holding | Reserves active unreserved backing; zero still checks authorization. Account-owned veto remains (`HoldingDenied`). |
| `setHoldingDenied(holding, denied)` | backed account | Vetoes new bonds for that account; existing reservations still settle. Delegators do not control the backed account's veto. |
| `release` / `slash` | the Holding that reserved | Up to its own `reservedBy`, even after revocation. Slash burns assets pro-rata across active and queued shares. A full slash resets shares/queue and advances the generation. |
| `proposeHolding` → `acceptHolding` → `revokeHolding` | owner / anyone in acceptance window / owner, instant | Existing admission and proposal cancellation rules; notice outlasts exit cooldown. Production delay is 8 days, acceptance grace 7 days. |
| `bootstrapHolding` | owner, once, while `totalAssets == 0` and nothing proposed | Opens delegation and authorizes the first Holding without delay. |

Pool invariant: `reserved <= assets`, including when reservations exceed active backing after a queue request.
The vault FACTORY balance is at least `totalAssets`; unsolicited token transfers do not affect share prices.
`Delegated`, `UndelegateRequested`, `UndelegateCancelled`, `Withdrawn`, `PoolReset`, and the unchanged
`Reserved`/`Released`/`Slashed` events reconstruct every pool and position for future profit-sharing epochs.
Deposits reject total shares above `uint192` before taking funds, keeping every accepted position withdrawable in
one queue. After repeated near-total slashes, a pool may refuse new backing until it empties and recovers 1:1.
Reservations and unreserved dust are preserved; share/asset products use full-precision `Math.mulDiv`.
The legacy vault methods and totals are removed; this is a clean redeploy, with no compatibility shims.

Vault v2 gas floors (5 Oct, `GasFloors.t.sol`, local Monad pricing; execution gas excludes intrinsic/calldata):

| Call | Measured floor | Client limit with margin |
| :--- | ---: | ---: |
| `reserve` | 88,474 | 200,000 |
| `delegate`, new pool and position | 132,602 | 300,000 |
| `requestUndelegate` | 70,179 | 200,000 |
| `withdraw` | 81,968 | 200,000 |

These are tested local floors. Check live estimation against actual state before sending.

## FeeSchedule, Factory, mining

| Contract | Surface |
| :--- | :--- |
| `FeeSchedule` | `feeBps(stake)`, `treasury()`, `schedule()`, `pending()`; owner `propose` / `cancel`, anyone `execute` from 3 d to 10 d (then `ScheduleExpired`); an ownership change drops the proposal. Starts at 0 / 10k / 100k / 1M FACTORY → 30 / 10 / 3 / 1 %. |
| `Factory` | ERC-20 + permit + burn, 18 decimals, 1e9 minted once to the genesis allocation, no owner. |
| `MiningReserve` | owner `fund(epoch, amount)` for an ended epoch, capped by the cumulative schedule (epoch 0: 72 h, W·3/7; epoch k ≥ 1: `W >> ((k − 1) / 26)`, W = 500M/52), itself capped at 500M; `budget(epoch)` is cut at that cap (zero from epoch 182). |
| `EpochDistributor` | owner `setRoot(epoch, root, total, dataHash)` after the epoch, backed by unpromised funds, replaceable until the first claim; owner `resizeRoot(epoch, newTotal)` corrects a total (≥ claimed; increases only from unpromised funds); anyone `claim(epoch, account, amount, proof)`, which stakes for `account` via `vault.delegateFor(account, account, amount)`. One leaf per account and epoch: the tree builder must aggregate, and `total` should equal the leaf sum. |

## Deploy (C8): `script/HirelingRecipe.sol`, `script/DeployHireling.s.sol`, `script/PromoteHireling.s.sol`

Two steps, run by the coordinator only (review C8-001). Neither a dry run nor a failed or partial broadcast can touch
`config/<network>.json`:

```sh
# 1. Broadcast. Writes only broadcast/hireling/<network>.candidate.json (gitignored), and only with --broadcast.
#    Cut off part way? Re-run the same command with --resume.
#    Testnet takes the raw key; mainnet signs from a keystore (--account hireling-deployer --password-file …, runbook §3.2).
NETWORK=monad-testnet forge script script/DeployHireling.s.sol --rpc-url … --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow
# 2. Promote. Sends nothing. Verifies the candidate against live state and forge's receipts, then writes the record.
NETWORK=<network> forge script script/PromoteHireling.s.sol --rpc-url …
# 3. The Safe accepts the six handovers (C10), sent by one Safe owner (testnet: the backup owner), then reads back
#    owner() == safe on all six. Re-running skips what the Safe already owns; --sig "check()" only reads back.
#    Mainnet: --account hireling-safe-owner --password-file … instead of the raw key (runbook §3.5).
NETWORK=monad-testnet forge script script/SafeAccept.s.sol --rpc-url … --private-key $SAFE_BACKUP_TESTNET_PRIVATE_KEY --broadcast
```

Step 3 sends one `execTransaction` per contract with a pre-validated signature (`r` = the owner, `s` = 0, `v` = 1),
which a Safe accepts from that owner as sender. It needs a threshold-1 Safe (`ThresholdNotOne` otherwise) and refuses a
non-owner sender or a handover that is not pending to the Safe. `test/fork/SafeAcceptRehearsal.t.sol` runs it against
the live testnet Safe on a fork.

Chain 143 also needs `MAINNET_GO=yes` on step 1. Step 2 refuses unless every transaction in
`broadcast/DeployHireling.s.sol/<chainId>/run-latest.json` (under `FOUNDRY_BROADCAST` instead, when a fork rehearsal
sets it to its own directory: `script/BroadcastPath.sol`) has a successful receipt, every candidate contract was
created by that run, and the live readbacks in `script/HirelingVerify.sol` pass: code at every address and at the
Safe, the wiring, the bootstrap, a 500M reserve with nothing funded or promised, `reserve.genesis == distributor.genesis
== t0`, a 1e9 supply, the configured fee schedule with nothing queued, the vesting allocation, every owner the Safe or
pending to it, and on a fresh core both admin roles held by the Safe and renounced by the deployer. Block numbers come
from the receipts (`hireling.block` = the run's first block, `block` = the fresh core proxy's). Running step 2 again
after success changes nothing; a different recorded deployment refuses. `script/rehearse-hireling-pipeline.sh` runs the
whole sequence (dry run, cut-off broadcast, resume, promote twice) against an anvil fork of Monad testnet.

Input: the `hireling` block of `config/<network>.json` (values are the coordinator's). `load` reads every field, so a
missing one refuses; runbook §1.2 has the same list as a checklist, which `MainnetRunbook.t.sol` builds a fixture from
and loads (LAUNCH-AUDIT-001):

```jsonc
"hireling": {
  "reuseCore": false,                      // chain 143: false, a fresh core (true is refused); testnet: true, reuse
                                           // deployment.core (which must charge 0 fees)
  "safe": "0x…",                           // owner of every v1 contract; mainnet core admin
  "defaultArbitrator": "0x…",              // = roles.arbitrator, the fresh arbiter key (enforced on 143; never a retired
                                           // 1 Oct key, LAUNCH-AUDIT-FIX-001); not the deployer
  "margin": 3600,                          // seconds added to the windows when checking expiredAt (reviewed default)
  "schedule": { "thresholds": [0, 10000, 100000, 1000000],   // whole FACTORY
                "bps": [3000, 1000, 300, 100], "treasury": "0x…" },
  "allocation": { "treasury": "0x…",      // 200M (the Safe)
                  "ecosystem": "0x…",     // 100M (the Safe; the deployer on testnet)
                  "liquidity": "0x…" },   // 50M (the deployer, then the pool seed)
  "vesting": { "beneficiary": "0x…", "startOffset": 31536000, "duration": 94608000, "cliff": 0 },  // 150M
  "mining": { "genesis": 0 }               // epoch 0 start; 0 = deploy time (T0)
}
```

D24 adds an optional `hireling.clocks` input. If present, every key is required and is a number of seconds;
if absent, the recipe supplies production values. The approved testnet block prepares G1b and does not describe
the old G1 deployment's clocks. The same `HirelingClocks.Config` tuple is appended to the constructors of
StakeVault, FeeSchedule, HirelingHolding, MiningReserve and EpochDistributor. Each constructor validates the whole
tuple on every chain and stores its relevant fields as immutables; no setter exists.

| Config key | Production (143) | Fast testnet (10143) | Getter and return type |
| --- | ---: | ---: | --- |
| minReviewWindow | 3600 | 120 | HirelingHolding.MIN_REVIEW_WINDOW(): uint32 |
| minDisputeWindow | 3600 | 120 | HirelingHolding.MIN_DISPUTE_WINDOW(): uint32 |
| minArbitrationWindow | 43200 | 300 | HirelingHolding.MIN_ARBITRATION_WINDOW(): uint32 |
| unstakeDelay | 604800 | 600 | StakeVault.UNSTAKE_DELAY(): uint48 |
| holdingDelay | 691200 | 900 | StakeVault.HOLDING_DELAY(): uint48 |
| feeDelay | 259200 | 300 | FeeSchedule.DELAY(): uint48 |
| proposalGrace | 604800 | 1800 | StakeVault.PROPOSAL_GRACE(), FeeSchedule.PROPOSAL_GRACE(): uint48 |
| epochZeroDuration | 259200 | 1800 | MiningReserve.EPOCH_ZERO_DURATION(), EpochDistributor.EPOCH_ZERO_DURATION(): uint48 |
| epochDuration | 604800 | 3600 | MiningReserve.EPOCH_DURATION(), EpochDistributor.EPOCH_DURATION(): uint48 |

Chain 143 refuses any non-production field. Everywhere, minimum windows must be positive and no greater than
14 days, notice/cooldown/grace values must be at least 60 seconds, epoch lengths at least 600 seconds, and
`holdingDelay > unstakeDelay` preserves the staker's exit before a new Holding is admitted. The existing 14-day
MAX_* getters (uint32), budgets, supply, allocations and halving stay constants. No fee-delay relationship to
another clock is required. Promotion and D16 read all clock values back; D16 also checks the three fixed maxima.

Steps, one broadcast transaction or a few each: core (reuse, or a proxy initialised inside its CREATE, fees 0 to the
Safe) → TeamVesting → Factory (mining 500M to the deployer, forwarded below) → FeeSchedule → StakeVault →
HirelingHolding → HirelingEvaluator → `setEvaluator` + attester verifier → `bootstrapHolding` (staking opens) →
EpochDistributor → MiningReserve → 500M to the reserve → `transferOwnership(safe)` on all six owned contracts, and on a
fresh core both admin roles granted to the Safe and renounced by the deployer. No address is predicted. Between steps a
third party can do nothing useful: staking is closed until the bootstrap, `publish` reverts `EvaluatorNotSet` and then
`NotHolding` until the bootstrap, and every setup call is owner-only (`test/hireling/Recipe.t.sol`,
`test/fork/HirelingRehearsal.t.sol`). Handover is complete only when the Safe has called `acceptOwnership` on each
contract; until then `owner()` is still the deployer.

Output (`.deployment`, decisions D1 + D5): `factory` = FACTORY v2; `hireling = { block, safe, factory, vault,
feeSchedule, distributor, miningReserve, teamVesting, t0 }`; `main = { kind: "hireling-v1", factory, holding,
evaluator, openTokens: true }`; the previous `main`/`demo` move to the next free `legacy.main-vN`/`legacy.demo-vN` and
every legacy pair gets an explicit `kind: "legacy"` and `factory`; `core`, `block`, `poolFactory`, `rewardTokens`,
`stacksBlock` are kept. On mainnet (LAUNCH-AUDIT-004) an absent `rewardTokens` is derived from the single `knownTokens`
entry, USDC, and a list without `x402.usdc` refuses: the SDK and Explore take their reward tokens from it. The
production preflight requires the promoted list to hold USDC and the artifact's `deployment.rewardTokens` to equal it.
An unknown key or an existing `hireling` record refuses before anything is broadcast. `load`
narrows every config number with `SafeCast` and `check` refuses a Safe with no code, a threshold above the supply and a
genesis more than a day in the past or 90 days ahead (C9).

Core admin on a fresh (mainnet) core, held by the Safe: `pause`/`unpause`, `emergencyWithdraw` while paused, the fee
setters, the hook whitelist and the UUPS upgrade. On testnet the reused core keeps its existing admin.

## Testnet odd tokens (C11): `src/testnet/OddTokens.sol`, `script/DeployOddTokens.s.sol`

Testnet only (the script refuses chain 143). Two 6-decimal tokens for live M2 / C9-001 evidence on the v1 pair, both
owned by the deployer, which mints `oddTokens.mint` whole tokens of each to every wallet in `oddTokens.wallets`:

| Token | Owner controls | Shows |
| :--- | :--- | :--- |
| `BlocklistUSD` (bUSD) | `setBlocked(account, bool)`: every transfer from or to a blocked account reverts | Block the worker after activation: the decision lands, the payout is deferred, then owed until unblocked (`withdraw`). |
| `GasBurnerUSD` (gUSD) | `setHungry(account, rounds)`: transfers *to* the account burn `rounds` rounds of hashing, or all forwarded gas at `type(uint256).max` | Arm it for the worker: a decision at the documented limit still lands (`CORE_GAS`), the payout is deferred, then owed. |

Config (coordinator): input `"oddTokens": { "wallets": ["0x…"], "mint": 10000 }`; record
`"deployment": { …, "oddTokens": { "blocklist": "0x…", "gasBurner": "0x…", "block": 123 } }`, from the script's
output and the deploy receipt (the script writes no config). Command:
`NETWORK=monad-testnet forge script script/DeployOddTokens.s.sol --rpc-url … --private-key $DEPLOYER_PRIVATE_KEY --broadcast`.
`test/testnet/OddTokens.t.sol` runs both paths on the v1 pair.

## Liquidity seed (C12): `script/SeedPool.s.sol`

One full-range Uniswap v4 FACTORY/USDC position on Monad mainnet, owned by the protocol Safe. It is created in **one
transaction** by a one-shot `SeedHelper` (`src/hireling/SeedHelper.sol`; review C12-002). The price is
`quoteAmount / factoryAmount` ($300 / 3M FACTORY = $0.0001, $100k FDV). The script sends four transactions from the
seeder (the account holding the liquidity allocation and the USDC):

1. Deploy the helper with the plan.
2. and 3. Approve it, one transaction per token, the seed amount plus the repair cap: 3M FACTORY + 50,000, then $300 + $5.
4. Call `seed()`. In that one call the helper:
   1. pulls both approvals;
   2. sets the price: it initializes the pool, or, if someone already initialized it at another price, swaps it to the
      target (exact input, limited at the target), trading through anything in the way, in range or out of range, up
      to `maxRepairCost`. An empty pool moves for free. Every repair trade buys below the target or sells above it,
      so blocking the seed costs the attacker real capital;
   3. mints the full-range position to the Safe through the PositionManager and Permit2;
   4. clears every allowance it gave and returns everything it still holds to the seeder.

   Liquidity is computed from 99.99% of each amount with the full amounts as caps. Only the seeder can call `seed()`,
   and only once.

Commands, with `MAINNET_GO=yes`:
`NETWORK=monad-mainnet MAINNET_GO=yes forge script script/SeedPool.s.sol --rpc-url … --account hireling-liquidity
--password-file ~/.config/hireling/liquidity.password --broadcast --slow` (a keystore, never a raw key; runbook §3.7).
The dry run (without `--broadcast`) simulates the seed; a `Repaired` event in its trace shows what a repair would cost.

**After the broadcast, check it** (review C12-001; the simulation's readback proves nothing):
`NETWORK=monad-mainnet forge script script/SeedPool.s.sol --sig "verify()" --rpc-url …`. It reads
`broadcast/SeedPool.s.sol/143/run-latest.json`, requires every receipt to be successful, and takes the token id from
the PositionManager's `Transfer(0 → Safe)` in the seed receipt, matched by the helper's `Seeded` event for that id
(planned pool, price after the seed, liquidity). It then reads back live state:
- `ownerOf` is the Safe;
- the position's liquidity, pool key and ±ticks match the plan;
- the helper is spent (`seeded()`); its token balances are not checked, since anyone can send it dust afterwards (C12-004);
- no allowance is left, from the seeder to the helper, from the helper to Permit2, or Permit2's to the PositionManager.

**A second `run` is refused** (`AlreadySeeded`) while that run log holds a seed of this pool for the Safe.

**Refusals and the fallback key.** The checks run before anything is approved:
- `positionOwner` must equal `deployment.hireling.safe`, be nonzero, and the Safe must have code (review C12-003).
- If the repair cap runs out before the target (`PriceNotSet`), `seed()` reverts and nothing moves.

The coordinator then switches the config to the **fallback key, `"fee": 10000, "tickSpacing": 200`** (1%, ticks
±887200; same currencies, no hooks), and re-runs: deploy, approve, seed. Revoke the old helper's allowances first with
`approve(helper, 0)` on both tokens; only the seeder can drive it anyway.

`test/fork/SeedPoolRehearsal.t.sol` (mainnet fork, live Uniswap contracts) covers:
- the seed;
- empty junk pools above and below the target;
- out-of-range one-sided dust (`getLiquidity() == 0`) and in-range dust, traded through within the cap;
- dust over the cap: refused, then the fallback key seeds;
- an unrelated mint just before the seed, with the receipt id correct;
- the run-log round trip, the retry refusal and the helper's guards;
- the owner checks.

Config (coordinator commits it in `config/monad-mainnet.json`; the protocol addresses were checked with `cast code`,
and `PositionManager.poolManager()` / `permit2()` return the two above). FACTORY and the Safe come from
`deployment.hireling.factory` / `.safe`:

```jsonc
"liquidity": {
  "uniswapV4": {
    "poolManager": "0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e",
    "positionManager": "0x5b7eC4a94fF9beDb700fb82aB09d5846972F4016",
    "permit2": "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    "stateView": "0x77395F3b2E73aE90843717371294fa97cC419D64"
  },
  "quote": "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",   // USDC (6 decimals)
  "fee": 3000, "tickSpacing": 60,                           // 0.3 %, ticks ±887220
  "factoryAmount": 3000000, "quoteAmount": 300,             // whole tokens
  "maxRepairCost": 5,                                       // whole quote units; optional, default 5 (USDC)
  "positionOwner": "0x…"                                    // = deployment.hireling.safe (R2); anything else refuses
}
```

## Launch rehearsal (R7): `script/rehearse-launch.sh`

The mainnet launch end to end on a throwaway anvil fork of chain 143 (`--network monad` pricing), in runbook order:
1. A 1-of-2 Safe from the canonical v1.4.1 SafeProxyFactory `0x4e1D…ec67`, SafeL2 `0x29fc…C762` and fallback handler
   `0xfd07…Ec99` (code checked first).
2. `DeployHireling` with a fresh core and `MAINNET_GO`.
3. `PromoteHireling`, then the D16 launch gate (`apps/api/src/prod-config.ts`), which must **refuse**: all six
   handovers are only pending.
4. `SafeAccept` from one owner, then the gate, which must **pass**: the reviewed Safe, Safe custody, both core admin
   roles with the Safe and none with the deployer, attester verifier, relay above 2 MON. The reviewed Safe
   (LAUNCH-AUDIT-003) means a proxy of the canonical SafeL2 (slot 0), `VERSION` 1.4.1, exactly the artifact's pinned
   `deployment.hireling.safeOwners` and `safeThreshold`, no module and no guard. R7 pins its own Safe's owners and
   threshold, then shows that a wrong owner pin and a guard written to the guard slot each refuse.
5. `SeedPool`, then its receipt-based `--sig "verify()"` against forge's real run log.
6. One direct hire through the v1 pair (`script/RehearseHireAndMine.s.sol`, `RehearseHire`).
7. A warp past epoch 0, then work mining with the B8 tool (`scripts/mining`, README there):
   - a Safe owner signs the price list from a throwaway keystore;
   - `mining:epoch` computes epoch 0 from the fork's logs;
   - the Safe sends the tool's `fund` and `setRoot` calldata;
   - the worker's and the creator's claims, with the tool's proofs, stake (`RehearseMining`).

It signs with anvil's public dev keys only, writes only its own scratch config and forge directories (see "Every fork
rehearsal" under G1-DRY), and removes them on exit:
`RPC=https://rpc.monad.xyz bash script/rehearse-launch.sh`. Passed 2 Oct (fork of mainnet at that day's head).

**Launch budget** from that run. The limits are the ones forge actually sent, which Monad charges; MON is limit ×
gas price.

| step | txs | gas limit | gas used | MON @ 102 gwei | MON @ 203 gwei (max fee) | paid by |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Safe (1-of-2) | 1 | 319,209 | 315,034 | 0.033 | 0.065 | anyone (deployer) |
| DeployHireling, fresh core | 26 | 26,300,231 | 20,227,347 | 2.683 | 5.339 | deployer |
| PromoteHireling | 0 | 0 | 0 | 0 | 0 | — |
| SafeAccept (6 × execTransaction) | 6 | 797,168 | 607,843 | 0.081 | 0.162 | a Safe owner |
| SeedPool (helper, 2 approvals, seed) | 4 | 3,888,439 | 2,990,539 | 0.397 | 0.789 | seeder (liquidity holder) |
| Mining epoch 0 (ECDSA fund + setRoot via Safe, two claims) | 4 | 977,479 | 747,172 | 0.100 | 0.198 | a Safe owner; claimers |
| **launch total** | **41** | **32,282,526** | | **3.293** | **6.553** | |
| one hire (rehearsal only, users pay) | 11 | 4,568,823 | 2,629,362 | 0.466 | 0.928 | creator, worker |

The deployer needs about 3.1 MON charged (Safe + deploy + seed), or 6.2 MON on hand at the 203 gwei max fee (Monad
checks the balance against limit × max fee). A Safe owner needs about 0.15 MON, or 0.3 on hand. The relay must hold
more than `RELAY_FLOOR_MAINNET` (2 MON, B6) before opening.

Since B8 (2 Oct), step 7 is four transactions: `fund`, `setRoot` and two claims. That's 968,520 gas limit (0.099 MON
@ 102 gwei), and each claim is paid by whoever sends it. In that run the hire's 2.5 USDC fee mined 12,500 FACTORY:
7,500 to the worker and 5,000 to the creator.

## Testnet launch (G1): `script/launch-testnet.sh`, `script/rehearse-launch-testnet.sh`

The coordinator's G1 run: the runbook sequence on Monad testnet, core reused, no seed. It refuses chain 143 (the
RPC's chain id and the config). It signs from an encrypted Foundry keystore per role, as mainnet does
(`DEPLOYER_ACCOUNT`/`SAFE_OWNER_ACCOUNT` plus a mode-600 `*_PASSWORD_FILE`). Raw keys are only an explicit testnet
fallback: `--private-keys`, read from env vars by name (`DEPLOYER_PRIVATE_KEY`, `SAFE_BACKUP_TESTNET_PRIVATE_KEY`). The
RPC comes from `MONAD_TESTNET_RPC_URL`. No value is printed, and output and logs are redacted. It holds the launch lock
`contracts/.launch.lock` (`script/launch-lock.sh`) for the whole run, so a second launch or fork rehearsal started in
the same checkout refuses at once. Forge writes its default `broadcast/` and `cache/`: with `NETWORK` not a
`rehearsal-…` one, it refuses `FOUNDRY_BROADCAST` and `FOUNDRY_CACHE_PATH`.

1. Checks: the chain, no v1 deployment recorded yet, the deployer is `roles.admin` and can grant the reused core's
   `ADMIN_ROLE`, the Safe is v1.4.1 with threshold 1, no module and no guard (the mining fund's nonce guard, D18, needs
   neither), the Safe-owner key is an owner, an `oddTokens` block exists, and both senders hold the gas limits at twice
   the current gas price.
2. `DeployHireling` dry run, then `--broadcast --slow`.
3. `PromoteHireling`.
4. `SafeAccept`, then its `check()`.
5. `pauser`: the deployer grants the Safe the reused core's `ADMIN_ROLE`, which `pause()`/`unpause()` require, so
   /admin's pause works. `ADMIN_ROLE` only, not the upgrade role; the deployer keeps its roles. Skipped if the Safe holds
   it. Mainnet needs no such step: the Recipe deploys that core and hands the Safe both roles in `stepHandover`.
6. `owner() == Safe` and `pendingOwner() == 0` on the six; the Safe holds the core's `ADMIN_ROLE` and still has no
   module and no guard.
7. The SDK loads the promoted deployment.
8. `DeployOddTokens`.

Optional flags:
- `--fee-proposal`: the Safe calls `FeeSchedule.propose` through `execTransaction`. Anyone can execute at its ETA,
  within `PROPOSAL_GRACE` (production: 3-day notice, 7-day grace); an early `execute` is shown to refuse.
- `--holding-probe`: the Safe proposes `0x…dEaD` as a vault Holding, and an early `acceptHolding` is shown to refuse.
  Anyone may accept it at its ETA within `PROPOSAL_GRACE` (production: days 8–15); `cancelHoldingProposal` withdraws it.
- `--dry-run`, `--yes`, `--from/--to <step>`.

Every transaction hash is printed and listed again at the end.

`rehearse-launch-testnet.sh` runs it unchanged on an anvil fork of testnet, signing from throwaway keystores of dev
keys, with a fresh 1-of-2 Safe; dev0 stands in for `roles.admin` as the core's admin (granted by an impersonated
`roles.admin`). It also checks that a missing signer, a loose password file, a chain-143 RPC and a second launch are
refused, that a re-run from `pauser` sends nothing, that a Safe with a module (enabled through its own
`execTransaction`) or with a guard is refused, and that both proposals can execute at their immutable ETAs.
Every dev account carries someone's EIP-7702 delegation on Monad testnet, so the fork clears that code
first (R7 does the same on its mainnet fork). `KEEP=1` stops after the launch and leaves the fork running, and the
promoted scratch config and the run's forge directories in place, printing them, the env that reaches them
(`NETWORK`, `FOUNDRY_BROADCAST`, `FOUNDRY_CACHE_PATH`) and how to remove them, for UI's real-chain harness; the lock is
released. Passed 2 Oct. Gas limits
from that run:

| step | txs | gas limit | MON @ 102 gwei | paid by |
| --- | ---: | ---: | ---: | --- |
| DeployHireling, reused core | 18 | 17,940,929 | 1.830 | deployer |
| pauser: `core.grantRole(ADMIN_ROLE, Safe)` | 1 | 88,395 | 0.009 | deployer |
| DeployOddTokens (2 tokens, 2 wallets) | 6 | 2,189,372 | 0.223 | deployer |
| SafeAccept (6 × execTransaction) | 6 | 797,152 | 0.081 | Safe owner |
| fee proposal + Holding probe | 2 | 340,098 | 0.035 | Safe owner |

### G1-DRY: backend's B11 runner on that deploy (`script/rehearse-flows-testnet.sh`)

On an anvil fork of testnet: the launch above (fresh keys for every role, a fresh Safe, fee proposal, Holding probe),
promoted into a scratch `config/rehearsal-<pid>-<random>.json`. The tracked `config/monad-testnet.json`, into which G1 itself
promotes (possibly from the same checkout), is only read. The runner reads the SDK's bundled testnet config, so it
runs from a private mirror: byte-identical copies of `packages/sdk/src` and `scripts` (no journal), the real
`node_modules`, and the scratch config at the mirror's `contracts/config/monad-testnet.json`. Each case of
`v1-flows.ts` runs as its own `bun --no-env-file` process under `env -i`, with only the fresh keys and the loopback RPC,
so no `.env.local` value or real key can reach it. The runner's chain-time waits are warped.

Every fork rehearsal (this one, the G1 rehearsal, R7, the pipeline rehearsal) keeps clear of a real launch run from the
same checkout (G1-DRY-001 and its residual):
- It takes the launch lock (`script/launch-lock.sh`) before anything else and holds it for its whole run; a second
  rehearsal or `launch-testnet.sh` started meanwhile refuses at once instead of waiting. Its own `launch-testnet.sh`
  inherits the lock (fd 9); its anvil is started without it, so a kept fork never holds it.
- It names everything by a run id, the pid plus 32 random bits (`rehearsal_run` in `script/rehearse-owned.sh`): the
  scratch `config/rehearsal-<id>.json`, and forge's broadcast logs and their cache twins under `broadcast/rehearsal-<id>`
  and `cache/rehearsal-<id>` (`FOUNDRY_BROADCAST`, `FOUNDRY_CACHE_PATH`; PromoteHireling, SeedPool's `verify()` and the
  candidate read them back through `script/BroadcastPath.sol`). So it never touches a real launch's
  `broadcast/<script>/<10143|143>/run-latest.json`, and before passing it checks a digest of every such log, taken at
  its start, is unchanged.
- It starts its own anvil and refuses a port already serving an RPC.
- On exit it deletes its two directories, each only if it still carries the run's mark, and the scratch config only if
  it names the run's Safe; anything else is kept and named.

`bash script/test-launch-lock.sh` checks the lock with no chain: while one run holds it, `launch-testnet.sh` and each
of the four rehearsals refuse at once and write nothing; the holder's own children go through; a real-network launch
refuses `FOUNDRY_BROADCAST`. `test/LaunchLock.t.sol` pins the same in the sources.
It prints pass/fail per case and the gas limits per wallet, for the launch and for the flows. Every runner case that
needs no board passed on 2 Oct (21/21), all but `legacy-dispute`, which signs with the real legacy arbitrator's key.
Fork-only stand-ins: an impersonated `roles.admin` makes the fresh deployer the core's admin, and `anvil_dealERC20`
gives mUSD and FACTORY v1. The anvil dev keys are not used, because on Monad testnet every one carries an EIP-7702
sweeper delegation.

| wallet | txs | gas limit | MON @ 102 gwei |
| --- | ---: | ---: | ---: |
| deployer: launch, incl. `pauser` | 25 | 20,218,727 | 2.062 |
| Safe owner: launch | 8 | 1,137,278 | 0.116 |
| creator: flows | 96 | 30,291,973 | 3.090 |
| relay: flows | 25 | 26,173,008 | 2.670 |
| worker: flows | 83 | 16,401,996 | 1.673 |
| Safe owner: flows | 3 | 605,595 | 0.062 |
| odd-token owner (deployer): flows | 4 | 245,389 | 0.025 |

### G1b preparation (D24): archive G1, then deploy with fast clocks

`script/prepare-redeploy-testnet.sh` is coordinator-run. It takes the launch lock, proves the RPC and config are
chain 10143, and requires the recorded G1 addresses (including Holding `0x9BB0B3a6c130d81f6820499bD168C4d910CD502F`),
block and t0. It refuses an existing archive or changed G1 identity before modifying the active record.
`--check` validates the plan without writing either file.

The archive `config/archive/monad-testnet-g1.json` retains the original config bytes, including G1 contracts, roles
and odd-token receipts, plus `archive.reason`, UTC `archive.date` and `archive.sourceSha256`. The active config loses
only `deployment.hireling`, `deployment.main` and `deployment.oddTokens`. The last is launch-generated output that
HirelingOutput does not accept as a fresh input; `launch-testnet.sh` creates new odd-token receipts. All five legacy
pairs, the reused core, roles, top-level oddTokens, liquidity and approved `hireling.clocks` inputs remain unchanged.
`main` must be absent: promotion writes the fresh v1 pair directly, preserving the legacy key set. G1 is archived;
it does not become a legacy Hireling stack.

Promotion writes all nine `deployment.hireling.clocks` fields with the input key names. Values come from the deployed
Holding/Vault/FeeSchedule/MiningReserve getters, with the repeated grace and epoch clocks checked on
FeeSchedule/EpochDistributor. Every value must equal the input (an absent input defaults to production). A mismatch
refuses before any config write. Mainnet promotion additionally requires production clocks. An idempotent promotion
checks recorded clocks against getters and input again. The SDK's synchronous consumers read this promoted block.

After CLOCKS-PARAM and G1B-PREP review/merge, the coordinator runs from the repository root:

```bash
set -a
. /home/kristjan/code/agent-jobs/.env.local
set +a
bash contracts/script/prepare-redeploy-testnet.sh --check
bash contracts/script/prepare-redeploy-testnet.sh
heavy bash contracts/script/launch-testnet.sh --private-keys --fee-proposal --holding-probe --dry-run
heavy bash contracts/script/launch-testnet.sh --private-keys --fee-proposal --holding-probe --yes
```

Stop if any command fails. A `heavy` exit 75 means capacity contention: retry that same command. After preparation,
retry launch without re-running preparation; if a broadcast fails, reconcile its receipts and use the launch
script's documented resume step. The coordinator commits the actual archive/promoted config and dated live evidence.

`heavy bash contracts/script/rehearse-redeploy-testnet.sh` proves the sequence on an owned local fork with disposable
dev keys and a fresh Safe. It archives/prepares a scratch G1 copy, runs the exact raw-key launch dry run without
config/nonce changes, deploys/promotes/accepts the fast recipe, verifies every promoted clock against twelve getters,
and loads all nine clocks synchronously through the SDK. It also checks signer/chain/lock/relaunch/Safe-policy
refusals and executes the fee and Holding proposals at their immutable ETAs. Owned config/archive/Forge directories
and anvil are removed afterward; real launch logs and the checked-in config are untouched. The production-values
mainnet fork remains covered by `test/fork/HirelingRehearsal.t.sol`.
