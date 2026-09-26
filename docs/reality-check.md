# Reality check (S-1), 26 Sep 2026

Run by hand on the dev machine (`netcup`, `~/code/agent-jobs`) against `.env.local`, one real call per
dependency. `scripts/reality-check.ts` automates the same list; until it exists, this table is the record.
No secret appears here.

| Check | Real call | Result |
| :--- | :--- | :--- |
| Monad testnet RPC | `eth_chainId` on the public RPC | green: 10143 |
| Deployer / relay / attester / arbitrator EOAs | balance + key derives to the stated address | green: 9.49 / 3 / 2 / 1 MON, all keys match |
| MetaMask agent wallet | `mm doctor`, balance | green: authenticated on netcup and the Mac, server wallet `0xeffa…40c3`, 1 MON |
| Privy server wallet | `eth_sendTransaction` with `caip2: eip155:10143` | **green**: tx `0x033d857d…aa91a` (the open question in spec §11 is closed) |
| ERC-8004 registries | `cast code` | green: Identity and Reputation proxies present on 10143 |
| Circle USDC | `cast code`, `symbol()`, `decimals()` on 10143 and 143 | green: "USDC", 6, both networks |
| Foundry | `forge --version` | green: 1.8.3 on netcup (Mac still 1.4.1 from `~/.aztec`, not used) |
| Etherscan v2 (Monadscan) | balance query with `chainid=10143` | green |
| Cloudflare | token verify; list Workers, D1, R2, KV, Queues | green: all permitted |
| Envio HyperSync | `GET monad-testnet.hypersync.xyz/height` with the token | green |
| Vercel AI Gateway | chat completion with `meta/muse-spark-1.3` | green; the model always reasons first (≈300 reasoning tokens for "ok"), so callers must allow ≥ 512 output tokens |
| GitHub App `agent-jobs-attester` | JWT → installation token → check-runs of the fixture repo | green auth (installed on all grmkris repos); **the fixture repo has no CI workflow, so zero check-runs**: S5 adds one |
| Chainlink CRE | `cre whoami` on netcup and the Mac | logged in (org `org_ceIauRUNKGj5Jaft`); **deploy access not enabled yet** (request pending with Chainlink) |
| `pnpm check` | full check on netcup | green (63 contract tests, lint, types) |

Not yet run: an alchemy `staging` deploy, a contract verification on Monadscan and a hello-world CRE
deployment (blocked on deploy access). These run at the start of S7/B1 on netcup.

Wallet funding note: Monad refuses transfers that take an account below its reserve balance (about 10 MON);
fund service EOAs early and keep the deployer above that line.
