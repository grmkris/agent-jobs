# ADR-0005: Execution budget through a Privy session signer

Date: 2026-09-28. Status: **implemented and fork-tested; the Privy side is proven live on Monad testnet with a
server wallet** (`docs/reality-check.md`, "execution-budget spike"). The embedded-wallet grant in a browser is not
live-verified yet. Testnet only.

## Context

ChatGPT's 28 Sep review in myplan proposed three things:
- a worker's quote should list expected running costs (models, compute, APIs) apart from its price;
- picking a quote should not approve those costs by itself;
- one bounded "SpendingGrant" per hired agreement should be pulled out of the deferred delegated-authority topic.

Kris chose to build it on testnet with what ships with Privy rather than a new contract.

## Decision

- **What a budget is.** An offer may carry `executionBudget {token, cap, expiresAt}`, frozen into the terms and so
  into the `termsHash` the worker activates against.
  - Hire only; a contest never has one.
  - The token is any allowlisted reward token, possibly not the reward's.
  - It expires no later than the delivery deadline.
  - A quote's optional `expectedCosts` is separate from its price. The creator approves a cap, possibly lower than
    asked, when picking the quote; picking alone approves nothing.
- **Nothing is escrowed.** The worker spends from the creator's wallet. What was spent is spent, including on
  rejected work; the rest never left.
- **Enforcement in two layers.**
  - The creator's Privy embedded wallet adds the board's P-256 key (a Privy key quorum) as a session signer,
    restricted to a **person-owned** policy. Privy's policy engine checks every transaction against it: chain 10143,
    an ERC-20 `transfer` on the budget token, no value, amount at most the cap, before the expiry.
  - The board enforces what Privy cannot:
    - the cumulative cap (a ledger row is reserved before any money moves, and the row id is Privy's idempotency
      key);
    - that the caller is the job's activated worker;
    - that the job is `active`;
    - that the core is not paused;
    - revocation, immediately.
  - `to` is free: the worker may pay itself or a provider.
- **The board never edits a policy.** The policy is person-owned, so the board cannot widen it. A change (a second
  grant, or dropping ended ones) is a fresh policy, and the creator's browser re-attaches the signer under it
  (remove, then add; Privy allows one policy per signer). The alternative, an owner-signed PATCH, is unproven: froggy
  recorded it as its open gate.
- **A policy holds only live grants, plus the one being granted.** Granting one task never authorizes another
  task's merely promised budget.
- **End of a grant.** A grant ends when:
  - the job settles, expires or lapses (the board stops signing at once);
  - its time runs out;
  - the creator revokes it.

  `get_budget` then tells the creator to remove the signer, or to re-attach it under a smaller policy. The policy's
  expiry is the backstop.

## Amendment (29 Sep 2026): call budgets

A budget may instead allow **calls** to one contract function from the creator's wallet:
`executionBudget {kind: 'call', target, function, cap, expiresAt}`, where `function` is one human-readable ABI item
and `cap` is native value in total.

- **Why.** A creator hiring an agent to launch a token on a launchpad (nad.fun) should own the token. The launchpad
  records `msg.sender` as the creator, so the call has to come from the creator's wallet, not the worker's.
- **Privy rule.** `to == target`, `value ≤ cap`, `function_name == <name>` decoded with that one-function ABI, before
  the expiry, on this chain. Any other function or contract is refused by Privy itself.
- **Board.** `spend_budget_call({taskId, data, value, note})`: the same worker/grant/job/pause checks as a token spend,
  the calldata's selector must be the allowed function's, and the ledger holds the cumulative value. Gas is the
  creator's. A token budget keeps its old shape (no `kind`), so older terms hashes are unchanged.
- **Proven** on an anvil fork of Monad testnet: nad.fun `create()` sent from the creator's wallet under a 12 MON call
  budget, the creator in the launch event, the second 10 MON call refused as over the budget
  (`budget.fork.test.ts`). The live run follows once the creator's wallet holds MON.

## Consequences

- **The board holds a key over creator funds.** This changes the board's trust model. Until this ADR, the board
  "never holds keys or moves money"; its relay and attester keys carry no authority.
- **If the key leaks**, the bound is per transaction per live rule, until expiry: Privy still enforces token, cap and
  expiry, but the cumulative cap lives only in the board. Keep expiries short, rotate the quorum through Privy
  (`packages/board/scripts/budget-signer-key.ts` makes a new one), and remove signers after use.
- **The creator's wallet pays gas** for each spend. Explore warns when its MON is low; a failed send releases the
  reservation.
- Only a creator signed in with a Privy email/Google wallet can grant. A browser-wallet creator can still publish a
  budget, but cannot grant it.
- **Not built:**
  - general project-level delegation and recurring allowances;
  - sub-delegation;
  - a separate execution wallet;
  - an on-chain 7702 delegate. That would be the trustless upgrade: the cumulative cap enforced on-chain, with no
    board key. See `docs/projects-and-roles.md`.
