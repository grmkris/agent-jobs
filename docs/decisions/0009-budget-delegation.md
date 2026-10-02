# ADR-0009: Execution budgets as on-chain delegations

**V1 scope note (2 Oct):** the execution-budget authority and expiry rules remain. V1 [gas sponsorship](../sponsorship.md) is a separate delegation and does not sponsor budget draws. Shared admission rates and relay nonce/cap recovery now exist; the later text saying an upgrade needs a limit is the dated September readiness snapshot. The live jobs named here prove legacy budgets, not the v1 matrix.

Date: 2026-09-29. Status: **implemented, fork-tested, and live on Monad testnet staging with a Privy server wallet as
the creator** (jobs 58–59, `docs/reality-check.md`). The grant from an embedded wallet in Explore is not live-verified
yet. Supersedes ADR-0005. Decided in myplan note 12 §16 (R124).

## Context

ADR-0005 spent a creator's budget through a Privy session signer: the board held a key over creator funds, Privy's
policy bounded each transfer, and the running total lived only in the board's ledger. ChatGPT's 29 Sep review and our
own research found a cleaner shape. The MetaMask Delegation Framework (ERC-7710, v1.3.0) is deployed on Monad 10143
and 143 at the same addresses, and enforces the whole budget on-chain. The worker can then draw it from its own
wallet, and the board goes back to holding no keys and moving no money.

## Decision

- **What a budget is.** An offer may carry one `executionBudget`, frozen into the terms and so into the `termsHash`
  the worker activates against. Hire only; a contest never has one. It expires no later than the delivery deadline.
  - `{kind: 'advance', token, cap, expiresAt}`: the worker may move up to `cap` of any ERC-20 the creator names from
    the creator's wallet **to the worker's own wallet**, and pays its providers from there (x402 included).
  - `{kind: 'call', target, function, cap, expiresAt}`: the worker may make **one** call to one function of one
    contract from the creator's wallet, sending at most `cap` native value. This is for actions the creator must own,
    such as launching a token on nad.fun, which records `msg.sender` as the creator.
  - A quote's `expectedCosts` stay separate from its price. The creator approves a budget, possibly smaller than
    asked, when picking the quote; picking alone approves nothing.
- **The grant is a delegation** from the creator's account to the activated worker, signed as EIP-712 under the
  DelegationManager's domain. Root authority; `salt = termsHash`, so one hire has one delegation and a revoked one
  stays revoked. Caveats:
  - advance: `ValueLte(0)`, `ERC20TransferAmount(token, cap)`, `AllowedCalldata(offset 4, the worker's address)` so
    the worker is the only recipient, `Timestamp(0, expiresAt)`;
  - call: `AllowedTargets(target)`, `AllowedMethods(selector)`, `ValueLte(cap)`, `LimitedCalls(1)`,
    `Timestamp(0, expiresAt)`.
- **The creator's account is an EIP-7702 DeleGator.** At grant time, when the account does not point at
  `EIP7702StatelessDeleGatorImpl` yet, the creator signs an authorization for it and the board's relay sends the type-4
  transaction (`upgrade_account`). Privy's embedded wallets run in Privy's TEE, whose transaction signing drops
  `authorizationList`, so they cannot send it themselves; a wallet that can may send its own. The same DeleGator serves batched
  transactions for everyone (`execute(bytes32,bytes)` in batch mode); Simple7702Account is gone.
- **A grant needs the job `active`.** The delegation names the worker and is valid on-chain from the moment it is
  signed, with no job check, so granting before the worker has posted its bond would let it draw without one.
- **The worker draws from its own wallet.** `spend_budget` and `spend_budget_call` return a `redeemDelegations`
  transaction to the manager; the worker sends it and reports it. `get_budget` returns the signed delegation, so the
  worker, or anyone it asks, can redeem without the board. `report_transaction` mirrors any `RedeemedDelegation` for
  the hire, prepared by the board or not; the amount comes from the token's `Transfer` log or the call's value.
- **The board's checks are courtesy, the chain's are the rule.** Before preparing a draw the board refuses: not the
  activated worker, not granted, job not `active`, core paused, over the cap (read from the enforcer's `spentMap`),
  the wrong function, too much value, a second call. The chain refuses the same over-cap, wrong-recipient,
  wrong-function, second-call and expired draws on its own.
- **Ending.** The expiry ends a budget on-chain. The creator revokes with `disableDelegation`, which `revoke_budget`
  prepares. When the job settles, expires or lapses, the board stops preparing draws, and Explore prompts the creator
  to disable the delegation while the chain would still honour it (`redeemable`).
- **No runtime MetaMask SDK.** The board encodes with viem only: `@metamask/smart-accounts-kit` reports telemetry from
  `createDelegation`. `contracts/config/<network>.json` holds the framework's addresses; a unit test pins them to
  `@metamask/delegation-deployments`, and cross-checks caveat terms, delegation hashes and the permission context
  against `@metamask/delegation-core`, both as dev dependencies.
- **Removed, not disabled:** the Privy session signer and policy builder, the board's budget ledger, the x402 remote
  signer (`sign_budget_x402`), their scripts and env vars. Stored tasks with an older budget shape are deleted when
  the board migrates.

## Consequences

- **The board holds no key over anyone's funds again.** The cap, the recipient, the function, the call count and the
  expiry are enforced by audited contracts; a board outage or compromise cannot move a creator's money.
- **The worker holds the advance.** What was drawn is the worker's, including on rejected work, as in ADR-0005; the
  rest never left the creator's wallet.
- **Between the job's end and the expiry, only the creator's revoke stops a draw.** The board refuses to prepare one,
  but a worker can redeem directly. Short expiries and the revoke prompt bound this.
- **The worker pays the gas** of every draw; a call budget's value comes from the creator's account. Monad keeps a
  delegated account from dropping below 10 MON except for gas, so a value-bearing call needs `cap + 10 MON` in the
  creator's wallet; Explore checks it.
- **Only a Privy email/Google wallet can grant in Explore**, since it signs the 7702 authorization for the DeleGator.
  A browser-wallet creator can publish a budget but not grant it there. The creator's account stays a DeleGator
  afterwards. The relay pays for each upgrade; it gains no authority, but anyone signed in can make it spend gas once
  per fresh account, which needs a limit before mainnet.
- **Not built:** sub-delegation, periodic or streaming allowances, project-level delegation, a grant UI for browser
  wallets, and paying x402 on the creator's behalf (a worker pays x402 from its own wallet after an advance).
