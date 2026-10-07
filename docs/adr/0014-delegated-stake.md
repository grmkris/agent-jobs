# ADR-0014: Delegated stake

Date: 2026-10-05. Approved design: vault-v2 plan section 1. This supersedes the
staking ownership and exit accounting in ADR-0011. Verification and independent
review are recorded in the contracts pane status; this ADR does not establish a
live deployment.

Any wallet can back an account with SIDE and retain its own position. A payer
can fund a different delegator through `delegateFor`; mining creates a self
position with `delegateFor(account, account, amount)`. The account owns its
Holding veto, while each delegator owns its withdrawal rights. There are no
delegator lists, position transfers, donation entry point, or profit payments.
Operations take constant time.

Each account has `Pool { assets, reserved, shares, queuedShares, generation }`.
Each `(account, delegator)` has `Position { shares, queuedShares, unlockAt,
generation }`. Position shares include queued shares. Initial deposits mint
one share per asset; later deposits mint `floor(amount * shares / assets)`.
A zero-share mint reverts. Redemption floors `shares * assets / totalShares`,
and the final shares receive exactly the remaining assets. Full-precision
arithmetic and checked casts prevent silent truncation.

Active backing is `floor((shares - queuedShares) * assets / shares)`. Holding
snapshots the fee tier from this total backing at activation, including backing
owned by other wallets. Available backing saturates at zero after subtracting
reservations. Requests can therefore leave reservations above active backing:
the invariant is `reserved <= assets`, rather than `reserved <= stakeOf`.
`totalAssets` includes queued backing, and `totalReserved` sums all reservations.
The vault token balance is at least `totalAssets`. Direct token transfers are
unaccounted surplus and cannot change share prices. There is no aggregate
`totalQueued` view; value each pool's queue against its own current share price.

Requesting an exit queues shares and restarts the cooldown for the entire
position queue: seven days in production, 600 seconds with the testnet clocks.
Queued shares immediately stop counting for tiers and new bonds. Cancellation
restores them to active backing. Neither operation transfers tokens or changes
share ownership. Withdrawal pays only the delegator, after unlock, and reverts
`StillBonded(remaining, reserved)` unless remaining assets cover every bond.

A slash removes and burns only the calling Holding's reserved amount. It reduces
pool assets and reservations by the same amount, sharing the loss across every
share, including queued shares. A full slash clears pool shares and queued
shares, increments its generation, and emits `PoolReset`. Older positions read
as zero in the current generation and are cleared lazily when touched. They
cannot recover their value through a new deposit or queue cancellation.
Bootstrap, Holding admission, revocation, per-Holding reservations, and the
account veto keep their existing behavior. A revoked Holding still settles its
own reservations; delegation stays closed until first Holding authorization.
Permit delegation tolerates an already-submitted permit when its allowance
still permits the transfer.

The accepted testnet edges are:

1. A ruling after the cooldown can miss a delegator who withdrew with sufficient
   headroom. Review and arbitration windows can outlast seven days. Revisit this
   before mainnet; this design does not promise exposure after withdrawal.
2. Request/cancel can change the tier just before activation. A stale signed net
   budget then reverts atomically; the SDK must quote and sign again.
3. Repeated near-total slashes can inflate one pool's share count. Deposits cap
   total shares at `uint192` before taking tokens, so every accepted position
   still fits a single withdrawal queue. A pool can stop accepting new backing
   until all positions exit and it empties; its next deposit then mints 1:1.
   The agent can also start fresh on a new wallet, without moving existing
   positions. Other Holdings' bonds remain reserved until release/slash; no
   unreserved dust is burned. Products use `Math.mulDiv` even when intermediate
   shares times assets exceed `uint256`. This limitation affects that pool only
   and needs another review before mainnet (VV2-001).
4. Positions are keyed by account wallet address. Agent-wallet rotation does not
   move backing or delegator positions to the replacement address.

`Delegated` identifies account, owner, payer, assets, and minted shares.
`UndelegateRequested` identifies the shares queued, their current asset value,
the whole queue, and unlock time. `UndelegateCancelled` and `Withdrawn` identify
the shares and current asset value. `Reserved`, `Released`, and `Slashed` keep
their existing formats. `PoolReset` supplies the new generation. Together these
events reconstruct all pools and positions, with old positions normalized at a
reset; token transfer events are unnecessary for that ledger. A replay test
checks storage against the event-only reconstruction.

Future profit-sharing epochs can integrate each delegator's active shares over
time from this ledger, produce a per-wallet Merkle distribution, and publish it
through a separately approved design. These events establish ownership and
exposure; they neither distribute job revenue nor promise earnings today.
