# ADR-0004: Finished-work contests, signed hire handshake, slashing, approver (R20)

Date: 2026-09-26. Status: **accepted, not implemented.** Spike S7 (contracts) and S8 (board) build it; until
then the code at `47c4dd2` implements ADR-0003's model. Spec: myplan note 12, R20 synthesis.

## Decision

Decided by Kris in the R20 round (ChatGPT review comments R20-01…R20-11) and the grilling of 26 Sep:

- **Two modes, three routes.** *Hire at a fixed price* (or at a picked quote): apply → creator selects → the worker's final confirmation activates
  a funded, bonded agreement. *Contest*: finished work; the approver may **award early**, which accepts the
  chosen entry and pays it in the same transaction with no follow-up by the winner. An award is never a
  cancellation for a refund. No award by `selectionDeadline` → permissionless expiry and refund.
- **Contests carry no worker bond** in this version; Holding refuses `workerBond > 0` on a contest. Entrants
  are never slashed; losing is never a penalty.
- **Hire handshake.** The creator (payer) signs an EIP-712 `Selection(jobId, worker, agentId, termsHash,
  activateBy, nonce)` off-chain. The worker's single `activate` transaction checks it and the ERC-8004 agent
  wallet, sets the provider, posts the bond, sets the budget and funds. Nothing is on-chain before that, so a
  lapsed selection costs no transaction and the same jobId goes to the next applicant.
- **Slashable:** a funded worker missing the delivery deadline, poor work against the published criteria,
  falsified evidence. The penalty is the whole posted bond. A rejection names
  `violation ∈ {none, quality, falsified}` and a reason hash; a violation burns only if the filing window
  passes undisputed or the arbitrator upholds it; `none` refunds and returns both bonds. A missed delivery
  burns permissionlessly after the deadline. Replaces ADR-0003's "timeouts never burn".
- **Late delivery.** A submission after `deliveryDeadline` gets no silence right; anyone may burn right
  after the deadline; the approver may still accept the late work until someone executes the burn.
- **Approver.** Each offer names a nonzero `approver` (default the creator; may be the creator's agent or the
  platform review wallet). It accepts or rejects hired work and awards contests. The creator stays payer and
  refund owner and alone signs selections. No spending authority; general delegation stays deferred.
- **Worker identity.** The registered agent wallet participates; admission checks
  `getAgentWallet(agentId) == worker`. No second wallet.
- **Reputation.** No feedback on arbitration timeout (`skip-arb`); reason-aware outcomes; no anti-farming.
- **Pause** does not automatically excuse a missed delivery; the README states the admin commitment not to
  pause during an active agreement.
- **Quote-to-hire is in for the hackathon.** A quote request is a board record ("Accepting quotes — reward
  not escrowed") listing the accepted tokens; a quote names one token and exact amount; quotes are private to
  publisher and bidder until selection; no automatic lowest bid. Picking a quote publishes the ordinary
  escrow-backed offer (terms carry the request and quote hashes) and signs the normal `Selection`; the
  worker activates as in any hire. No contract change for quotes. Two reward tokens for the demo: one
  `MockPaymentToken(name, symbol)` deployed as `mUSD` and `mEUR`, both allowlisted. The demo's hired job
  goes through quotes.

## Proposed mechanics (S7 proves or replaces them)

- Atomic award: a candidate pre-signs the core's `SetBudgetAuthorization` and `SubmitAuthorization` for its
  exact deliverable; `award` chains setProvider → setBudgetWithAuthorization → fund → submitWithAuthorization
  → evaluator completion. The core's calls are `nonReentrant` per call, so sequential calls from Holding are
  fine; any failure reverts all of it and the contest stays open.
- Bond outcomes recorded in Holding; `withdrawWorkerBond` refuses while a penalty is due, whatever the core
  status (today a direct `claimRefund` makes the job Expired and releases the bond).
- The evaluator compares the core's `submittedAt` with `deliveryDeadline` (the core's `submit` ignores it).
- `EvidenceAttached` emits `submissionHash`, `policyHash`, `validUntil`, so history rebuilds from events.
- `_recordOutcome(reason)`; `publish` refuses a zero `policyHash`; `activate` refused after the deadline.

## Why

- The core's `setProvider` is one-shot. An on-chain assign that the worker never confirms can only end by
  rejecting the job, so the provider is set only at the worker's own confirmation.
- A contest winner who must come back to accept, bond and fund is a hire, not a contest; the award must
  work with the winner offline, and a failed award must not trap the prize.
- Entrant bonds would need candidate-scoped escrow before award; left out to keep S7 small (deferred).
- A signature, allowance or board receipt is not collateral or consent the contracts can rely on.

## Consequences

- The S1b contest tests prove select-then-accept only; S7 replaces them. The acceptance list is §13 of the
  spec (S7, S8).
- `contracts/SURFACE.md` carries current and target behaviour side by side until S7 lands.
- No testnet deploy before S7 is green.
