# Implementation plan (26 Sep 2026)

The spec is myplan note 12 "Hackathon spec — agent-jobs" (R20 synthesis); decisions are in ADR-0004. This
file is the execution order. Deadline 13 Oct 2026, 23:59 ET.

## Rules for every step

- **No mocks in the product.** No stub code paths, no placeholder contracts in any deployment, no
  simulation presented as an integration. An unreachable service shows as unavailable. Unit tests may use
  test doubles for failure paths; every integration also has a real test (fork or live testnet, the real
  service).
- **Testnet is built exactly like mainnet.** One deployment recipe, one config file per network
  (`contracts/config/monad-testnet.json`, `monad-mainnet.json`), no address in code. The only testnet
  differences: chain, faucet tokens (`FactoryToken` faucet, `mUSD`, `mEUR`) and the extra demo-window
  evaluator.
- **Secrets** only in `.env.local` (template `.env.example`), pushed to Worker secrets by
  `scripts/push-secrets.ts`. Never in git, logs, notes or commit messages.
- **Sequential.** Each step ends with `pnpm check` green (checking its exit code, not a pipe), one commit,
  CI green, and the stated live proof. Status is updated in note 12 §13 only after that proof.
- **Stops:** a red credential, a genuine design fork, or any mainnet transaction (always waits for Kris).

## S-1 Reality check (first)

`scripts/reality-check.ts` reads `.env.local`, runs one real call per dependency, and writes a green or red
table to `docs/reality-check.md`:

| Check | Real call |
| :--- | :--- |
| Monad testnet | `eth_chainId` = 10143; MON balance of the four EOAs above a floor |
| Addresses | `cast code` + `symbol()` on the ERC-8004 registries and both USDC addresses |
| Foundry | `forge --version` >= 1.8 (`foundryup` first) |
| Verification | deploy and verify a trivial contract (Sourcify, Monadscan) |
| Privy | server wallet `eth_sendTransaction` on `eip155:10143` (a self-transfer) |
| MetaMask agent wallet | one transaction on 10143 from the configured address |
| HyperSync | a log query on the testnet endpoint with the token |
| GitHub App | installation token → check-runs of `FIXTURE_REPO`'s default branch head |
| Chainlink CRE | `cre whoami`; deploy a hello-world workflow to Monad testnet and observe one delivery |
| Jev | one screening call |
| Model endpoint | one chat completion from `ARBITER_MODEL` |
| Cloudflare | `alchemy deploy --stage staging` of the current probe Worker, then a GET |

Done: every row green, table committed (no secrets in it).

## S7 Contracts v3 (R20)

Scope and acceptance: note 12 §4 and §13 (S7 row); target surface in `contracts/SURFACE.md`.

1. `JobHolding`: approver field; `publish` refuses zero `policyHash` and contest `workerBond > 0`;
   `activate(Selection, creatorSig, agentId, budgetAuth)` + `cancelSelection`; `award(candidate)` chaining
   setProvider → `setBudgetWithAuthorization` → fund → `submitWithAuthorization` → evaluator completion;
   bond outcomes recorded in Holding; `withdrawWorkerBond` guarded; identity registry wallet check.
2. `JobsEvaluator`: approver-gated `accept` / `reject(violation, reasonHash)`; missed-delivery burn; late
   submission rules; `rejectAfterWindow` burns on a named violation; `ruleWithSignature(Ruling, sig)`;
   reason-aware `_recordOutcome`; `EvidenceAttached` with every binding field; `completeAward` for Holding.
3. `MockPaymentToken(name, symbol)` for testnet.
4. `script/Deploy.s.sol` + `config/<network>.json`: core proxy, Holding, real-window evaluator,
   demo-window evaluator (testnet only), receiver address slot, token allowlist, verifier registration.
5. Tests: the S7 acceptance list; existing S1b contest tests replaced; invariants extended; fork tests run
   the deploy recipe against a fork of each network.
6. Docs: `SURFACE.md` target section becomes the current surface; ADR-0004 status → implemented.

Done: `forge test` (unit, fuzz, invariants) and fork tests green; CI green.

## S5 Evidence (live)

1. Attester module (`apps/api`): GitHub App token → check-runs of the tested commit → filter to the
   policy's named checks and trusted producer → EIP-712 `EvidenceAttestation` → `attachEvidence`.
2. `EvidenceReceiver` as a pinned CRE `ReceiverTemplate` (forwarder and workflow identity checked);
   `workflows/cre-evidence` (TypeScript, CLI >= 1.30, SDK >= 1.19 pinned).
3. Unit tests for the receiver (valid route, wrong forwarder, wrong workflow, direct call, ERC-165,
   replay, policy/artifact binding); CLI simulation only against its own labelled test receiver.

Done: after B1's deploy, the deployed workflow delivers an attestation on 10143 for a real commit, and the
attester does the same; both visible on-chain.

## B1 Testnet deploy

Run the recipe on 10143: core proxy, Holding, both evaluators, receiver, `FactoryToken`, `mUSD`, `mEUR`;
verify all; register attester and receiver as verifiers; write `config/monad-testnet.json`; README
addresses. Then complete S5's live delivery.

Done: addresses verified on the explorer; a scripted `cast` hire runs publish → activate → submit →
accept on testnet.

## B2 Board service (S8)

1. `packages/spec`: Effect Schema for manifest, `OfferTerms`, `QuoteRequest`, `Quote`, `Selection`,
   `Ruling`, `CandidateEntry`, submission, evidence, receipt, dispute; JSON Schema export.
2. `packages/board`: Dispatch `board-logic` wrapped; hire handshake, quotes, contest candidates and award
   reconciliation, arbitration records; S8 acceptance tests.
3. `packages/sdk`: the functions listed in note 12 §7, network config driven.
4. `apps/api`: SIWE sessions; MCP with worker, publisher and arbitrator tools; relay (signer-bound, spend
   cap); authorised content-addressed manifest publication (the S0 probe PUT removed); fork SHA check;
   attester; real Jev client.
5. `apps/arbiter`: cron Worker, pluggable OpenAI-compatible endpoint, pinned prompt, signs `Ruling`,
   calls `submit_ruling`. `skill/arbitrator/SKILL.md` for a Claude Code session.
6. `skill/SKILL.md` worker skill + MCP snippets for Claude Code, Codex, Grok.
7. `scripts/push-secrets.ts`; `alchemy deploy --stage staging`.

Done, on testnet: a fixed-price hire, a quoted hire and a contest award each settle end to end through the
MCP with real harnesses; one dispute is ruled by `apps/arbiter` and one by a Claude Code session; each
demo wallet (`cast`, MetaMask agent wallet, Privy server wallet) completes its full lifecycle.

## B3 Discovery (S4 + Explore)

`apps/indexer` (HyperSync → D1, finalized blocks, lease, rebuild) with the S4 tests plus a live run against
the testnet deployment; `apps/explore` (Explore, Job detail, Publish for all three routes, Worker profile)
with Privy React, ethskills UX rules, Playwright smoke against `staging`.

Done: a full rebuild from the deploy block equals the live D1 state; Explore shows the B2 jobs correctly.

## B4 Trust signals / B5 Dispute UI

Jev at publish and on submission against the real API; evidence from both verifiers on real repos; the
dispute UI (violation, reasons, ruling, burns) and the early contest award; the demo-window evaluator
selected by config.

## B6a Testnet demo run

The whole note 12 §2 script on testnet, real harnesses (Claude Code, Codex), real services, recorded.
ethskills qa by a separate agent (PASS/FAIL, no fixes), crops, audit skim; fixes, then re-record.

## B7 Mainnet (after B6a, after the note 12 §11 mainnet items are decided)

Mainnet EOAs funded; `config/monad-mainnet.json` with USDC allowlisted and no faucet token; custom domain;
the same recipe with real windows; verify; `prod` stage for API, arbiter, indexer, Explore; one real job
published, activated, delivered and settled with real USDC. Every transaction waits for Kris's go.

## B6b Ship

Cloudflare OS Dispatch publish (request quotes); the three-minute video; README (admin, pause commitment,
addresses and transaction hashes on both networks, "unaudited", AI disclosure); submission.

## Credentials

See `.env.example` and note 12 §13a. Mainnet-only items are needed at B7, everything else at S-1.
