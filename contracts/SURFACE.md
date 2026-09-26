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
| `setProvider` | client | Supported: `JobHolding.activate` (hire, the worker's own transaction) and `JobHolding.select` (contest, before the selection deadline); agent id required. | Unreachable: the client is Holding. |
| `setPayoutReceiver` | provider, Open | Unavailable. | The worker may route its payout elsewhere; money still only moves on `complete`. Harmless. |
| `setBudget` | provider, Open | Supported: inside `activate` through the worker's `SetBudgetAuthorization` (Holding fixes token and amount); a contest winner directly (old model). | An authorization for another amount does not verify (`test_auth_workerCannotUnderfundThemselves`). |
| `fund` | client | Supported: `JobHolding.fundAfterAccept` (anyone may trigger, effect fixed by the listing) once the worker has posted its FACTORY bond and set the budget. | Unreachable: the client is Holding. |
| `submit` | provider, Funded **or Open with budget 0** | Supported after activation. | A hire has no provider before activation, and activation funds in the same transaction, so there is no Open-with-provider window (`test_adversarial_noSubmissionBeforeActivation`). A contest winner between `select` and funding can still submit early; `rejectAfterDeliveryDeadline` clears it (old model, goes with the award). |
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
expiry and wrong-signer cases: `test_auth_*`. Supported: `setBudgetWithAuthorization`,
`submitWithAuthorization`. The others are unavailable and, if used, fall under the same rows as their
direct counterparts. `cancelAuthorization` lets a signer burn its own nonce; harmless.

## Our own surface (v2, spike S1b, plus the S7 steps landed so far)

| Function | Who | Effect on money |
| :--- | :--- | :--- |
| `JobHolding.publish` | anyone holding >= `minHoldToPublish` FACTORY | Pulls the reward (payment token) and the creator bond (FACTORY). Stores the offer's `approver` (zero = the creator). Refuses a zero or already-listed `policyHash` (R114-07) and a contest with `workerBond > 0` (`ApproverTest`). |
| `JobHolding.activate(selection, creatorSig, budgetAuth)` | **the selected worker itself** (never relayed, R114-01) | Replaced `assign` + `postWorkerBond` + `fundAfterAccept` for hires. Checks the creator's EIP-712 `Selection` (signature, own nonce space, `activateBy` ≤ now allowed at the deadline, `activateBy` < delivery deadline, `termsHash` = listing's `policyHash`), `agentId` ≠ 0, `identity.getAgentWallet(agentId) == msg.sender` and the hold gate; then setProvider, pulls the worker bond, applies the worker's `SetBudgetAuthorization` for exactly the listed token and reward, funds. All or nothing; at most once per listing (`ActivationTest`, `ActivationForkTest`). |
| `JobHolding.cancelSelection(nonce)` | creator | None; burns a selection nonce. |
| `JobHolding.select` | creator | Contest only, old select-then-accept model until the atomic award lands; sets the provider before `selectionDeadline`. |
| `JobHolding.postWorkerBond` | the selected contest winner | Contest only (old model): pulls the worker bond (always 0 now). |
| `JobHolding.fundAfterAccept` | anyone | Contest only (old model): moves the prize into the core once the winner set budget == prize. |
| `JobHolding.cancel` | creator, **hire only, before activation** | `reject` while Open; nothing was in the core. A live contest cannot be cancelled (R16-02). |
| `JobHolding.expireContest` | anyone, after `selectionDeadline`, no winner selected | `reject` while Open; prize and creator bond recoverable once. |
| `JobHolding.settle` | anyone | After a terminal core status: the reward still in Holding to the worker if `earnedByWorker`, else to the creator; unsettled bonds back to their owners; each amount at most once. Replaced `withdraw` / `withdrawWorkerBond` in S7 (R114-03). |
| `JobHolding.burnBond` | evaluator only | Burns one side's bond. Only reachable through `rule(..., slashLoser = true)`. |
| `JobHolding.returnBonds` | evaluator only | Returns unsettled bonds to their owners; idempotent. |
| `JobsEvaluator.accept` | approver | `complete`; refused while a dispute is open (`DisputeOpen`, R114-02). `dispute` requires a funded Submitted job. |
| `JobsEvaluator.earnedByWorker` | view | Funded, submitted by the delivery deadline, unrejected, review window over. Read by `settle`. |
| `JobsEvaluator.creatorReject` | approver, **only until `submittedAt + reviewWindow`** | None; opens the dispute window. After the cutoff silence is acceptance even if nobody called the timeout (R16-01). |
| `JobsEvaluator.rule(jobId, forWorker, slashLoser)` | arbitrator, **only until `disputedAt + arbitrationWindow`** | `complete` or `reject`, then burn the loser's bond only if `slashLoser`, then return the rest. After the cutoff only the refund timeout settles (R16-01). |
| `JobsEvaluator.attachEvidence` / `attachEvidenceDirect` | a registered verifier (signed / calling) | None. Per-verifier record with `submissionHash`, `policyHash`, `testedSha`, `validUntil`; policy must equal the listing's; same verifier + same digest is an idempotent no-op; two verifiers on one digest are both kept (R16-06/07). |
| ERC-8004 feedback (inside every settlement) | evaluator, as client of record | None. Capped at 300k gas in `try/catch`; `FeedbackRecorded` or `FeedbackFailed`; never reverts a payout (R16-10). |
| the four timeouts | anyone | `complete` or `reject`; never burn. |

## Target v3 (spike S7, ADR-0004) — decided, **not built**

Nothing below exists yet. It records where S7 changes the table above so the two are never confused.

| Function | Who | Change from v2 |
| :--- | :--- | :--- |
| `JobHolding.publish` | anyone holding >= `minHoldToPublish` | Also stores the offer's `approver`; refuses a zero `policyHash` and a contest with `workerBond > 0`. |
| `JobHolding.activate(selection, creatorSig, agentId, budgetAuth)` | **the selected worker itself** (never relayed, R114-01) | Replaces `assign` + `postWorkerBond` + `fundAfterAccept`. Checks the creator's EIP-712 `Selection` (deadline, nonce, `termsHash`), `activateBy` and the delivery deadline, the hold gate and `getAgentWallet(agentId) == msg.sender`; then setProvider, worker bond, `setBudgetWithAuthorization`, fund. |
| `JobHolding.cancelSelection(nonce)` | creator | Burns a selection nonce. |
| `JobHolding.publish` (idempotency) | anyone | Refuses a `policyHash` it has already listed (R114-07). |
| Holding settlement after a core refund | anyone | After the core's `claimRefund` (or any rejection) the reward in Holding goes by the evaluator's recorded outcome: earned silence payment → worker; undisputed rejection, no-show, arbitration timeout → creator; each once (R114-03). Replaces `withdraw` paying the creator on any Rejected/Expired status. |
| `JobHolding.award(candidate)` | approver, before `selectionDeadline` | Replaces `select`. setProvider → `setBudgetWithAuthorization` → fund → `submitWithAuthorization` → evaluator completion in one transaction; any failure reverts all and the contest stays open. |
| `JobHolding.cancel` | creator, hire only | Only before activation. |
| `JobHolding.withdrawWorkerBond` | worker | Refuses while a penalty is due, whatever the core status (closes `claimRefund` → withdraw bypassing a burn). |
| `JobsEvaluator.accept` | **approver** (was creator) | Refused while a dispute is open (R114-02). Also a late submission, until the missed-delivery burn has run. |
| `JobsEvaluator.reject(jobId, violation, reasonHash)` | **approver**, until `submittedAt + reviewWindow`, timely submissions only | Replaces `creatorReject`; `violation ∈ {none, quality, falsified}`. |
| `JobsEvaluator.rejectAfterWindow` | anyone | Burns the worker bond when the undisputed rejection named a violation. |
| missed-delivery timeout | anyone, after `deliveryDeadline` | Funded, no timely submission: refund and **worker bond burned** (was: reject, bonds returned). |
| `JobsEvaluator.refundAfterArbitrationTimeout` | anyone | Unchanged money; writes **no** worker feedback (`skip-arb`). |
| `completeAfterSilence` | anyone | Only for a submission made by the delivery deadline. |
| `EvidenceAttached` | — | Also emits `submissionHash`, `policyHash`, `validUntil`. |
| ERC-8004 feedback | evaluator | Reason-aware (`completed`, `not-delivered`, `rejected`, `rejected-quality`, `rejected-falsified`); none on arbitration timeout. |

"the four timeouts … never burn" in the v2 table stops being true in v3: the missed-delivery timeout and an
undisputed violation burn the worker bond.

## Admin (deployer EOA, testnet)

`pause`/`unpause`, `emergencyWithdraw` (only while paused), `setPlatformFee`, `setEvaluatorFee`,
`setHookWhitelist`, `setPaymentTokenAllowed`, `batchDetachHook`, UUPS upgrade. Deployed with fees 0,
`MockPaymentToken` as the only allowed payment token (FACTORY is never allowlisted: collateral never enters the
core), no hook whitelisted. `JobHolding.setHoldRequirements` and `JobsEvaluator.setVerifier` are the two admin
knobs of ours. The README names the admin and commits to
no upgrade during an active agreement. Pause blocks every lifecycle call above, including the timeouts,
so an outage promise made while paused is void; this is stated rather than mitigated.

## Views

`getJob`, `jobs`, `jobCounter`, `pendingClaimHash`, `submittedClaimHash`, `whitelistedHooks`,
`allowedPaymentTokens`, fee getters, `DOMAIN_SEPARATOR`, the typehash constants. Read freely; the
indexer builds Explore from events plus `getJob`.
