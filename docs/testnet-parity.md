# Testnet parity matrix

## Current G1b evidence (3 Oct 2026)

The active config now names **G1b**, deployed at block 67856884 with a fresh FACTORY,
vault and Holding. The G1 matrix below is historical; its October 6 mining cutoff
and uncompleted-epoch statements do not describe G1b. Never reuse a G1 journal,
token balance or stake reservation for the current deployment.

| Area | Current evidence | Status |
| --- | --- | --- |
| Deployment, ownership, policy and liquidity | [G1b receipts](reality-check.md#g1b-fresh-hireling-v1-testnet-3-oct-2026), six Safe handoffs, live D16 readback and seed position 77. The three reused-core role differences remain disclosed. | PASS (testnet) |
| Contract lifecycle and economics | Jobs 82–99 cover payment, silence, cancellation, disputes/rulings, no-show, top-up/refund, fee tiers, legacy paths and refused reward payouts. Stake cooldown/withdrawal completed. [Public receipt ledger](evidence/testnet-g1b/2026-10-03.json). | PASS (coordinator contract flows) |
| Mining epoch 0 | G1b cutoff was 3 Oct 15:17:32 UTC. Signed prices, computation, 8,750 FACTORY funding, root, publication/readback and the worker's 5,250 FACTORY stake claim completed. | PASS (live G1b) |
| Hosted archive fix | `c9f924c` was released with digest `984966161b46c0ef07aead70201080595c4341b674efe8b8886dec055f7c6d21`; health, protocol, directory, discovery, MCP and anonymous refusal pass. | PASS (service release) |
| Historical index catch-up | Approved checkpoint-only replay completed. All 16 G1b publications/settlements, both legacy flow jobs, mining events and archived G1 v1 history were verified. Two successful post-replay cron runs advanced the checkpoint. [Evidence](evidence/testnet-g1b/2026-10-03-indexer-replay.json). | PASS (live recovery) |
| Website creator flows | A/C plans and dialog-scoped test driver are prepared. The post-archive read-only smoke passes Stake, Post, Collect, Sponsorship and job 99 with zero errors/signatures/transactions. Live UI sends remain held. | PASS (read-only); GAP (paid website flows) |
| Developers bringing agents | Fresh round-two briefs are prepared; durable runner work is ongoing. Replay and UI readiness must pass before live execution. | GAP (fresh crew round) |
| Real Privy login and friends' sessions | [First-use guide](../apps/explore/docs/first-use.md) and K6/K8 checklists exist. An injected test wallet is not evidence of real Privy login or a friend's session. | GAP (human acceptance) |
| Mainnet | No mainnet action is authorized or implied by the testnet evidence. | HELD for Kris's explicit go |

## Historical G1 matrix

This matrix records what the Monad testnet proves before a mainnet action. A
testnet fork or a unit test is evidence of implementation; it is not a live
mainnet deployment. The live deployment and staging records are in
[`docs/reality-check.md`](reality-check.md), sections **G1** and **G2**.

The testnet launch reuses the existing core, so the deployer intentionally keeps
`ADMIN_ROLE` and `DEFAULT_ADMIN_ROLE`. A fresh mainnet core must transfer both
roles to the Safe and leave neither with the deployer. The testnet liquidity seed
uses mUSD (`0xabd60a1e40519E3609C4F9eBb551FcF242a8AD8f`, 6 decimals); mainnet
uses USDC. The SeedPool code path, receipt extraction, owner check and
post-broadcast verification are identical; v4 manager addresses and quote
tokens are network-specific.

| Runbook step | Testnet evidence | Status |
| --- | --- | --- |
| §1.1 Safe and canonical policy | G1, [`reality-check.md` § Hireling v1 testnet Safe](reality-check.md#hireling-v1-testnet-safe-2-oct-2026): creation `0x70a728bade67f46a995995a709deb5f2572df5ea2b61ae7be19061d96b1e6c81`; live owners, threshold 1, VERSION 1.4.1. | PASS |
| §1.2 Hireling input/config | G1 promotion is recorded in `contracts/config/monad-testnet.json`; `Recipe.t.sol` loads the same 15-field input schema and the live record has `deployment.hireling`. | PASS |
| §1.3 reviewed production artifact | The checked-in artifact is mainnet-only and has no live testnet equivalent. | GAP |
| §1.4 domain and Privy handoff | G2: staging release, `testnet.hireling.xyz/release.json`, health 200 and apex 301 are recorded in [`reality-check.md` § G2](reality-check.md#g2-staging-release-of-hireling-v1-3-oct-2026). | PASS (staging) |
| §2.1 Safe funding | G1 records the deployer/Safe-owner funding transactions and completed launch; live balances were re-read before SeedPool. | PASS (testnet) |
| §2.2 DeployHireling gas budget | G1 records the testnet deployment receipts and addresses; the mainnet fresh-core budget remains a fork estimate. | PASS (testnet); GAP (mainnet) |
| §2.3 PromoteHireling budget | Promotion is a checked-in record update with no transaction; G1 records the promoted testnet deployment. | PASS |
| §2.4 SafeAccept funding | G1 records all six Safe execution hashes and owner readback. | PASS |
| §2.5 SeedPool funding | The deployer held 6.02 mUSD and 149,978,500 FACTORY before the four seed transactions; the mUSD funding tx is recorded in G1. | PASS |
| §2.6 Mining epoch-0 budget | The testnet script is prepared; no epoch transaction is permitted before finalized cutoff. | GAP (epoch not ended) |
| §2 encrypted keystores | The permitted testnet raw-key fallback was used for G1/SeedPool; encrypted testnet signing is separately proven in the launch checks below. | PASS (testnet fallback) |
| §2 fresh relay/attester/arbitrator keys | The reused testnet record still uses its configured legacy relay/attester; D16 verified those actual addresses. Retired keys are refused on mainnet by `Recipe.t.sol` and `prod-config.test.ts`; fresh mainnet provisioning has no live evidence. | GAP (mainnet provisioning) |
| §2 role wallet balances | Deployer/liquidity holder and Safe owner sent the G1/seed receipts. D16 read the configured relay above the shared floor. Backend's LIVE-FLOWS receipts prove attester/arbitrator paths; funding amounts must be re-read before each send. | PASS (testnet paths) |
| §3.1 create/read Safe | G1 Safe creation and readback; no module and no guard were re-read by `check-launch-testnet.ts`. | PASS |
| §3.2 DeployHireling | G1 contract creation/setup transactions and deployed addresses are recorded in [`reality-check.md` § G1](reality-check.md#g1-hireling-v1-on-monad-testnet-3-oct-2026). | PASS |
| §3.3 PromoteHireling | G1 promotion wrote `deployment.hireling` and the v1 `main` record in `contracts/config/monad-testnet.json`; no transaction is sent. | PASS |
| §3.4 gate refuses before SafeAccept | R7 fork test `test_launchGateReadsTheReviewedSafe` and `rehearse-launch.sh` prove the six pending handovers refuse the gate. Testnet’s live gate is run after promotion, where handovers are already accepted. | PASS (fork; live pre-accept state is historical) |
| §3.5 SafeAccept ×6 | G1 lists all six Safe `execTransaction` hashes: `0x5578e203…661c`, `0x5274d474…7551`, `0xab8a461b…c3cf`, `0x7b84f5e2…df63`, `0x987a771b…19eb`, `0x78a9615f…de71`. | PASS |
| §3.6 gate passes after handover | `bun --no-env-file contracts/script/check-launch-testnet.ts` read the live Safe, all six owners, both core roles, verifier and relay. It passed with exactly three expected reused-core differences (deployer retains both roles; Safe lacks the reused core’s `DEFAULT_ADMIN_ROLE`). | PASS with documented testnet delta |
| §3.7 SeedPool and `verify()` | Four live testnet transactions with checked-in mUSD config: helper `0x9d17d181c091035f7b42874506450ffea05cb862f3dd07063ece97a774fcfaea`, FACTORY approval `0x430ace325c4d5c064ffafe77d5b969d1eb92b8e215c7e5acbad1c949004cee3d`, mUSD approval `0xe04f571974d712078319e05beb8cf5da2a89a9021b5e8203d0044a577008da1e`, seed `0x0f1a50ea80c6c13c9b3c02d9ae4285c32774734673a4c45100c3b19a6dfc645d`. Receipt-based `verify()` passed for token ID 76, Safe ownership, liquidity `99989999999999` and pool ID `0xbb4f00b4a323798896393d76f620260e25fb821678ebf81a45e2a987bfca3a71`. | PASS |
| §3.8 drained production deploy | No mainnet deployment or production remote-state action was authorized. | GAP |
| §3.9 post-deploy production probes | G2 proves staging health/release/webhook probes; mainnet API, indexer and chain-143 probes have no live evidence. | GAP (mainnet) |
| §3.10 explicit production opening | Mainnet opening is intentionally unperformed pending D22’s complete testnet proof and Kris’s explicit go. | GAP |
| §3.11 first mainnet USDC job | No mainnet job exists. A live v1 hire paid the worker 700,000 raw mUSD in accept `0x069f6c249b0a8a23757b41f0a67df80c0eb0968e8d4a60f02ee78a0aad1f1aa0`; settle `0x3f3083b371ca4bd81378c38d036296cb148a99f990d93a3c638236a9c26ec510` paid the treasury 300,000 raw mUSD. Both receipts are status 1. Mainnet will use USDC. | PASS (testnet mUSD; mainnet USDC GAP) |
| §4.1 sign prices and compute epoch 0 | `mine-epoch0-testnet.sh` signs mUSD at $1 and FACTORY at $0.0001 with a testnet Safe owner, then runs `mining:epoch`; it refuses until finalized `epochEnd(0) = 1791272911` (2026-10-06 07:48:31 UTC). | GAP (epoch not ended) |
| §4.2 Safe `fund` (ECDSA nonce) and `setRoot` | R7 fork proves ECDSA fund at the snapshot nonce, Safe setRoot and GS026 replay refusal; the live epoch cutoff has not passed. | GAP (live epoch) |
| §4.3 publish `mining/epoch-0.json` to staging | The publisher is implemented and tested; it cannot publish a live epoch before §4.2 has a root and dataHash. | GAP (live epoch) |
| §4.4 claim and stake | R7 fork proves claims stake through `EpochDistributor`; no live epoch root or claim exists on testnet yet. | GAP (live epoch) |

## Launch checks

| Check | Testnet evidence | Status |
| --- | --- | --- |
| D16 live gate | `check-launch-testnet.ts` read block 67790179 after relay top-up: Safe policy, owners, threshold, singleton/version, modules, guard, six owners, pendingOwner values, verifier and relay 8.2521 MON. It passed only with the explicit three reused-core role differences. | PASS (testnet mode) |
| `preflight-prod` | `scripts/preflight-prod.ts <artifact> --live` is intentionally chain-143/mainnet-only; its structural and gate behavior is covered by API tests and R7. | GAP (no mainnet artifact/state) |
| SeedPool | Live mUSD seed and receipt verification above. | PASS |
| Mining epoch 0 | `mine-epoch0-testnet.sh` contains the exact sign → compute → ECDSA fund → setRoot → publish → wallet claim order, durable raw-transaction journal and finalized-cutoff refusal. | GAP until 2026-10-06 07:48:31 UTC |
| Keystores | `check-keystore-testnet.ts` imported the permitted backup-owner key into a temporary encrypted Foundry keystore, signed diagnostic EIP-712 prices, recovered Safe owner `0x3c29…921e` at block 67792064, and removed it; no transaction. | PASS (testnet signing path; mainnet key proof GAP) |
| Safe policy | G1 creation/readback plus the live D16 script prove the two owners, threshold 1, VERSION 1.4.1, canonical singleton, empty modules and zero guard. | PASS |
| Every live flow (D22) | Backend's `status/backend.md` records confirmed hire, fees, rulings and other cases; the all-flow run and long-clock completions are still in progress. A paid hire alone does not close D22. | GAP (backend owns completion) |

The remaining end-to-end testnet GAPs include the backend's all-flow run and the
complete epoch-0 computation, funding, publication and claim. Mainnet deployment,
USDC seed, and production opening remain gated by D22 and Kris's explicit go.

## Exact epoch-0 sequence

Run from the repository root in bash with the named testnet keys exported:

```bash
set +x
set -a
. /home/kristjan/code/agent-jobs/.env.local
set +a
bash contracts/script/mine-epoch0-testnet.sh \
  contracts/script/prices-epoch0-testnet.json \
  /home/kristjan/.local/state/hireling/testnet-epoch0 \
  --claim-key-env TESTNET_WORKER_PRIVATE_KEY
```

The checked-in price input values mUSD at $1 and FACTORY at $0.0001 for the
testnet rehearsal; it is a Safe-approved reference list, not market-oracle
evidence. The claimant key must belong to a worker or creator leaf. The output
directory is private (700); its journal and signed transaction bytes stay local.

The wrapper holds `launch-lock.sh`. Until latest **and finalized** chain time
reach `epochEnd(0)`, it exits 4 without reading a signing key or creating output.
Then it executes:

1. `scripts/mining/sign-prices.ts --private-key-env SAFE_BACKUP_TESTNET_PRIVATE_KEY`
   for epoch 0 on testnet.
2. `pnpm mining:epoch 0 --network monad-testnet --prices <signed> --out <dir>`.
3. ECDSA Safe `fund` at the nonce read with reserve funding at one block (D18),
   then ECDSA Safe `setRoot`. The script validates exact targets/calldata and
   `ExecutionSuccess`, as outer receipt success alone is insufficient.
4. `pnpm mining:publish <dir>/epoch-0.json --stage staging`, including sha256
   readback. Failure stops before any claim.
5. Wallet-paid `claim(0, account, amount, proof)` and exact vault stake readback.

Run the same command and directory after an interruption. It retains the first
signed price list, artifact, Safe nonce and raw outer transaction. Before a retry
it reconciles the original transaction hash; a moved nonce or consumed unknown
outer transaction refuses. Never delete a journal to bypass that refusal.

`epoch0-transactions.test.ts` passed four real local-fork cases: failed publication
blocks a claim, resumed fund/root never re-sign, saved outer bytes survive a crash,
and changed Safe nonce/prevalidated signatures/altered targets refuse. The live
cutoff refusal passed on 3 Oct, leaving no output directory. Keystore proof used
diagnostic epoch 999999 and does not constitute epoch-0 completion.

No mainnet transaction is implied by this document. The preceding matrix and
command example describe the historical G1 stack. G1b's completed epoch and
remaining acceptance gates are recorded at the top of this document.
