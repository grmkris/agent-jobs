# ADR-0002: Escrow model — Holding as the ERC-8183 client

Date: 2026-09-25. Status: accepted; v1 terms are defined by [ADR-0011](0011-sidequest-v1.md).

## Decision

`SidequestHolding` is the ERC-8183 client of every listed job. The reward is escrowed at publish. Worker activation
confirms the frozen listing, sets provider and budget, reserves the worker bond and funds the core. The worker signs
budget authorization for the freshly quoted net reward. Creator and worker bonds remain stake reservations in
`StakeVault`, outside the core. `SidequestEvaluator` records the outcome and makes the core's terminal calls.

## Why it works against the pinned core

- `client = msg.sender` in `createJob`; a contract can own the escrow and remain the client.
- Provider budget authorization can be relayed without a core patch.
- `reject` is terminal and refunds immediately, so the evaluator records the approver's rejection on-chain and only
  calls `reject` after an undisputed dispute window or a ruling for the creator.
- Core expiry cannot pre-empt timely submission, review, dispute filing or arbitration: publish checks that expiry
  covers the delivery deadline and all frozen settlement windows plus the margin.
- Core status alone never releases a reservation whose penalty is due. Failed worker payout remains earned; deferred
  recovery retries the recorded outcome, and refused transfers become separately withdrawable `owed` balances.

## Consequences

The chain establishes funding and settlement. A board-service receipt cannot replace those facts. The core admin can
pause, upgrade and withdraw escrow while paused; those trusted powers remain explicit.
