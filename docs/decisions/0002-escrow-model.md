# ADR-0002: Escrow model — Holding as the ERC-8183 client

Date: 2026-09-25. Status: accepted (spike S1).

## Decision

`JobHolding` is the ERC-8183 client of every listed job. The creator deposits the reward and an optional
bond (same token) into Holding at publish; Holding creates the core job with no provider, assigns the
worker with its ERC-8004 agent id, and funds the core once the worker has accepted by setting the
budget to exactly the listed reward. `JobsEvaluator` is the evaluator of every listed job; it holds the
minimal dispute state and only ever makes terminal calls on the core. The bond never enters the core.

Alternatives rejected: a stake gate as the core's `fund` hook (hooks cannot run on `createJob`, so a
listing could not prove anything at publish, and it needed a second token); pre-deposit with an
authorization wrapper (the provider sets the budget, so the client cannot pre-fund).

## Why it works against the pinned core (`142e669c`)

- `client = msg.sender` in `createJob`; nothing forbids a contract client.
- `setBudget` is provider-only, and `setBudgetWithAuthorization` executes as the signer, so the accept
  step is one worker signature that anyone may relay. No core patch.
- `reject` is terminal and refunds immediately, so the evaluator records a creator's rejection itself
  and calls `reject` only when the dispute window lapses undisputed or a ruling goes against the worker.
- `claimRefund` cannot be hooked; Holding requires `expiredAt >= deliveryDeadline + settlementWindow`
  so it can never pre-empt review, dispute filing or arbitration.
- Refunds arrive in Holding without a callback, so recovery is pull-based: `withdraw` reads the core
  job's status and pays each of reward and bond at most once.

## Found by the tests

The invariant suite caught a stranding path in the first draft: the core allows `submit` on an Open
job with budget 0, so an assigned worker could submit *before* accepting, and the creator's `accept`
would have completed the job with a zero payout while the reward sat in Holding with no way out. The
evaluator now refuses to settle any job Holding never funded, and `rejectAfterDeliveryDeadline` clears
such a job so the creator recovers immediately rather than at expiry.

## Consequences

- `contracts/SURFACE.md` classifies every external function of the core.
- The windows (review, dispute, arbitration, margin) are constructor arguments of the evaluator;
  the demo deploy uses minutes, the default config days.
- ERC-8004 feedback is a no-op hook in `JobsEvaluator._recordOutcome` until spike S2 confirms the
  registry ABI.
- The core proxy is ours: deployer EOA is admin, fees 0, one allowed token, no hooks.
