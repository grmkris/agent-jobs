# Work-mining proofs and Collect

The contracts track computes an epoch with [`scripts/mining/README.md`](../scripts/mining/README.md). After the Safe
funds it and publishes its root, the coordinator uploads the exact `epoch-<n>.json` to
`mining/epoch-<n>.json` in the API's existing **Manifests** R2 bucket. The API has no artifact upload tool or fallback
source. Tests may configure a local file reader through `BoardConfig.miningSource`.

REST and MCP expose `mining_proof({wallet, epoch})`, where `epoch` is a canonical uint256 decimal string. It returns:

```
{ epoch, account, token, amount, proof, root, dataHash, eligible, claimed, transactions }
```

Amounts are FACTORY base units. The reader uses `claims[wallet.toLowerCase()]` from the epoch artifact. It verifies
the OpenZeppelin double-hashed `(uint256 epoch, address account, uint256 amount)` leaf and sorted-pair proof with
viem, checks the artifact's chain, epoch and input `dataHash`, and compares root, total and `dataHash` with the
distributor's current `rootOf(epoch)`. No Merkle package dependency is needed. A malformed artifact, mismatched root,
missing file, unavailable bucket or failed chain read refuses the request.

An absent account returns `amount: "0"`, `eligible: false` and no transaction. A claimed account returns its
allocation with `claimed: true` and no transaction. Otherwise the result includes unsigned `claim` calldata with a
500,000 gas floor. Anyone can send it, but the contract stakes the reward only for the leaf's named account.

`collect_actions({wallet})` discovers distinct epochs from the configured distributor's indexed `RootSet` events.
It retains the canonical checkpoint/freshness checks and re-reads every current root and claim state. An unclaimed
allocation becomes a `miningClaim` action with `epoch`, `token`, `amount`, `description` and `transactions`. After its
receipt, refresh Collect or call `mining_proof` again to reconcile. Neither read tool sends a transaction.

Validation covers a contracts-produced claims fixture, tampered proofs and amounts, wrong beneficiaries, current
root changes, real local workerd/R2 reads, and a real local Monad fork claim that increases the named account's stake.
Remote artifact publication and live claims remain coordinator evidence.
