# Implementation plan (26 Sep 2026, after the R114 review)

The spec is myplan note 12 "Hackathon spec — agent-jobs"; decisions are in ADR-0004 (R20 + R114
amendment). This file is the execution order and must agree with note 12 §9. Working deadline: 13 Oct
2026, 23:59 ET (official portal rules still to be confirmed by Kris).

## Rules for every step

- **Dev machine: `netcup`** (`ssh netcup`, `~/code/agent-jobs`). All work happens there, in a session
  started on that machine; `.env.local` lives there (mode 600). Toolchain: Foundry 1.8.3, pnpm 10.13.1
  (`~/.local/bin`), Bun 1.4.2, Node 22, Docker, `gh`, `cre`, `mm`.
- **No mocks in the product.** No stub code paths, no placeholder contracts in any deployment, no
  simulation presented as an integration. An unreachable service shows as unavailable. Unit tests may use
  test doubles for failure paths; every integration also has a real test.
- **Testnet is built exactly like mainnet.** One deployment recipe, one config file per network
  (`contracts/config/monad-testnet.json`, `monad-mainnet.json`), no address in code. Testnet differences:
  chain, faucet tokens (`FactoryToken` faucet, `mUSD`, `mEUR`) and the extra demo-window evaluator. The
  production config has no faucet, and a test proves it cannot enable one.
- **Secrets** only in `.env.local` (template `.env.example`), pushed to Worker secrets by
  `scripts/push-secrets.ts`. Never in git, logs, notes or commit messages.
- **Evidence tiers** (R114-04): credential → operation → end-to-end, recorded in `docs/reality-check.md`
  with a dated command or test. Planned, implemented/tested and live-verified are separate statuses.
- **At most one economic effect** per operation (R114-07): durable operation records, reconciled against
  the chain before any retry.
- **Sequential.** Each step ends with `pnpm check` exit 0 (checked, not piped), one bounded commit, CI
  green, and the stated proof. Status is updated in note 12 §13 only after that proof.
- **Stops:** a red credential, a genuine design fork, or any mainnet transaction (always waits for Kris's
  explicit go). "No deploy before S7 is green" covers the product contracts; a read-only infrastructure
  probe may be deployed earlier, never a public write endpoint.

## Order (one, same as note 12 §9)

S-1 (credential tier, done) → **S7** → **B1** testnet deploy → **S5** live proof → **B2** (first real
path, then quotes, contests, arbiter, wallets) → **B3** (S4 + Explore) → **B4–B5** → **Dispatch adapter**
→ **B6a** testnet rehearsal → **B7** mainnet → **B6b** ship.

## S7 Contracts v3 (R20, R114)

Acceptance: note 12 §13 S7 row; target surface: `contracts/SURFACE.md`.

0. **Failing tests first** for the two defects R114 found at 47c4dd2:
   - R114-02: reject → dispute → accept must revert (accept vs dispute, ruling, timeout; both orders;
     approver = and ≠ creator).
   - R114-03: timely submit → review window passes → nobody settles → `expiredAt` + grace →
     `core.claimRefund` → Holding pays the **worker** exactly once (plus silence-vs-refund in both orders,
     no-show, undisputed rejection and arbitration timeout after expiry; other escrows untouched).
1. `JobHolding`: approver; `publish` refuses zero or already-listed `policyHash` and contest
   `workerBond > 0`; **`activate` callable only by the worker** (checks the creator's `Selection`,
   `activateBy`, delivery deadline, hold gate, `getAgentWallet(agentId) == msg.sender`; sets provider,
   pulls bond, applies the worker's `SetBudgetAuthorization`, funds) + `cancelSelection`; `award`
   (setProvider → `setBudgetWithAuthorization` → fund → `submitWithAuthorization` → evaluator completion);
   reward and bond outcomes recorded in Holding; post-core-refund settlement from the evaluator's outcome;
   `withdrawWorkerBond` guarded; no-faucet production config.
2. `JobsEvaluator`: approver-gated `accept` (refused while disputed) / `reject(violation, reasonHash)`;
   missed-delivery burn; late-submission rules; `rejectAfterWindow` burns on a named violation;
   `ruleWithSignature(Ruling, sig)`; recorded outcome per job for Holding; reason-aware `_recordOutcome`;
   `EvidenceAttached` with every binding field; `completeAward` for Holding.
3. `MockPaymentToken(name, symbol)` for testnet.
4. `script/Deploy.s.sol` + `config/<network>.json`: core proxy, Holding, real-window and demo-window
   evaluators, receiver slot, token allowlist, verifier registration; fork-tested per network.
5. Existing S1b contest tests replaced; invariants: each reward and bond decided once, no double payout,
   all assets conserved.
6. Docs: `SURFACE.md` target becomes current; ADR-0004 status → implemented.

Done: `forge test` (unit, fuzz, invariants) and fork tests green; CI green. S5 receiver code and unit
tests may be written in parallel.

## B1 Testnet deploy

Run the recipe on 10143: core proxy, Holding, both evaluators, the genuine CRE receiver, `FactoryToken`,
`mUSD`, `mEUR`; verify on Monadscan; register the attester and receiver as verifiers; write
`config/monad-testnet.json`; README addresses. Done: verified addresses and a scripted `cast` hire
(publish → activate → submit → accept) on testnet.

## S5 Evidence live proof

Needs CRE deploy access and the first real job (fixture CI). The attester and the deployed CRE workflow
each deliver an attestation on 10143 to the deployed receiver for a real commit of
`runner-spike-fixture`. Record in `docs/reality-check.md` as end-to-end.

## B2 Board service (S8)

1. **First real path:** the smallest SDK → API → MCP flow for one `cast`-wallet fixed-price hire of the
   first real job (CI for `runner-spike-fixture`): publish → activate → submit → accept with correct
   reward and bonds, no manual database repair.
2. `packages/spec`, `packages/board` (Dispatch `board-logic` wrapped), `packages/sdk`, `apps/api` (SIWE,
   MCP worker/publisher/arbitrator tools, relay for award authorisations and signed rulings only,
   operation records in the board DO, authorised content-addressed manifest publication with the S0 PUT
   removed before any public deployment, fork SHA check, attester, Jev client through the AI Gateway).
3. Quotes on top of hire; contests on the proven award; evidence labels (candidate vs on-chain).
4. `apps/arbiter`: model proposes → deterministic signer validates → decision persisted per dispute;
   lease so one runner is active; `skill/arbitrator/SKILL.md` for a Claude Code session.
5. Each demo wallet's full lifecycle (MetaMask agent, Privy server wallet); the second real job
   (`scripts/reality-check.ts`).

Done on testnet: fixed-price, quoted and contest routes settle end to end; one dispute ruled by each
arbitrator harness; each wallet completes its lifecycle; S8 acceptance (incl. R114-06/07/08) green.

## B3 Discovery, B4–B5

S4 indexer (finalized blocks, lease, rebuild of chain facts only) with a live log query; `apps/explore`
with both evidence labels; Jev on the real path; dispute UI and early award; demo-window evaluator by
config.

## Dispatch adapter

Cloudflare OS Dispatch publishes a quote request through the SDK (demo step 1). Before B6a.

## B6a Testnet rehearsal

The whole note 12 §2 script on testnet with real harnesses and services, recorded; ethskills qa by a
separate agent, crops, audit skim, independent adversarial review; fixes, then re-record.

## B7 Mainnet

After B6a and Kris's FACTORY supply/mint decision. Same recipe, real windows, USDC allowlisted, no faucet,
hold gates 0, custom domain, `prod` stage; one real job settled with real USDC. Every transaction waits
for Kris's explicit go.

## B6b Ship

Video, README (admin, pause commitment, addresses and transaction hashes on both networks, "unaudited",
AI disclosure), submission per the official rules.

## Starting a session on netcup

```
ssh netcup
cd ~/code/agent-jobs && git status && git log --oneline -3
claude
```

Prompt: "Read AGENTS.md, docs/implementation-plan.md, docs/reality-check.md and myplan note 12 (§1, §3,
§4, §9, §13). Start S7: write the R114-02 and R114-03 counterexample tests first and show them failing,
then implement direct activation and the atomic award. Bounded commits with checked `pnpm check` exit
codes. Secrets only from .env.local. No mainnet transaction."

## Credentials

See `.env.example`, `docs/reality-check.md` and note 12 §13a.
