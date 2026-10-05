# P7 mining rule verification — 5 October 2026

The source of authority is note 17 section 6 rev 9, saved in the assigned
`spec-v2/mining-rule.md`. These changes implement that rule in the epoch tool;
they do not change Solidity or fund/post a live epoch.

| Commit | Change |
| --- | --- |
| `44294c7` | Replay expiring lots oldest-first, reject inconsistent funding order, preserve partial-rerun roots and fund only the emission remainder. |
| `66eb794` | Verify conservative-high hourly pool prices, signed prior-epoch fallback and auditable sample evidence; normal viem dependency and mining typecheck. |
| `64aa081` | Include top-up contributors in creator-side rewards using full event history and cumulative-bonus validation. |
| `2892314` | Document the previous-price CLI input in usage output. |

`heavy pnpm check` passed, including the new mining typecheck, repository tests
and lint. `bun test scripts/mining` passed 47 tests; the RPC-dependent contributor
fork test skips without its environment. Its separately enabled command passed:

```sh
heavy bun --env-file=.env.local test scripts/mining/contributors.fork.test.ts
```

The real local Monad fork paid a 100-token job with 10-token and 20-token top-ups
before the fee window. It read a 39-token fee, including a 9-token bonus fee, and
allocated mining 60/40 with exact worker/creator/contributor claims of
11.7 / 7.2 / 0.6 FACTORY at the fixture prices. It sends only to local Anvil.
Pure fixtures cover the 72-hour first epoch, zero/low fees, partial rollover,
expiry, halvings, missing samples, signed fallback rejection, partial funding
with unchanged leaves/root, and incomplete contribution history.

[p7-schedule.json](p7-schedule.json) records read-only live reserve checks for
epochs 0, 1, 26, 27, 53, 181 and 182. Every deployed cumulative budget matched
the integer schedule. [p7-pool-probe.json](p7-pool-probe.json) records a real
historical testnet Uniswap v4 sample at block 68264624 with its block hash,
sqrt price, liquidity and virtual reserves. Its quote price is a fixture
assumption, not a signed live mining price list.

The official mining pool is still unspecified in the checked-in network configs.
The tool records that explicitly and follows the no-sample fallback: epoch-zero
floor, otherwise the immediately previous signed price from a current Safe owner.
The coordinator must select and record the official pool before launch. The
existing liquidity recipe is not implicitly designated as that pool.

No mining funding transaction, root publication, staging release or mainnet
transaction was performed. Genuine-user, hosted HTTP and release acceptance
remain P8 gates.
