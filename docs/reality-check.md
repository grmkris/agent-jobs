# Reality check (S-1)

Three tiers per dependency (R114-04):

- **credential**: the key or login is accepted.
- **operation**: one real call of the kind the product needs succeeded.
- **end-to-end**: the integration works inside our product.

A row moves up only with a dated command or test and a redacted result. No secret appears here.
`scripts/reality-check.ts` (the second real job) automates this table.

Machine: `netcup`, `~/code/agent-jobs`, `.env.local` (mode 600). Toolchain there: Foundry 1.8.3,
pnpm 10.13.1 (`~/.local/bin`), Bun 1.4.2, Node 22, Docker, `gh`, `cre` 1.35.0, `mm` 7.0.0.

| Dependency | Tier | Evidence (26 Sep 2026) | Next tier needs |
| :--- | :--- | :--- | :--- |
| Monad testnet RPC | operation | `cast chain-id` = 10143; balance and `cast code` reads | end-to-end in B1 (deploy) |
| ERC-8004 registries, Circle USDC | operation | `cast code` on Identity/Reputation (10143) and USDC (10143 + 143: "USDC", 6 decimals) | used by S7 fork tests |
| Deployer EOA | operation | sent value transfers on 10143 (e.g. funding the Privy wallet, tx `0x6bb6b343…e578`) | B1 deploy |
| Relay, attester, arbitrator EOAs | credential | keys derive to the stated addresses; 3 / 2 / 1 MON | first relayed tx, first attestation, first ruling |
| Privy server wallet `0x9D04…B4b1` | operation | `eth_sendTransaction` with `caip2: eip155:10143`, tx `0x033d857d…aa91a` | full worker lifecycle in B2 |
| MetaMask agent wallet `0xeffa…40c3` | credential | `mm doctor` authenticated (netcup and Mac); 1 MON | a transaction, then full worker lifecycle in B2 |
| Etherscan v2 (Monadscan) | credential | balance query with `chainid=10143` | verify a contract in B1 |
| Cloudflare | credential | token verify; list Workers, D1, R2, KV, Queues | alchemy `staging` deploy (read-only probe or post-S0-PUT removal) |
| Envio HyperSync | credential | `GET /height` on `monad-testnet.hypersync.xyz` | a log query with decoding and pagination (S4) |
| GitHub App `agent-jobs-attester` | operation | JWT → installation 165115204 token → check-runs of `runner-spike-fixture@f75c817` (0 runs: no CI yet) | first real job adds CI; attester reads real runs (S5) |
| Vercel AI Gateway | operation | `meta/muse-spark-1.3` completion; the model always reasons first (~300 reasoning tokens for "ok"), so callers allow ≥ 512 output tokens | Jev screening path and arbiter proposal (B2/B4) |
| Chainlink CRE | credential; deploy **blocked** | `cre whoami` on netcup and Mac (org `org_ceIauRUNKGj5Jaft`); deploy access "Not enabled", request pending | deploy access, then S5 live proof after B1 |
| `pnpm check` | operation | green on netcup (63 contract tests, lint, types) | stays green per commit |

End-to-end: nothing yet.

## Monad reserve balance (observed 26 Sep, checked against the docs)

The 10 MON reserve applies to MON **value** an account sends, not to gas. An undelegated sender may dip
below it only in an "emptying" transaction, at most once per 3 blocks; a second value transfer within 3
blocks reverts. We saw exactly that: back-to-back transfers from one wallet reverted. Our service EOAs send
value-0 contract calls, so low balances are fine; space out top-ups. Source:
<https://docs.monad.xyz/developer-essentials/reserve-balance>.
