# ADR-0007: JobPool, pooled funding of one offer

Date: 2026-09-30. Status: **implemented, unit-tested (26 tests), deployed on Monad testnet; live proof pending**
(`docs/reality-check.md`). Testnet only.

## Context

A host app embedding the marketplace (ADR-0008) wants its users to crowdfund a feature: many wallets put up the
reward, one worker delivers, a curator judges. `JobHolding` knows one creator per listing, pulls the reward from that
creator at `publish`, lets only the creator cancel and only the creator sign a `Selection`. None of that changes:
`JobHolding` and `JobsEvaluator` bytecode is untouched.

## Decision

- **A pool is the creator.** `JobPool` is a minimal proxy (OpenZeppelin `Clones`) at an address predicted from the
  creator and a salt, so a board can freeze `terms.creator = pool` and compute the offer's `policyHash` before the
  pool exists. Pledgers put the reward token in until the goal is reached (pledges past it are capped, never
  over-collected); anyone then calls `launch`, which publishes the offer on Holding with the pool as `msg.sender`:
  the pool is the listing's creator, its reward came from the pledgers, its creator bond is zero.
- **A curator judges and signs.** The curator, fixed at creation, is the listing's approver (accept, reject, award)
  and the only key the pool honours through ERC-1271, so Holding's `activate` accepts a curator-signed `Selection` for
  a listing whose creator is a contract, and the board's `submit_selection` verifies it the same way. The curator also
  forwards `cancel` and `cancelSelection`, which Holding restricts to the creator.
- **Hold gate.** Holding requires `minHoldToPublish` FACTORY of the publisher. The factory moves that amount from
  the pool's creator into the pool at `create`; it is never spent and returns through `reclaimHold` once the pool is
  over.
- **Refunds, pro rata, only from what comes back.** A paid reward never returns. What returns (a cancelled or
  rejected offer's reward, an expired contest's prize, every pledge of a pool that was cancelled or never launched)
  is split as `pledged × available / totalPledged`, where `available` is the pool's balance plus everything refunded
  so far; `refund` settles the listing first when the core says the job is over, and is idempotent. Rounding dust
  stays in the pool.
- **Timing.** Pledging closes at `pledgeDeadline`; a full pool may still launch for one day after it
  (`LAUNCH_GRACE`), then it is expired and refundable. A full pool is committed: `unpledge` is refused once the goal
  is reached. The delivery deadline must lie past the grace; a contest's selection deadline should too, or a late
  launch fails Holding's check and the pool expires.
- **Governance reserved.** `Params.governance` names how the curator is chosen or overruled. Only `0` (the curator
  decides) exists; any other value reverts. A pledger-vote mode would be a new value, not a new contract.

## Consequences

- The board treats a pool-backed task like any other: the listing's creator is a contract, `board_offers` and the
  indexer see a normal `Published`, and the curator acts where the creator would (select, cancel, judge).
- Pledgers trust the curator's judgement and nothing else: the pool cannot pay anyone but Holding, and Holding pays
  the worker only on the evaluator's say.
- Not built: partial goals (launch below the goal), refunds of a partially paid reward (the protocol has none),
  pledger votes, a pool that funds more than one offer, a fee for the curator.
- Addresses: `docs/reality-check.md` and `contracts/config/monad-testnet.json` (`.deployment.poolFactory`).
