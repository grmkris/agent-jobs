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
| `setProvider` | client | Supported: `JobHolding.assign` (hire-first) and `JobHolding.select` (contest, before the selection deadline); agent id required. | Unreachable: the client is Holding. |
| `setPayoutReceiver` | provider, Open | Unavailable. | The worker may route its payout elsewhere; money still only moves on `complete`. Harmless. |
| `setBudget` | provider, Open | Supported: the accept step (direct or `setBudgetWithAuthorization`). | A budget other than the listed reward is not an acceptance: `fundAfterAccept` refuses (`test_auth_workerCannotUnderfundThemselves`). |
| `fund` | client | Supported: `JobHolding.fundAfterAccept` (anyone may trigger, effect fixed by the listing) once the worker has posted its FACTORY bond and set the budget. | Unreachable: the client is Holding. |
| `submit` | provider, Funded **or Open with budget 0** | Supported after funding. | Submit-before-accept leaves a Submitted job Holding never funded. The evaluator refuses to settle it (`NeverFunded`) and `rejectAfterDeliveryDeadline` clears it (`test_adversarial_submitBeforeAcceptCannotBeSettled`). |
| `complete` | evaluator, Submitted | Supported: only `JobsEvaluator` (accept, silence, ruling). | Unreachable: the evaluator is our contract. |
| `reject` | client/provider when Open; evaluator when Funded/Submitted | Supported: `JobHolding.cancel` and `expireContest` (Open), the evaluator's terminal paths. | The provider may reject its own Open job: nothing was escrowed in the core; `withdraw` returns the reward and creator bond, `withdrawWorkerBond` the worker's. |
| `claimRefund` | anyone, after `expiredAt` (+1 h when Submitted) | Supported as the outage path: refunds land in Holding; `withdraw` (creator) and `withdrawWorkerBond` (worker) recover them since no evaluator path ran (`test_moneyPath_thirdPartyClaimRefund_workerRecoversOwnBond`). | Cannot pre-empt settlement: Holding requires `expiredAt >= deliveryDeadline + settlementWindow` (`test_adversarial_claimRefundCannotPreemptSettlement`). |

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

## Our own surface (v2, spike S1b)

| Function | Who | Effect on money |
| :--- | :--- | :--- |
| `JobHolding.publish` | anyone holding >= `minHoldToPublish` FACTORY | Pulls the reward (payment token) and the creator bond (FACTORY). |
| `JobHolding.assign` / `select` | creator | None; sets the provider (contest: only before `selectionDeadline`). |
| `JobHolding.postWorkerBond` | the assigned worker, holding >= `minHoldToClaim` | Pulls the worker bond (FACTORY). Required before funding even when zero. |
| `JobHolding.fundAfterAccept` | anyone | Moves the reward into the core once bond posted + budget == reward. |
| `JobHolding.cancel` | creator, **hire-first only** | `reject` while Open; nothing was in the core. A live contest cannot be cancelled (R16-02). |
| `JobHolding.expireContest` | anyone, after `selectionDeadline`, no winner selected | `reject` while Open; prize and creator bond recoverable once. |
| `JobHolding.withdraw` / `withdrawWorkerBond` | creator / worker | Pull-based recovery after a terminal status; each amount at most once. |
| `JobHolding.burnBond` | evaluator only | Burns one side's bond. Only reachable through `rule(..., slashLoser = true)`. |
| `JobHolding.returnBonds` | evaluator only | Returns unsettled bonds to their owners; idempotent. |
| `JobsEvaluator.creatorReject` | creator, **only until `submittedAt + reviewWindow`** | None; opens the dispute window. After the cutoff silence is acceptance even if nobody called the timeout (R16-01). |
| `JobsEvaluator.rule(jobId, forWorker, slashLoser)` | arbitrator, **only until `disputedAt + arbitrationWindow`** | `complete` or `reject`, then burn the loser's bond only if `slashLoser`, then return the rest. After the cutoff only the refund timeout settles (R16-01). |
| `JobsEvaluator.attachEvidence` / `attachEvidenceDirect` | a registered verifier (signed / calling) | None. Per-verifier record with `submissionHash`, `policyHash`, `testedSha`, `validUntil`; policy must equal the listing's; same verifier + same digest is an idempotent no-op; two verifiers on one digest are both kept (R16-06/07). |
| ERC-8004 feedback (inside every settlement) | evaluator, as client of record | None. Capped at 300k gas in `try/catch`; `FeedbackRecorded` or `FeedbackFailed`; never reverts a payout (R16-10). |
| the four timeouts | anyone | `complete` or `reject`; never burn. |

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
