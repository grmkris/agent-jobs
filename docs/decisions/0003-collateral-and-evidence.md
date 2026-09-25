# ADR-0003: Collateral, modes and evidence

Date: 2026-09-26. Status: accepted (spike S1b).

## Decision

Two assets. The reward is any payment token the core allowlists; `$FACTORY` is collateral and never enters
the core. Collateral takes two forms: a **hold requirement** (a wallet must hold `minHoldToPublish` /
`minHoldToClaim` FACTORY to publish or to post a worker bond; sybil resistance only, not slashable) and
**per-job bonds** (`creatorBond` pulled at publish, `workerBond` pulled at accept, both locked in Holding
through settlement). No account-level stake vault yet.

The arbitrator makes **two findings**: `rule(jobId, forWorker, slashLoser)`. The reward settles per
`forWorker`; the loser's bond is **burned** only when `slashLoser` records a predefined violation.
Timeouts never burn. Losing a quality dispute is not misconduct.

Two **modes** on a task. Hire-first: apply, assign one, accept, fund. Contest: prize and creator bond locked
at publish, candidates collected off-chain, the creator picks one before `selectionDeadline` (which then
proceeds like hire-first), or anyone expires the contest and the prize returns. "Silence is acceptance"
applies to an assigned worker, never to entrants.

**Evidence**: a registered verifier signs an EIP-712 `EvidenceAttestation` naming the tested commit and
the checks; `attachEvidence` (EOA or ERC-1271 signer) or `attachEvidenceDirect` (a verifier contract such
as `EvidenceReceiver` fed by a Chainlink CRE forwarder) stores the digest. It moves no money. Gating
payouts on evidence is a later, opt-in policy that must apply to every payout path.

## Why

- ChatGPT's review: "who receives the reward" and "did someone violate a slashable obligation" are
  different findings; bundling them would make every lost dispute a slash.
- Burning rather than paying the counterparty removes the incentive to provoke disputes for profit.
- Per-job bonds satisfy "reservations never exceed the deposit" trivially; the vault is the refinement.
- A hold check cannot be slashed and can be gamed by moving tokens after the check; it only deters spam.
- A contest needs the prize locked before entrants work, or the creator can withdraw after reading them.
- Evidence and gating are different features; a gate that skips `completeAfterSilence` is not a gate.

## Consequences

- `via_ir = true`: the 15-field `Listing` getter exceeds the legacy stack.
- 35 tests (34 lifecycle incl. fuzz over both assets and all four ruling combinations, 1 invariant over
  both tokens, both bonds and burned supply) plus 4 opt-in fork tests.
- Publish needs two approvals (payment token + FACTORY); accept needs one. The skill and the Publish
  screen batch them; the faucets hand out both tokens.
- `EvidenceReceiver` is a minimal `IReceiver`; spike S5 swaps in Chainlink's `ReceiverTemplate` and pins
  the Monad forwarder.
