# G1b → G1c SIDE refunds (coordinator only)

`refund-manifest.mjs` reads Monad testnet at one finalized block. It queries the
entire G1b vault/token log range through authenticated HyperSync, discovers
registry wallets from registration/metadata history, and reads balances through
the RPC at that same block. It reconciles every active/cooldown account and both
global vault totals. No signing, transactions, deployments or D1 writes occur.

The prepared evidence lives in `docs/evidence/testnet-g1c/refund-manifest.json`
and `refund-manifest.snapshot.json`. It is a preparation snapshot, not proof that
G1b is wound down or G1c is deployed. G1b currently has no operator-funded
deposit; operator ownership variants are covered by pure unit cases, not claimed
as live operator evidence.

For a final snapshot after wind-down, choose a fresh output path, review and
commit the resulting files before using them. Existing evidence is never
overwritten by this command. Export the RPC and HyperSync token from the usual
environment; do not pass secrets on the command line.

```sh
node contracts/script/refund-manifest.mjs --out docs/evidence/testnet-g1c/final-refunds.json \
  --wallet 0x2a90CA4fF318CDDa5e740678e7cC21e943fCA4ae \
  --wallet 0xBd3F394940474c31fA444B102AF0a8043a1FCCA6
```

Ownership is inferred only for a payer proven to be the account's registry owner
at the deposit block. Self-stake, mining-distributor deposits and other payers
remain owned by the account. Active and cooldown assets both become G1c
positions. A debit from a pool with multiple possible owners fails closed rather
than inventing a split. An incomplete ledger or inconsistent RPC read also
refuses. Old SIDE is not burned or moved by these refunds.

Loose wallet inventory includes token transfer senders/recipients, vault
accounts/payers, their registry operators, and explicit product wallets. The
demand bot and A01f operator are explicitly read even if their balances are zero.
Known protocol/liquidity contracts and genesis recipients are itemized as
excluded. G1c recreates treasury, reserve, vesting, ecosystem and liquidity
allocations; paying those again would duplicate allocations. A nonzero balance
at an unclassified contract stops generation for inventory review. Registered
agent wallets and 7702 EOAs are recognized as wallets.

The funding wallet is the ecosystem recipient in the launch config,
`0x675269d710692d4d0d7166da11B76463577aad73`, also the deployer and liquidity
recipient. The recipe gives it 100M ecosystem plus 50M liquidity SIDE v3.
The batch verifies the supplied private key belongs to this configured wallet.

After G1c promotion and bootstrap, preview the reviewed manifest without a
private key. `--yes` is required to sign/send:

```sh
bash contracts/script/refund-batch.sh --manifest docs/evidence/testnet-g1c/final-refunds.json
bash contracts/script/refund-batch.sh --manifest docs/evidence/testnet-g1c/final-refunds.json --yes
```

The default key variable is `DEPLOYER_PRIVATE_KEY`; `--key-env NAME` can select a
different exported variable. The script refuses all chains except 10143. It
requires fresh RPC/HyperSync evidence that no G1b token/stake activity occurred
after the snapshot; a changed wind-down balance requires a new reviewed
manifest. G1c addresses must differ from G1b and its deployment must follow the
snapshot. The vault's SIDE and Holding authorization are read back before send.

A kernel lock protects `.g1c-refunds/journal.json` (directory 0700, file 0600).
The binding pins the entire new config, manifest checksum and funding wallet.
The SDK `FlowJournal` persists exact signed bytes/hash/nonce/sender with fsync
before broadcast. Resume verifies the signed chain, sender, destination,
calldata, value, nonce and hash against the original intent. It queries receipts
first, replays only the saved bytes when absent, and refuses a consumed nonce
without that receipt. Confirmed operations do not run twice; a changed binding
or failed receipt needs manual reconciliation. Never delete the journal or use
a fresh directory to bypass an interrupted batch.

The approval is the exact total position amount; transfers and `delegateFor`
operations each have stable keys. Preflight requires only the still-unconfirmed
token total, so a partially completed batch can resume with a lower balance.
After completion, compare Delegated/Transfer receipts and resulting positions
and balances. A successful transaction list is not hosted UI acceptance.

```sh
node --test contracts/script/refund-model.test.mjs
bun --no-env-file test contracts/script/refund-journal.test.ts
```

Tests replay the actual sanitized G1b logs, include historical cooldown assets,
and check operator/mining/self ownership rules as pure cases. Offline test-key
signatures verify journal binding/intent and actual durable filesystem reload;
no RPC clients are mocked and no transaction is broadcast.
