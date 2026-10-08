# G1e testnet send sequence

Prepared for the 8 October 2026 creator-bond redeploy. This is a plan, not live evidence.
Read `docs/stages.md`, `docs/deploy.md` and the G1e common/OPS briefs before execution.

## Execution contract

- **Only the orchestrator pushes.** OPS never pushes `dev` or `prod`.
- Execute from **`/home/kristjan/code/agent-jobs`, branch `dev`, at the integrated dev SHA after READY BOND and READY OPS**.
  Record that full SHA before step 0. The isolated `g1e-ops` branch is preparation only.
- Every numbered step requires the orchestrator's exact **`GO <step>`**. Finish its readbacks, append a UTC receipt to
  `/home/kristjan/code/agent-jobs.wt/status/g1e-ops.md`, and wait for the next GO. A prior release or fixture approval
  does not authorize this sequence. No A01–A08 fixture reruns; Kris handles manual acceptance.
- Monad testnet **10143 only**. Abort on chain 143, sender/nonce/input/config drift or a mismatching/failed receipt.
  Addresses, roles, decimals and seed amounts come from the reviewed network config, never copied literals.
- Retain `.sidequest/`, Foundry broadcast/cache files, `.g1e-refunds/`, the old G1d refund journal, all fixture journals,
  budgets, browser profiles and isolated Codex homes. Persist each operation before broadcast. Reconcile original hash
  and receipt first; reuse original signed bytes. A consumed nonce without the matching receipt is a hold.
- Use `heavy` for long builds/simulations; 75 is capacity. Never pipe it. Keep keys and raw provider responses private.
  Contract deployment uses the existing encrypted keystores. No mainnet action is included.

## Steps

0. **GO 0 — readiness and quiescence.**
   Confirm BOND's contract/ABI/SDK and OPS commits are integrated and the orchestrator's combined gate is green.
   Record candidate SHA, current origin dev/prod SHAs, release/health readbacks, old G1d config checksum and MON balances.
   Identify the existing arbiter by its exact command/PID; stop it cleanly with SIGINT, retaining logs/state. Do not signal
   a shell matched by its own command or a user-owned agent pane. Confirm no fixture runner or arbiter remains.
   Require no overlapping config/source mutation during cutover; preserve unrelated edits and resolve ownership with
   the orchestrator. Verify deployer, Safe owner, ecosystem and both relays have gas reserves covering the reviewed plans.

1. **GO 1 — archive job evidence.**
   From the integrated main checkout, run:

   ```sh
   node scripts/sidequest/archive-jobs.mjs --stage dev --out docs/evidence/sidequest-dev/2026-10-08-pre-g1e-jobs.json
   node scripts/sidequest/archive-jobs.mjs --stage prod --out docs/evidence/sidequest-prod/2026-10-08-pre-g1e-jobs.json
   ```

   Use the actual UTC date if execution happens later. Retain any existing output; reconcile it instead of overwriting.
   Record historical unfinished jobs and their old pair; archiving does not settle them or migrate rewards.

2. **GO 2 — archive G1d config.**
   `node scripts/sidequest/contracts.mjs archive --generation g1e`.
   Verify `contracts/config/archive/pre-g1e-monad-testnet.json` exactly equals the captured G1d config. Verify the live
   config's reset deployment keeps only reward tokens, and top-level roles, Safe, clocks, bond policy and liquidity
   inputs still match the candidate. An existing archive is a reconciliation hold, never permission to overwrite.

3. **GO 3 — build, simulate and deploy the new pair.**
   First `cd contracts && heavy forge build --force` in the integrated main checkout; then return to the repo root.
   `node scripts/sidequest/contracts.mjs deploy-plan --generation g1e` must simulate without broadcast and match
   `roles.admin`. Review the generated candidate and initial policy: 10 SIDE floor, 1,000 SIDE floor cap, 2,500 bps
   forfeit, 5,000 bps forfeit cap and 600-second grace. No posting fee.
   Only then `SIDEQUEST_TESTNET_SEND=1 node scripts/sidequest/contracts.mjs deploy --generation g1e`.
   A partial deployment resumes the retained Foundry run using `--resume` with the same script/keystore/config; inspect
   `.sidequest/contracts-g1e-deploy.log` privately. Do not start a fresh deployment or delete its candidate/locks.

4. **GO 4 — promote config.**
   `node scripts/sidequest/contracts.mjs promote --generation g1e`.
   Verify `deployment.sidequest.block`, all addresses/receipt blocks, preserved boards/links/USD flags, and reward tokens.
   Commit only the promoted config and its archive with the Codex co-author trailer. Record this descendant SHA.

5. **GO 5 — accept ownership and verify.**
   Run `accept-plan`, then `SIDEQUEST_TESTNET_SEND=1 … accept`, then `verify`, all with `--generation g1e`.
   Require successful receipts and Safe ownership/bootstrap. Read Holding's `minimumCreatorBond()`,
   `MAX_MINIMUM_CREATOR_BOND()`, `unfilledForfeitBps()`, `MAX_FORFEIT_BPS()` and `CANCEL_GRACE()` against the values above,
   using SIDE decimals. Read the current `FeeSchedule.treasury()` and record its Safe address.
   Verify the deployed vault bytecode/ABI includes `forfeit(address,uint256,address)` and authorizes the new Holding.
   ABI presence alone is source evidence; receipt/bytecode matching plus the late-cancel check in step 14 proves use.

6. **GO 6 — deploy and fund faucet.**
   `node scripts/sidequest/testnet-setup.mjs faucet --generation g1e` is the unsigned plan.
   Review it, then use the same command with `SIDEQUEST_TESTNET_SEND=1`. Its two persisted operations deploy the new
   faucet and transfer 10M new SIDE from the ecosystem allocation. Check owner, stake token and reward-token list.
   Read `stakeAmount()` and `paymentAmount()`; SIDE drip must be at least 1,000 SIDE (initially exactly 1,000).
   If `setAmounts(1000 SIDE, 1000 mUSD raw amount)` is needed, stop and prepare that exact owner-signed, journaled
   operation for a separate **GO 6a**; re-read decimals/owner and its receipt. Never change a faucet belonging to G1d.
   Commit only the resulting G1e config. The actual claim check is step 11.

7. **GO 7 — seed the new SIDE/mUSD pool.**
   Verify the config's quote is the first retained reward token and the liquidity holder is the deployer. Prepare the
   bounded 1,100 mUSD mint using `scripts/sidequest/transaction.mjs`'s `testnetOperation` with operation ID
   `g1e-pool-musd`, configured token/recipient, zero native value and matching testnet sender. Keep key values out of
   arguments/logs. Retain its original signed operation on every retry.
   Run `heavy bash contracts/script/seed-pool-testnet.sh --dry-run`, review funding/repair bounds, then run the same
   wrapper for real. Retain the Foundry broadcast file; a partial broadcast requires reconciliation and `--resume`,
   never a fresh seed. Read back pool key, minted position ID, Safe beneficiary and bounded repair spending.
   Commit any owned config change. No old-pool liquidity is migrated by this step.

8. **GO 8 — recreate vault positions and allocate Kris's SIDE.**
   Wait until the fixed cutoff is finalized: **new `deployment.sidequest.block − 1`**, not the old G1d deploy block.
   Generate the snapshot/manifest using G1d's archived config:

   ```sh
   node contracts/script/refund-manifest.mjs --generation g1e --source g1d --kris-side 20000 --config contracts/config/archive/pre-g1e-monad-testnet.json --block <cutoff> --out .g1e-refunds/manifest.json
   bash contracts/script/refund-batch.sh --generation g1e --source g1d --manifest .g1e-refunds/manifest.json
   ```

   Review checksum, snapshot block/hash, all position owners/queued shares/current asset values, dust and fixed
   20,000 SIDE transfer. **No liquid G1d balances migrate**; positions are recreated at their current assets.
   Only after the dry-run passes:

   ```sh
   SIDEQUEST_TESTNET_SEND=1 bash contracts/script/refund-batch.sh --generation g1e --source g1d --manifest .g1e-refunds/manifest.json --yes
   ```

   Reconcile the generation-specific locked journal before retrying. Check every recreated position/owner and transfer
   receipt against the manifest. Before any faucet claim by Kris, his new liquid balance must equal the explicit
   20,000 SIDE allocation. Copy the public manifest and paired snapshot into `docs/evidence/testnet-g1e/`; retain all
   private signed journals. Commit only public evidence. Old activity after cutoff is reported, not added to entitlement.

9. **GO 9 — re-pin Privy's routine policy for both stage relays.**
   Inspect `/tmp/aj-privy.sh` and its owned private env/journal paths before reusing it. It runs the reviewed
   `packages/sdk/scripts/privy/sidequest-cutover.ts` path from the main checkout.
   On this GO: `/tmp/aj-privy.sh update-policy`, then `/tmp/aj-privy.sh verify`.
   Independently read back the exact fresh contract targets/chain and **both dev and prod relay sender rules**.
   Preserve the routine signer/quorum and existing unrelated rules. Stop on binding/quorum/policy mismatch; keep the
   update journal for reconciliation. Never print the secret, admin key, raw provider response or credential object.

10. **GO 10 — record and release (orchestrator only).**
    Add dated receipts to `docs/reality-check.md`, update `docs/stages.md` and commit explicit owned paths.
    The orchestrator runs required combined checks/build, pushes the accepted dev SHA, and watches verify/deploy/smoke/drift.
    Confirm dev's indexer reports the G1e pair, cutover and deployment block before the orchestrator promotes the same
    accepted release SHA to prod and watches its CI. Wait for both stage health/release/config readbacks and a fresh cron.
    OPS records CI run IDs and received release SHA; OPS does not push or call a direct release to bypass a failed CI plan.

11. **GO 11 — public checks and faucet claim.**
    Confirm both stages' `/health` and `/release.json`: healthy, Monad testnet, writes open and `mainnetLive:false`.
    Verify indexed jobs refer to G1e while historical archive evidence remains retained. Check a pool quote and one
    separately journaled faucet claim: `Dripped`, exact recipient, at least 1,000 new SIDE and reward-token increments.
    Record this as live faucet/pool proof, separate from anonymous health or authenticated acceptance.

12. **GO 12 — restart arbiter on the new pair.**
    Use the existing reviewed runner environment/log location and integrated checkout; no replacement systemd unit.
    Set `NETWORK=monad-testnet` and `BOARD_URLS=https://dev.sidequest.exchange,https://sidequest.exchange`.
    Verify the configured v1 arbitrator address, current Holding/identity, gas reserve and model settings without printing
    secrets. Start one `bun apps/arbiter/src/main.ts` process and record PID, signed-in board sessions and heartbeat.
    Check no duplicate old process and no unexpected pending job before launch. Startup is not proof of a completed
    ruling; any job-processing sends must be covered by this GO's approved scope, otherwise hold those actions.

13. **GO 13 — manual bonded quote hire and early cancel.**
    Kris funds and stakes his creator wallet and backs the agent via Explore. Confirm owner/position/available values.
    Use distinct frozen keys for a quotes-first bonded hire and a never-activated listing cancelled strictly inside
    600 seconds. Record quote selection, activation/delivery/completion and exact reward/fee/net amounts for the hire.
    For early cancel, use the receipt block timestamp, full bond release, zero treasury delta and no `BondForfeited`.
    A relay hire retains **three ordered calls** (reward pull, approval, publish); its creator bond is at least live floor.
    No automated A01–A08 fixtures. Preserve all UI/operation journals after an interrupted response.

14. **GO 14 — late unfilled cancel and indexed forfeit.**
    Publish a separate never-activated listing with the current floor and recorded snapshotted rate/publish time.
    Wait until the mined cancel can be at or after `publishedAt + 600` (use chain timestamps), then cancel once with
    its frozen key. With unchanged initial policy, 10 SIDE yields **2.5 SIDE to current treasury and 7.5 SIDE released**.
    Record successful receipt, exact `BondForfeited` args, SIDE transfer to the live Safe treasury, reserved-bond release,
    vault accounting and the indexed event for the same job/hash/block. Reconcile before retrying a lost response.
    An expiry/settle test is a separate **GO 14a** if requested; it must prove the same never-activated forfeit. Activated
    jobs retain no penalty at/after expiry. Record any untested manual items as pending.

15. **GO 15 — closeout.**
    The orchestrator owns bytecode baseline/full gate/fork verification and any final push. OPS records exact test counts,
    release/chain/provider/manual evidence separately, links receipts, appends completion status, and leaves retained
    journals intact. Mainnet remains a separate operation requiring Kris present and explicit transaction approval.
