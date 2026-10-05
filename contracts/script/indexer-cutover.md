# G1c indexer checkpoint cut-over (coordinator only)

G1 → G1b used a checkpoint-only rewind from 67892518 to 67856884. Changing the
configured role addresses does not rewind an existing cursor. See
`docs/evidence/testnet-g1b/2026-10-03-indexer-replay.json` and the 3 October entry
in `docs/reality-check.md`.

After the guarded G1c release, prove that the active Indexer version contains the
promoted G1c addresses. Preserve a private D1 backup/bookmark and checkpoint,
lease and `indexer_runs` readbacks. Establish that earlier scheduled invocations
have finished. **Lease expiry alone is insufficient**: the existing indexer has
no fencing or lease heartbeat. Do not force-steal a lease or change cron.

Export `CLOUDFLARE_API_TOKEN` from the usual secret environment. The following
command reads the existing staging database and prints the current cursor, lease
and target from the promoted config; it does not change D1:

```sh
node contracts/script/indexer-cutover.mjs
```

Apply only after those checks, substituting the exact G1c block and the verified
active version UUID. The final flag records the coordinator's determination that
prior invocations have completed; the script cannot infer that from D1.

```sh
node contracts/script/indexer-cutover.mjs --yes --expect-block G1C_BLOCK \
  --quiescent-version INDEXER_VERSION_UUID --prior-invocations-complete
```

The script pins the existing account, Worker and D1 identities, checks the live
database/network bindings and 100% version traffic, conditionally acquires an
expired lease, and captures a fresh checkpoint under it. A compare-and-swap
rewinds only `next_block`, clears `block_hash`, and sets `updated_at=0`. All facts,
jobs and hosted rows remain present. A failed CAS requires reconciliation. Only
the script's own lease is released. A cursor already at/below the target is a
no-op. Dry-run reads still use D1's POST query API with SELECT statements only.

Let normal cron replay the inclusive deployment block. Observe two successful
cron runs and cursor advancement beyond a recorded finalized cutoff; compare
G1c receipt/log identities, derived jobs and protocol events, and verify archived
G1/G1b facts remain present. Do not use `resetIndex`, destructive reorg recovery,
or a fabricated block hash. A successful rewind is not proof of a completed replay.

Local guard tests use the actual SQL against in-memory SQLite:

```sh
node --test contracts/script/indexer-cutover.test.mjs
```
