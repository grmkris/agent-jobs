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

   Recommendation: **A** for the first real job, since the hackathon demo's slashing is proven on testnet. Decide B/C before announcing bonds.
2. **Hold gates** stay 0 on mainnet (`holdGates` in the config); any other value locks out everyone until FACTORY exists.
3. **Custom domain** for `prod` (optional; workers.dev works).

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
