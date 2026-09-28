# The inherited surface

Every externally callable function of the vendored ERC-8183 core (`erc-8183/base-contracts` at
`142e669c1fd318486a4628395b629f033654dd06`), classified against our guarantees (spec §3–§4).
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
| `JobHolding.publish` | anyone holding >= `minHoldToPublish` FACTORY | Pulls the reward (payment token) and the creator bond (FACTORY: the immutable bond token, any plain ERC-20; a fee-on-transfer token reverts `BondTokenFeeOnTransfer` at the first bond, `BondTokenTest`). Stores the offer's `approver` (zero = the creator). Refuses a zero or already-listed `policyHash` (R114-07) and a contest with `workerBond > 0` (`ApproverTest`). |
| `JobHolding.activate(selection, creatorSig, budgetAuth)` | **the selected worker itself** (never relayed, R114-01) | Replaced `assign` + `postWorkerBond` + `fundAfterAccept` for hires. Checks the creator's EIP-712 `Selection` (signature, own nonce space, `activateBy` ≤ now allowed at the deadline, `activateBy` < delivery deadline, `termsHash` = listing's `policyHash`), `agentId` ≠ 0, `identity.getAgentWallet(agentId) == msg.sender` and the hold gate; then setProvider, pulls the worker bond, applies the worker's `SetBudgetAuthorization` for exactly the listed token and reward, funds. All or nothing; at most once per listing (`ActivationTest`, `AdmissionForkTest`). |
| `JobHolding.cancelSelection(nonce)` | creator | None; burns a selection nonce. |
| `JobHolding.award(jobId, candidate)` | the listing's approver, until `selectionDeadline` (allowed at it) | Replaced `select` + `postWorkerBond` + `fundAfterAccept`. Checks `getAgentWallet(agentId) == candidate.worker`, then setProvider → `setBudgetWithAuthorization` (exactly the prize) → fund → `submitWithAuthorization` (exactly the named deliverable) → `JobsEvaluator.completeAward`: the entrant is paid and the creator bond returns in one transaction, winner offline. Any failure reverts all; the contest stays open; at most once (`ContestTest`, `AdmissionForkTest`). |
| `JobHolding.cancel` | creator, **hire only, before activation** | `reject` while Open; nothing was in the core. A live contest cannot be cancelled (R16-02). |
| `JobHolding.expireContest` | anyone, after `selectionDeadline`, nothing awarded | `reject` while Open; prize and creator bond recoverable once through `settle`. An awarded contest cannot be expired. |
| `JobHolding.settle` | anyone | After a terminal core status: the reward still in Holding to the worker if `earnedByWorker`, else to the creator; an unsettled worker bond **burns if `workerPenaltyDue`** (missed delivery, undisputed violation), else returns; the creator bond returns; each amount at most once. Replaced `withdraw` / `withdrawWorkerBond` (R114-03). |
| `JobsEvaluator.completeAward` | Holding only, inside `award` | `complete`, bonds back, feedback. |
| `JobHolding.burnBond` | evaluator only | Burns one side's bond on a final finding (sends it to `BURN_ADDRESS` `0x…dEaD`, so the bond token needs no `burn`): a ruling (`slashLoser`), an undisputed rejection naming a violation, a missed delivery. Holding records each bond's outcome (`creatorBondBurned`, `workerBondBurned`). |
| `JobHolding.returnBonds` | evaluator only | Returns unsettled bonds to their owners; idempotent. |
| `JobsEvaluator.accept` | approver | `complete`; refused while a dispute is open (`DisputeOpen`, R114-02). `dispute` requires a funded Submitted job. |
| `JobsEvaluator.earnedByWorker` / `workerPenaltyDue` | view | Read by `settle`: the silence right (funded, timely, unrejected, review over) and a due penalty (missed delivery past the deadline, undisputed violation past the filing window). |
| `JobsEvaluator.reject(jobId, violation, reasonHash)` | approver, **only until `submittedAt + reviewWindow`**, timely submissions only | None; records `violation ∈ {None, Quality, Falsified}` and opens the dispute window. After the cutoff silence is acceptance even if nobody called the timeout (R16-01). |
| `JobsEvaluator.rule(jobId, forWorker, slashLoser, reasonHash)` / `ruleWithSignature(Ruling, sig)` | arbitrator / anyone relaying the arbitrator's EIP-712 `Ruling` (deadline, nonce), **only until `disputedAt + arbitrationWindow`** | `complete` or `reject`; `slashLoser` burns the creator bond (bad-faith rejection) or the worker bond (violation upheld; refused if the rejection named `None`). After the cutoff only the refund timeout settles (R16-01). |
| `JobsEvaluator.attachEvidence` / `attachEvidenceDirect` | a registered verifier (signed / calling) | None. Per-verifier record with `submissionHash`, `policyHash`, `testedSha`, `validUntil`; policy must equal the listing's; same verifier + same digest is an idempotent no-op; two verifiers on one digest are both kept (R16-06/07). `EvidenceAttached` emits `digest`, `submissionHash`, `policyHash`, `testedSha`, `conclusion`, `validUntil`. |
| ERC-8004 feedback (inside every settlement) | evaluator, as client of record | None. Reason-aware tags `completed`, `not-delivered`, `rejected`, `rejected-quality`, `rejected-falsified`; **none on arbitration timeout** (`skip-arb`). Capped at 300k gas in `try/catch`; `FeedbackRecorded(value, tag)` or `FeedbackFailed`; never reverts a payout (R16-10). |
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
`setHookWhitelist`, `setPaymentTokenAllowed`, `batchDetachHook`, UUPS upgrade. Deployed by `script/Recipe.sol` from
`config/<network>.json` with fees 0, only the listed reward tokens allowlisted (testnet `mUSD` and `mEUR`, mainnet
USDC; FACTORY never: collateral never enters the core), no hook whitelisted. `JobHolding.setHoldRequirements` and `JobsEvaluator.setVerifier` are the two admin
knobs of ours. The README names the admin and commits to
no upgrade during an active agreement. Pause blocks every lifecycle call above, including the timeouts,
so an outage promise made while paused is void; this is stated rather than mitigated.

## Views

`getJob`, `jobs`, `jobCounter`, `pendingClaimHash`, `submittedClaimHash`, `whitelistedHooks`,
`allowedPaymentTokens`, fee getters, `DOMAIN_SEPARATOR`, the typehash constants. Read freely; the
indexer builds Explore from events plus `getJob`.
