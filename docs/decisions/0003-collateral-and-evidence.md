# ADR-0003: Collateral and evidence

Date: 2026-09-26. Status: accepted; v1 custody and settlement follow [ADR-0011](0011-sidequest-v1.md).

## Decision

The reward can be any ERC-20; collateral is fixed-supply SIDE v2 stake. Both creator and worker bonds are reservations
in `StakeVault`. Release unlocks stake and slash burns the reservation with `Factory.burn`.

The arbitrator makes two findings: whether the worker earned the reward, and whether a predefined violation justifies
a bond burn. Reward and penalty decisions remain separate. Missing delivery, poor work against published criteria and
falsified evidence are slashable only through the protocol's recorded deadlines, dispute window or ruling. Silence and
arbitrator inactivity never burn.

Evidence is advisory. A registered verifier signs an EIP-712 `EvidenceAttestation` naming the tested commit and checks.
The attestation is bound to its verifier, digest, policy and submission; a signature proves who reported it, not its
truth. Attaching evidence moves no money. A payout gate, if introduced, would need to cover every settlement path.

## Consequences

- Creator and worker agree to the frozen criteria and penalties before activation.
- Rejection cutoffs close late opposing actions; a finalized timely submission earns acceptance after silence.
- Reputation feedback is best effort with a bounded gas call. `FeedbackFailed` means the registry write did not succeed
  and never reverses payment.
- A hostile reward token cannot release bonds early, trap them behind its own payout failure, or reverse an earned
  outcome into a creator refund.
