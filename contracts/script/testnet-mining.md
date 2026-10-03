# Ended earned epochs on testnet

The existing `mine-epoch0-testnet.sh` command defaults to epoch 0. Append
`--epoch N` to process a later epoch that contains paid treasury fees:

```bash
heavy bash contracts/script/mine-epoch0-testnet.sh \
  <unsigned-prices-for-N.json> <new-private-output-directory> \
  --claim-key-env TESTNET_WORKER_PRIVATE_KEY --epoch N
```

Use the deployed reserve's `epochStart(N)` / `epochEnd(N)` to select the window.
A paid `FeeCharged` event at settlement determines its epoch; job publication and
artifact upload times do not. Both the latest and finalized heads must reach the
selected epoch's end before the helper reads keys or creates its journal (exit 4
until then). The price input must name that same epoch as a decimal string.
An empty earned epoch refuses before any funding or root transaction.

The helper signs prices, computes `epoch-N.json`, performs nonce-bound ECDSA Safe
funding and root publication, publishes to staging with readback, then claims and
checks the vault stake increase. It refuses chain 143 and holds the launch lock.
Keep all Safe and wallet writers serialized across checkouts; the lock is local
to one checkout.

Use a new private output directory for each deployment/epoch/price input. Retry
an interrupted operation with the same command and directory: saved drafts and
signed outer bytes are reconciled before any new send. Never delete the journal
or rewrite cached artifacts to bypass a binding or nonce refusal. A funding
snapshot change requires reconciliation before deliberately recomputing in a
new directory. Epoch-0 transaction keys remain compatible. Deployment bindings use
the BigInt-aware flow-journal serializer; any different saved binding refuses and
must be reconciled rather than migrated automatically.
