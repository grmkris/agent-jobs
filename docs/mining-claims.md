# Work-mining proofs and Collect

The contracts track computes an epoch with [`scripts/mining/README.md`](../scripts/mining/README.md). After the Safe
funds it and publishes its root, the coordinator uploads the exact `epoch-<n>.json` to
`mining/epoch-<n>.json` in the API's existing **Manifests** R2 bucket. The API has no artifact upload tool or fallback
source. Tests may configure a local file reader through `BoardConfig.miningSource`.

REST and MCP expose `mining_proof({wallet, epoch})`, where `epoch` is a canonical uint256 decimal string. It returns:

```
{ epoch, account, token, amount, proof, root, dataHash, eligible, claimed, transactions }
```

Amounts are SIDE base units. The reader uses `claims[wallet.toLowerCase()]` from the epoch artifact. It verifies
the OpenZeppelin double-hashed `(uint256 epoch, address account, uint256 amount)` leaf and sorted-pair proof with
viem, checks the artifact's chain, epoch and input `dataHash`, and compares root, total and `dataHash` with the
distributor's current `rootOf(epoch)`. No Merkle package dependency is needed. A malformed artifact, mismatched root,
missing file, unavailable bucket or failed chain read refuses the request.

An absent account returns `amount: "0"`, `eligible: false` and no transaction. A claimed account returns its
allocation with `claimed: true` and no transaction. Otherwise the result includes unsigned `claim` calldata with a
500,000 gas floor. Anyone can send it, but the distributor calls
`delegateFor(account, account, amount)`: the leaf's named account owns the resulting
self-position. The payer of the claim acquires no shares. It adds to that account's
active backing; it does not fund an operator-owned position or transfer liquid
SIDE to either wallet. Claims remain wallet-paid.

Backing is total SIDE behind an account; a position is one owner's shares.
Read `get_stake({account, wallet: account})` for backing and the mining self-position,
or `list_delegations({wallet: account})` for indexed discovery. An operator's separate
position behind that agent stays operator-owned. Positions do not follow an
ERC-8004 wallet rotation.

The self-position can queue an exit even while bonded. Adding shares to the queue
restarts its whole cooldown (600 seconds on testnet, seven days in production).
Queued shares stop counting for the tier and new bonds but remain slashable until
successful withdrawal. `StillBonded` may extend the wait past unlock. A managed
agent's exact exit requires operator approval before a one-call
`requestUndelegate(account, exactShares)` grant with a ten-minute expiry; routine
vault work covers self-position cancellation and withdrawal. See
[the staking API](staking-api.md) and [agent authority](decisions/0013-agent-authority.md).

`collect_actions({wallet})` discovers distinct epochs from the configured distributor's indexed `RootSet` events.
It retains the canonical checkpoint/freshness checks and re-reads every current root and claim state. An unclaimed
allocation becomes a `miningClaim` action with `epoch`, `token`, `amount`, `description` and `transactions`. After its
receipt, refresh Collect or call `mining_proof` again to reconcile. Neither read tool sends a transaction.

Validation covers a contracts-produced claims fixture, tampered proofs and amounts, wrong beneficiaries, current
root changes, real local workerd/R2 reads, and a real local Monad fork claim that increases the named account's self-owned backing.
Remote artifact publication and live claims remain coordinator evidence.
