# Work mining: one epoch (B8)

After the Safe has funded and published the epoch root, the coordinator publishes
the computed file for Collect:

```
pnpm mining:publish <epoch-n.json> --stage staging|prod
```

This checks the selected network config, RPC chain id, every claim/proof, the
serialized standard-v1 tree (encoding, nodes, values and indexes), total and
recomputed `dataHash`, then requires the file's root/total/dataHash to equal
`EpochDistributor.rootOf(epoch)`. It uploads the captured file bytes to
`mining/epoch-<n>.json` in the existing Manifests bucket and reads them back to
compare sha256. A failed readback exits unsuccessfully; retry the same file.
It sends no on-chain transaction and never creates or changes Alchemy state.

Credentials come from `.env.local` over the shell environment:
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and the stage's
`MONAD_TESTNET_RPC_URL` or `MONAD_MAINNET_RPC_URL`. Existing stage/network env
settings must agree with `--stage`. Values, bucket names, URLs and provider
error bodies are never printed. Staging uses the canonical Api/Manifests
identities from the guarded release; prod resolves exactly one Api by Alchemy's
stack/stage/logical-id ownership tags. Both verify the Api's runtime stage/network
and its Manifests binding against the same generated naming used by
`Bucket('Manifests')` in `alchemy.run.ts`, including the deployed instance suffix.
No bucket suffix is guessed or overridden. Unit tests use fake R2 only; the
coordinator runs live publication.

`pnpm mining:epoch <n>` computes epoch `n`'s rewards from chain data alone, then writes the Merkle tree the
`EpochDistributor` pays from, plus the Safe's two calls. It never reads the indexer or D1. Rules: ADR-0011, D12 #2, D17.

```
pnpm mining:epoch <n> [--network monad-testnet|monad-mainnet] --prices <signed price list JSON> --out <dir>
                      [--rpc <url>] [--config <config JSON>] [--page <blocks>]
```

- **RPC.** `--rpc`, else `MONAD_TESTNET_RPC_URL` or `MONAD_MAINNET_RPC_URL`. It reads only and is never printed.
- **Config.** `--config` defaults to `contracts/config/<network>.json`; its `deployment.hireling` and every
  `hireling-v1` pair are used. The fork rehearsal passes a scratch config.
- **Paging.** Logs are read with `eth_getLogs` in pages of `--page` blocks (default 1000; it must be a positive integer). A page the RPC refuses is
  halved and retried.
- **Tests.** `bun test scripts/mining` runs the fixture tests. The anvil fork run is step 7 of
  `contracts/script/rehearse-launch.sh`.

## What it counts

1. **Window.** From `MiningReserve.epochStart(n)` to `epochEnd(n)`: epoch 0 is 72 h from genesis, later epochs 7
   days. A log counts when its block timestamp is at or after the start and before the end.
   - Everything is read up to the **finalized** head, which must be past the window's end, so a reorg cannot change
     what was counted.
   - The window's last block hash is in `inputs.window.toBlockHash`.
2. **Events.** `FeeCharged`, `PayoutOwed` and `OwedWithdrawn` from every `hireling-v1` Holding in the config, over the
   window's blocks.
3. **Priced tokens only.** A fee counts only if its token is on the epoch's signed price list.
4. **Received fees only.** A fee counts only once the treasury holds it.
   - `_settle` emits `FeeCharged`, then pays the worker, then the treasury.
   - A refused leg is a `PayoutOwed` after the fee in that transaction, for the same Holding, job and token.
   - The treasury's leg is always `FeeCharged.amount`. So a refused leg counts as the treasury's when it is not to the
     worker, or when its amount is the fee's. A worker that is also the treasury, or a worker leg of exactly the
     fee's amount, therefore fails closed: the fee is not counted.
   - Such a fee counts only if the treasury withdrew that token later in the window. `withdraw` takes the whole owed
     balance, so any later `OwedWithdrawn` to the same address and token clears it.
5. **Fee value.** `fee USD = amount × usdPrice ÷ 10^decimals`, 18 decimals, rounded down.
6. **Emission.** `min(budget, 0.5 × Σ fee USD ÷ max(factoryUsdPrice, 10^14))`, in FACTORY wei. `10^14` is $0.0001.
7. **Budget.** `MiningReserve.cumulativeBudget(n)` minus everything already funded for earlier epochs: the sum of
   `EpochFunded(epoch < n)` logs. Unspent budget rolls over. Run epochs in order.
   - The tool refuses while `totalFunded()` differs between latest and the finalized head (a funding transaction not
     yet final), and when the logs don't add up to it.
   - `fund` adds to what is already there, so the printed call is only right while `totalFunded()` is what the run
     read. `calls.fund.expect` records that value; if it has moved, run the tool again.
8. **Split.** 60 % of the emission to workers and 40 % to creators, each pro rata by fee USD. Arbitrators get nothing.
   - An account that was both worker and creator gets one leaf with both parts.
   - Each part is rounded down, and zero leaves are dropped.
   - `total` is the sum of the leaves, so it can sit a few wei under the emission.

## Leaves

The leaves form an OpenZeppelin `StandardMerkleTree` with encoding `['uint256','address','uint256']` =
`(epoch, account, amount)`. Each leaf is `keccak256(bytes.concat(keccak256(abi.encode(epoch, account, amount))))`,
which is `EpochDistributor.leaf`.

`tree.ts` implements the library's format (`standard-v1`) without the dependency. Its dumps, proofs and roots are
byte-identical to `@openzeppelin/merkle-tree` 1.0.8, and `mining.test.ts` pins roots the library computed. Load a dump
with `StandardMerkleTree.load(epoch.tree)`.

## The price list (EIP-712)

A current Safe owner signs it. The tool recovers the signer and refuses unless it is in `Safe.getOwners()` (read
live) and the list is for this chain, distributor and epoch. Every listed token's `decimals` must match the token on
chain. Only EOA signatures (ECDSA) are accepted.

```ts
domain = {
  name: 'Hireling Mining Prices',
  version: '1',
  chainId,                              // 10143 testnet, 143 mainnet
  verifyingContract: <EpochDistributor>, // deployment.hireling.distributor
}
primaryType = 'PriceList'
types = {
  PriceList: [
    { name: 'epoch', type: 'uint256' },
    { name: 'tokens', type: 'TokenPrice[]' },
    { name: 'factoryUsdPrice', type: 'uint256' }, // USD per whole FACTORY, 18 decimals; below 1e14 counts as 1e14
  ],
  TokenPrice: [
    { name: 'token', type: 'address' },
    { name: 'decimals', type: 'uint8' },      // the token's own decimals
    { name: 'usdPrice', type: 'uint256' },    // USD per whole token, 18 decimals (USDC at $1 = 1e18)
  ],
}
```

The file `--prices` takes holds the integers as decimal strings:

```json
{
  "message": {
    "epoch": "0",
    "tokens": [{ "token": "0x7547…b603", "decimals": 6, "usdPrice": "1000000000000000000" }],
    "factoryUsdPrice": "100000000000000"
  },
  "signer": "0x…",
  "signature": "0x…"
}
```

`signer` is optional; when present it must match the recovered address. `domain` may be included for reference, but
the tool rebuilds the domain itself.

**Signing on the command line** uses a Foundry keystore, as on mainnet. It builds the typed data, signs it with
`cast wallet sign --data --from-file`, checks the recovered address, and writes the signed file:

```
bun scripts/mining/sign-prices.ts <unsigned.json> --network monad-testnet --out <signed.json> \
  --account <keystore name> --password-file <0600 file>    # or --keystore <path>
```

`<unsigned.json>` is the `message` above, on its own. The helper also reads `--config` and refuses `--private-key`
unless the network is testnet.

## Output: `<out>/epoch-<n>.json`

```
{ chainId, epoch, window: { start, end, fromBlock, toBlock },
  priceList: { message, signer, signature },
  budget, feeUsd, factoryUsdPrice, demand, emission, total, root, dataHash,
  inputs, tree, claims: { <account>: { amount, proof } },
  calls: { fund: { to, data }, setRoot: { to, data } } }
```

Integers are decimal strings, and addresses are lowercase.

- **`inputs`** is the canonical record: `{ chainId, epoch, window, holdings, priceList, budget, fees }`.
  - `holdings` is sorted.
  - `fees` lists every `FeeCharged` in the window in chain order, with its position (block, logIndex, tx, holding),
    fields, `status` (`counted`, `unpriced` or `owed-to-treasury`) and `usd`.
- **`dataHash`** = `keccak256(utf8(JSON.stringify(inputs)))`, over `inputs` exactly as written. Parse the file,
  stringify `inputs`, and hash it to check.
- **`tree`** is `StandardMerkleTree.dump()`, and **`claims`** carries each account's amount and proof for
  `EpochDistributor.claim(epoch, account, amount, proof)`.
- **`calls`** are for the Safe, in this order:
  1. `calls.fund`, present only while the epoch still needs funding. It is `MiningReserve.fund(n, amount)`, where
     `amount` is the remainder (`total` minus what `n` already has), not `total`. Its `expect` records `totalFunded()`
     and the epoch's funded amount as this run read them.
  2. `calls.setRoot`: `EpochDistributor.setRoot(n, root, total, dataHash)`.

  `fund` is additive, so the Safe nonce guards it (D18):
  - Read `Safe.nonce()` and `MiningReserve.totalFunded()` at one block. `totalFunded` must still equal
    `calls.fund.expect.totalFunded`; otherwise run the tool again.
  - An owner signs the SafeTx at exactly that nonce, with ECDSA. Never use a pre-validated (v = 1) signature, which binds
    no nonce. A retry is recomputed, never re-signed at a later nonce.

  `/admin` does all of this. The terminal path is in `docs/mainnet-runbook.md` §4, and R7 rehearses it. `setRoot` is an
  ordinary `execTransaction`. Keystores are mandatory on mainnet. With no counted fees there is no tree and no calls.
