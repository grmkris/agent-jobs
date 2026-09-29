# Mainnet runbook (B7)

Every step that sends a mainnet transaction is marked **[tx]** and runs only on Kris's explicit go.

Each step is one command from the repo root (or `contracts/` where stated). Secrets are read from `.env.local` with
`bash -c 'set -a; . ./.env.local; set +a; …'` and are never printed.

## 0. What is already proven, without a mainnet transaction

- **The recipe on a fork of 143.**
  - `contracts/test/fork/Deploy.t.sol` covers the recipe with the committed `config/monad-mainnet.json`: no faucet, USDC allowlisted, FACTORY never enters the core, and a faucet config refused.
  - `contracts/test/fork/MainnetRehearsal.t.sol` runs a real Circle USDC hire paying 5 USDC, writing feedback to the **real** mainnet Reputation Registry for an agent registered on the **real** Identity Registry.
  - The same file covers silence settling for the worker after the review window, a signed ruling relayed by a third party (refund plus worker-bond burn, nonce not reusable), and a bonded listing refused while no FACTORY is minted.
  - Run all of it with: `(cd contracts && set -a && . ../.env.local && set +a && forge test --match-path 'test/fork/*')`
- **The deploy script simulated against a local anvil fork of 143** (27 Sep, block ~108.58M):
  - 16.78M gas in total;
  - at 202 gwei max fee, forge estimates **≈ 3.39 MON** for the whole deployment;
  - Monad charges the gas *limit*, so budget above the estimate.
- **Read-only 143 checks** (`node --experimental-strip-types scripts/reality-check.ts`, row "Mainnet readiness"):
  - the ERC-8004 identity and reputation registries, the CRE KeystoneForwarder and USDC `0x7547…b603` (6 decimals) all have code;
  - every role wallet is at **0 MON, nonce 0**.
- **The whole Cloudflare stack is network-agnostic.**
  - `AGENT_JOBS_NETWORK=monad-mainnet` makes the API, the indexer and Explore use `MONAD_MAINNET_RPC_URL`, `https://monad.hypersync.xyz` (verified) and chain 143.
  - The `prod` stage gets its own D1, R2 and Durable Object.

## 1. Decisions needed first

1. **FACTORY supply.** The recipe deploys `FactoryToken` with **no faucet** and **`minter` = admin** (`config.factory`). Until something is minted:
   - every mainnet listing must have `creatorBond = workerBond = 0` (the fork test proves a bonded publish reverts);
   - there are no slashing stakes on day one; rulings still decide who is paid.

   Options:

   | Option | Recipe change | Effect |
   | :--- | :--- | :--- |
   | A. Keep minter, mint later | none | Ship bondless; mint when bonds are wanted (`FactoryToken.mint(to, amount)` from the admin) **[tx]** |
   | B. Fixed supply now, minter kept | none; after deploy, one `mint(treasury, supply)` **[tx]** | Bonds possible from day one; supply can still grow |
   | C. Fixed supply, no further minting | `minter` is immutable and there is no renounce, so either a contract change (`renounceMinter`, a re-audit of `FactoryToken`) or mint the full supply to a treasury and freeze admin minting by public commitment | Hard cap only with the contract change |

   | D. A token launched elsewhere (e.g. nad.fun) | `"factory": { "faucet": false, "minter": "<unused>", "address": "0x…" }` in `config/monad-mainnet.json`; the recipe then deploys no `FactoryToken` and Holding bonds in that token | Supply, price and liquidity come from the launcher; Holding needs no mint or burn rights (a slash sends the bond to `0x…dEaD`) |

   **Option D checks before deploy** (Holding's bond token is immutable; a wrong token means a new Holding pair):
   - A plain ERC-20 with 18 decimals. **No fee or tax on transfer**: Holding compares balances around every bond pull and reverts `BondTokenFeeOnTransfer` (`BondTokenTest`), so a taxed token makes every bonded listing fail. Pons v2 offers an optional creator tax and runs on Robinhood Chain rather than Monad; nad.fun is the Monad-native launcher (1% trading fee on the curve, not on transfers; confirm on the verified token source).
   - Transfers to and from a contract work before the token graduates to a DEX (some launchers limit transfers while on the bonding curve).
   - No blacklist or pause the launcher controls, since either could freeze bonds held by Holding.
   - Verified with a fork test: `MainnetRehearsal.t.sol::test_fork_mainnet_launchedFactoryTokenBondsAndSlashes` with the real token address in place of `LaunchedFactory`.
   - Testnet keeps the old bytecode (FACTORY via `FactoryToken.burn`); the generalized Holding deploys first on mainnet.

   Recommendation: **A** for the first real job, since the hackathon demo's slashing is proven on testnet. Decide B/C/D before announcing bonds. **Kris, 28 Sep: mainnet waits for the FACTORY decision; D (a launched token) is likely.**
2. **Hold gates** stay 0 on mainnet (`holdGates` in the config); any other value locks out everyone until FACTORY exists.
3. **Custom domain.** `alchemy.run.ts` puts `prod` (mainnet) on `hireling.xyz` and `staging` on `testnet.hireling.xyz`, and
   until now staging also answers `hireling.xyz` with a 301. Before the first `pnpm deploy:prod`, redeploy staging with
   `HIRELING_APEX_REDIRECT=0` to release the apex; then deploy prod, set `MAINNET_LIVE = true` in
   `apps/explore/src/wallet.ts` (the header switch) and redeploy both. Add `https://hireling.xyz` to Privy's allowed domains.
4. **Who holds the admin role.** The independent review (28 Sep, Codex) rated this critical. The admin of the vendored core can:
   - `pause`, then `emergencyWithdraw` the whole escrow balance while paused;
   - authorize a UUPS upgrade;
   - raise the platform and evaluator fees, which `_complete` reads at payout time, so a change after funding applies to live jobs.

   The recipe gives all of this to one EOA (`0x6752…ad73`). Nothing in code changes that before B7. The options:
   - **(a) Keep the EOA** and state the trust assumption and the commitment in the README (fees stay 0, no pause or upgrade during an active agreement). This is the smallest change for the hackathon.
   - **(b) Move the admin roles to a Safe** right after the deploy. This takes one `grantRole`/`renounceRole` pair per role **[tx]**.
   - **(c) Renounce the upgrade and fee roles** after the deploy. This cannot be undone.

   Recommendation: (a) for tomorrow, plus a README "Trust" section; (b) before real volume.

## 2. Funding [tx, by Kris from his own wallet]

Keep the role wallets separate (they are separate keys in `.env.local`).

| Role | Address | Send | Why |
| :--- | :--- | :--- | :--- |
| admin (deployer) | `0x675269d710692d4d0d7166da11B76463577aad73` | 6 MON | deploy ≈ 3.4 MON at 202 gwei, plus verify retries, the CRE receiver later and a FACTORY mint |
| relay | `0xac7282b6a519665dcb71563317C71d1F357f9e7e` | 2 MON | relays awards, signed rulings and timeouts (value-0 calls) |
| attester | `0x66b72404Ad8ce4C650C4f67F13AAd1Ee82F2963f` | 1 MON | attaches evidence |
| arbitrator | `0xc657F023F938BB89de590Ed96f79B775c7dDd632` | 0 | only signs; the relay sends |

The first real job also needs a creator wallet with USDC (reward) and a little MON, and a worker wallet with a little MON. Space out transfers to one wallet (Monad's reserve-balance rule; see `reality-check.md`).

Check: `node --experimental-strip-types scripts/reality-check.ts`. The "Mainnet readiness" row must list non-zero balances.

### Before the mainnet deploy: signature checks for delegated wallets

OZ's `SignatureChecker` consults only ERC-1271 once a signer has code, and a 7702-delegated EOA has code. Our own
batches and every budget grant point accounts at MetaMask's `EIP7702StatelessDeleGatorImpl`, whose ERC-1271 accepts
the account's raw ECDSA signature over the hash and refuses any other key (checked on a testnet fork, 29 Sep), so they
work as `Simple7702Account` did (proven, testnet job 48). A wallet delegated to an account whose ERC-1271 wraps hashes (ERC-7739 style) would fail the
Selection, budget/submit authorizations, rulings and evidence. Before the fresh mainnet deploy, switch those four
checks (`JobHolding.sol` selection, `ERC8183WithAuthorization.sol` authorizations, `JobsEvaluator.sol` ruling and
evidence) to ecrecover-first, then ERC-1271 (Solady's order), with 7702 tests (`vm.signDelegation`). It changes the
vendored core, so record the patch next to the vendor pin in `contracts/SURFACE.md`.

## 3. Deploy and verify [tx]

From `contracts/`:

```
bash -c 'set -a; . ../.env.local; set +a; \
  NETWORK=monad-mainnet MAINNET_GO=yes forge script script/Deploy.s.sol \
  --rpc-url "$MONAD_MAINNET_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast --slow --verify \
  --etherscan-api-key "$MONADSCAN_API_KEY"'
```

- The script refuses mainnet without `MAINNET_GO=yes` and refuses a broadcaster that isn't the configured admin.
- It writes `.deployment` (block, core, factory, rewardTokens, `main.holding`, `main.evaluator`) into `config/monad-mainnet.json`.
- Commit that file: `git add contracts/config/monad-mainnet.json`.
- If `--verify` fails on some contracts, re-run `forge verify-contract` per address; Sourcify also works.

Wiring check (read-only):

```
cast call <main.holding> "evaluator()(address)" --rpc-url "$MONAD_MAINNET_RPC_URL"
cast call <core> "allowedPaymentTokens(address)(bool)" 0x754704Bc059F8C67012fEd69BC8A327a5aafb603
cast call <main.evaluator> "arbitrator()(address)"
cast call <main.evaluator> "verifiers(address)(bool)" 0x66b72404Ad8ce4C650C4f67F13AAd1Ee82F2963f
```

Expected: the evaluator address, `true`, the arbitrator, `true`. Then run `pnpm gen-abi` if the SDK's deployment reader needs regenerating (it reads the config JSON; normally nothing to do), and `heavy pnpm check`.

## 4. Cloudflare prod stage (no chain transaction)

- `pnpm deploy:prod` (= `AGENT_JOBS_NETWORK=monad-mainnet ALCHEMY_REMOTE_STATE=1 alchemy deploy --stage prod --yes`).
- **Blocker:** remote state needs **Secrets Store: Edit** on the Cloudflare token. Without it, either:
  - add the permission (preferred: prod state must not live only on netcup), or
  - deploy with local state: `unset ALCHEMY_REMOTE_STATE; AGENT_JOBS_NETWORK=monad-mainnet pnpm exec alchemy deploy --stage prod --yes`, and back up `.alchemy/`.
- Deploy only **after** step 3: Explore reads `.deployment` at build time.
- Checks:
  - `curl <api>/health`;
  - `protocol_info` over MCP shows chain 143 and the mainnet addresses;
  - the indexer's `GET /` shows `next_block` ≥ the deploy block within a few minutes;
  - Explore shows chain 143 and Monadscan links.

## 5. First real USDC job [tx]

Bondless (see §1), fixed-price hire on the `main` stack.
- Reviews use the real windows: review 3 days, dispute 3 days, arbitration 7 days. The approver should accept explicitly rather than wait out the window.
- The creator is Kris's own wallet: publish from Explore's Publish screen on the prod site, or ask an agent through the board's MCP `create_task` and sign the returned steps in the browser. (`packages/sdk/scripts/board-hire.ts` is testnet-only: it reads the testnet creator key.)
- The worker is a headless Claude Code session with `skill/worker` and a fresh mainnet key holding a little MON; it registers on the mainnet Identity Registry the first time.
- Record every hash in `docs/reality-check.md` under a "B7 mainnet" section.

## 6. MetaMask agent wallet on 143 [tx]

MetaMask's services refuse 10143, so its transaction path is proven only here: `packages/sdk/scripts/board-mm-contest.ts` (or a hire) with `NETWORK=monad-mainnet` against the prod API.

## 7. If something goes wrong

- **Contract bug:** the admin can `pause` the core (see `contracts/SURFACE.md`). Pause also blocks timeouts, so a promise made while paused is void; the README states the commitment not to pause during an active agreement. `emergencyWithdraw` works only while paused.
- **Board or Worker problem:** chain state is authoritative. Rolling back a Worker (`alchemy deploy` of the previous commit) loses nothing; the indexer can rebuild D1 from the deploy block.
- **A leaked key:** every role key is separate. A relay or attester key can be replaced by config and redeploy of the Workers; the arbitrator is immutable per evaluator (a new evaluator pair means a new deployment).

## 8. Not blocking B7

The CRE receiver (`Recipe.deployReceiver`) waits for Chainlink CRE deploy access; the board's attester covers evidence until then.
