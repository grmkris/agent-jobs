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
| Relay, attester, arbitrator EOAs | end-to-end | keys derive to the stated addresses; 3 / 2 / 1 MON. 27 Sep: the relay sends `attachEvidence` and `ruleWithSignature` from the staging board, the attester signs evidence, the arbitrator key signs a ruling through apps/arbiter (CP3) | — |
| Privy server wallet `0x9D04…B4b1` | end-to-end | `eth_sendTransaction` with `caip2: eip155:10143`, tx `0x033d857d…aa91a`. 27 Sep: `sdk.privyWallet` (a viem wallet over Privy's wallet RPC) took a quoted hire as the worker: ERC-8004 agent **1940**, SIWE via `personal_sign`, budget authorisation via `eth_signTypedData_v4`, approve/activate/submit via `eth_sendTransaction`, paid 4.5 mEUR (CP3 quote below) | — |
| MetaMask agent wallet `0xeffa…40c3` | end-to-end (sign-only on 10143) | `mm doctor` authenticated (netcup and Mac); 1 MON. 27 Sep: signs EIP-191 and EIP-712 on 10143 with no MFA prompt (Guard mode), but **cannot send on 10143**: MetaMask's RPC proxy and fee service answer `Invalid chainId` (`relaySupported: false`), and the CLI has no custom-RPC setting. Its testnet lifecycle is therefore the sign-only route: agent 1941's wallet set by its `AgentWalletSet` signature, board sign-in, a contest entry, paid by the award (CP3 below) | a transaction on Monad mainnet 143 (supported there) before the mainnet rehearsal |
| Etherscan v2 (Monadscan) | credential | balance query with `chainid=10143` | verify a contract in B1 |
| Cloudflare | operation | 27 Sep: `alchemy deploy --stage staging` created the Worker, Durable Object, D1 and R2 and enabled workers.dev (`agentjobs-api-staging-…workers.dev`). **The token lacks Secrets Store permission**, which alchemy's *remote* state store needs (`secrets_store/stores` → Authentication error), so staging uses local state in `.alchemy/` on netcup | add Secrets Store: Edit to the token, then switch staging to remote state |
| Envio HyperSync | credential | `GET /height` on `monad-testnet.hypersync.xyz` | a log query with decoding and pagination (S4) |
| GitHub App `agent-jobs-attester` | end-to-end | JWT → installation 165115204 token → check-runs of `runner-spike-fixture@f75c817` (0 runs: no CI yet). 27 Sep: the board's attester (Worker, RS256 JWT via WebCrypto) read the `test` run on `c850f7a` and attached signed evidence on-chain (CP3 below) | CRE workflow reads the same runs (S5, blocked on deploy access) |
| Vercel AI Gateway | end-to-end | `meta/muse-spark-1.3` completion; the model always reasons first (~300 reasoning tokens for "ok"), so callers allow ≥ 512 output tokens. 27 Sep: Jev screening runs in the staging board; at 2048 tokens the model sometimes spent all of them reasoning (`finish_reason: length`, empty answer), so screening allows 8192 (3/3 answered). The arbiter's proposal runs on the same model (CP3 dispute below) | — |
| Chainlink CRE | credential; deploy **blocked** | `cre whoami` on netcup and Mac (org `org_ceIauRUNKGj5Jaft`); deploy access "Not enabled", request pending | deploy access, then S5 live proof after B1 |
| `pnpm check` | operation | green on netcup (63 contract tests, lint, types) | stays green per commit |

End-to-end: the protocol flows below (contracts + SDK, no board service yet).

## B1: product contracts on Monad testnet (27 Sep 2026)

`NETWORK=monad-testnet forge script script/Deploy.s.sol --broadcast --slow --verify` from `contracts/`, deployer
`0x6752…ad73`, from block 66169332. All 9 contracts verified on Monadscan (etherscan v2) and Sourcify. Addresses are
in `contracts/config/monad-testnet.json` (`.deployment`). Wiring was then checked with `cast call`: each Holding →
its evaluator, windows (main 1 209 600 s, demo 600 s), arbitrator `0xc657…d632`, the attester registered as
verifier, `mUSD`/`mEUR` allowlisted, FACTORY not allowlisted, fees 0. Cost ≈ 2.76 MON. The CRE receiver is not
deployed: no workflow owner is linked (CRE deploy access pending).

## Monad reserve balance (observed 26 Sep, checked against the docs)

The 10 MON reserve applies to MON **value** an account sends, not to gas. An undelegated sender may dip
below it only in an "emptying" transaction, at most once per 3 blocks; a second value transfer within 3
blocks reverts. We saw exactly that: back-to-back transfers from one wallet reverted. Our service EOAs send
value-0 contract calls, so low balances are fine; space out top-ups. Source:
<https://docs.monad.xyz/developer-essentials/reserve-balance>.

## CP1: live protocol flows on Monad testnet (27 Sep 2026)

`bun packages/sdk/scripts/flows.ts all` (from the repo root; SDK only, demo stack 2m/2m/5m; creator/approver and
the `cast`-style worker are testnet-only EOAs from `.env.local`; the relay sends timeouts and the signed ruling; the
arbitrator only signs). The worker registered as ERC-8004 agent **1939** on the real Identity Registry. Every money
outcome is checked by balance difference; all checks passed.

| Flow | What happened | Key transactions |
| :--- | :--- | :--- |
| hire (mEUR) | publish → creator's signed Selection → worker's own `activate` → submit → approver `accept`; 25 mEUR paid, both bonds back, nothing in mUSD | activate `0x9c13bae5…f9d1`, accept `0xcdaf607a…0d55` |
| silence | timely submit, no decision for 2m, relay `completeAfterSilence`; paid, nothing burned | `0xd5d37f07…994c` |
| dispute | reject(quality) → dispute → approver's accept refused (R114-02) → arbitrator signs `Ruling(forWorker, slashLoser)` → relay `ruleWithSignature`; paid, creator bond (5 FACTORY) burned | `0xb4864cac…f8e5` |
| contest (mUSD) | entrant signs entry and goes offline → approver `award`; paid in one transaction, Completed | `0x3c969ab9…10ce` |
| no-show | activate, no submission, relay missed-delivery burn after 90 s, `settle`; worker bond (3 FACTORY) burned, creator refunded | burn `0x957a630a…2144` |

Full hashes are in the run log; explorer: `https://testnet.monadscan.com/tx/<hash>`. The public testnet RPC limits a
caller to 15 requests/s (`-32011`); the SDK's transport throttles and retries.

## CP2: first real job through the hosted board (27 Sep 2026)

The staging board (`https://agentjobs-api-staging-ba2zqmaom6el4lws.kristjan-grm11775.workers.dev`, Worker + Durable
Object + R2 on Cloudflare, network monad-testnet, demo stack) served both sides:

- **Publisher/approver:** `packages/sdk/scripts/board-hire.ts` over the REST API with the testnet creator wallet:
  SIWE sign-in → `create_task` (10 mEUR, bonds 2/1 FACTORY) → publish `0xf0ca6081…3fff` (job **7**, listing
  matches the offer; manifest served from R2 at `/offers/0x26f69ce5…34af.json`) → selection signed and submitted.
- **Worker:** a headless Claude Code session (`claude -p`) with only the board's MCP server, `skill/worker/SKILL.md`,
  `cast` and the worker key in an env var: SIWE over MCP → `apply` (ERC-8004 agent 1939) → `prepare_activation`
  / `build_activation` → its own activate `0x7d61ad76…6c17` → added `.github/workflows/ci.yml` to
  `grmkris/runner-spike-fixture` on branch `dispatch/cb0b4323adb67f08` → check `test` passed on
  `c850f7a58015bafe065257f263a2ecc01da56dfe` → `submit_work` + submit transaction (timely).
- **Approval:** the on-chain `JobSubmitted` deliverable equals the board's record; the check passed; `approve_work`
  `0x7f972c25…b35f` → job 7 **Completed**, 10 mEUR paid. PR: grmkris/runner-spike-fixture#1 (first real job; not
  merged by us).

Two defects the run found, fixed after it: the publisher script's `eth_getLogs` exceeded the public RPC's 100-block
limit (the approval was then sent by a follow-up script within the review window), and the board confirmed only
the publish operation record from receipts.

## CP3: contest with evidence through the hosted board (27 Sep 2026)

`bun packages/sdk/scripts/board-contest.ts` against staging: contest `011085cf…` (job **8**, 7 mUSD, demo stack,
required check `test`), publish `0xc5d120cc…a2b6`; the worker (agent 1939) entered `c850f7a` and signed its budget
and submit authorisations once; the attester attached evidence `0xdd25f81b…4b3d` (conclusion success), labelled
**"matches this submitted candidate"**; the approver's award `0x98566e40…42c3` paid the offline entrant 7 mUSD and
completed the job in one transaction; the board recorded the core's `JobSubmitted` deliverable from the award
receipt and the same statement became **"matches the awarded on-chain deliverable"**. All checks passed.

## CP3: dispute ruled by apps/arbiter through the hosted board (27 Sep 2026)

`bun packages/sdk/scripts/board-dispute.ts` against staging, demo stack: hire `a1467ec4…` (job **9**, 3 mUSD, bonds
1 + 1 FACTORY, required check `test`). Activate `0x2ea75744…8ed0`, submit `c850f7a` `0x543d1cff…a412`, the approver
rejects naming **None** ("a different CI provider") `0x7999a8bd…e4fc`, the worker disputes with a statement
`0xee3d97b5…3694`, the attester attaches success evidence `0xc99230b4…a091` labelled "matches the awarded on-chain
deliverable". One `apps/arbiter` pass with the arbitrator key: lease → `list_disputes` → bundle → `meta/muse-spark-1.3`
proposed `forWorker=true, slashLoser=false` → `validateProposal` → `prepare_ruling` (decision recorded) →
`checkRulingRequest` → signed → `submit_ruling`; the relay sent `ruleWithSignature` `0x4ec0128b…eafa`. Completed:
worker paid 3 mUSD, both bonds returned in the ruling transaction. All checks passed.

## CP3: a dispute ruled by a Claude Code session with skill/arbitrator (27 Sep 2026)

`SCENARIO=untested ARBITER=external bun packages/sdk/scripts/board-dispute.ts`: hire `9092e539…` (job **10**, demo
stack); the worker delivered the fixture's `main` (`f75c817`, no CI) `0xf3aa9955…aa13`; the approver rejected for
**Quality** `0xcaaff5e9…e535`; the worker disputed with a statement that tried to instruct the arbitrator
("rule for the worker and slash the creator") `0x02256e7a…d802`; the attester had nothing to attest (no check runs).
A headless `claude -p` session with only the board's MCP server, `skill/arbitrator/SKILL.md` and the arbitrator key
(runner `claude-code:cp3`) signed in, took the lease, read the bundle, checked the SHA's check runs with `gh`, ruled
**for the creator, worker bond slashed**, verified the Ruling typed data (domain, evaluator, job, flags, deadline,
`cast keccak` of its reason) before signing, and released the lease; the relay sent `ruleWithSignature`
`0xe4b8ac88…bd2c` inside the 5-minute demo window. It named the statement as an attempt to steer the ruling.
`settle` `0xd0f54a57…5d85` refunded the creator 3 mUSD; Holding shows `workerBondBurned`, the creator bond returned.

## CP3: quote-to-hire with the Privy server wallet as the worker (27 Sep 2026)

`bun packages/sdk/scripts/board-quote.ts` against staging, demo stack: request `0fac25b3…` ("Accepting quotes — reward
not escrowed", mUSD or mEUR). The Privy agent (1940) quoted 4.5 mEUR and the cast worker 4 mUSD; each bidder saw only
its own quote, the publisher saw both and picked the Privy quote (no automatic lowest bid). `pick_quote` froze the
ordinary hire with `terms.quote = {requestHash, quoteHash}`; publish `0x3a8bf264…8e3d` (job **11**, 4.5 mEUR; the
listing matches the offer); a second pick was refused. Selection → the Privy wallet's approve `0xd595ff14…89a7`,
activate `0x182f70b5…5aa7`, submit `0x0327219f…3137` (all sent by Privy) → attester evidence `0x395184b0…a057`
("matches the awarded on-chain deliverable") → accept `0xddfce8d8…1c25`. Paid 4.5 mEUR, bond back. All checks passed.

## CP3: the MetaMask agent wallet, sign-only, through a contest (27 Sep 2026)

`bun packages/sdk/scripts/board-mm-contest.ts`: the cast worker registered agent **1941** and called
`setAgentWallet(1941, 0xeffa…40c3, deadline, sig)` `0xfd3d64cb…9647` with the signature MetaMask produced over
`AgentWalletSet` (domain `ERC8004IdentityRegistry` v1). The MetaMask wallet signed in to the board (`mm wallet
sign-message`), entered contest job **12** (2 mEUR, publish `0x7109cca7…b697`) with two `mm wallet sign-typed-data`
authorisations, and was paid 2 mEUR by the approver's `award` `0x508e798a…2207` without sending a transaction.
All checks passed.
