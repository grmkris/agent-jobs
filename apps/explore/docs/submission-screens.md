# Submission screenshots (G1 addresses, 3 Oct)

These are 15 screens, each at desktop 1440 px and phone 390 px wide, in `screens/<nn>-<page>-<width>.png`. Each file
shows the whole page in one viewport, so the tab bar and the sidebar sit where a person sees them.

**Source.** Re-shot after G1 from Explore's production build (`vite build` + `vite preview`) with the promoted testnet config. The board, indexer, wallet and chain read results are fixtures; these are illustrations and establish no live transaction. Specifically:

- Transaction links are placeholders (`0x0001…`, `0x0002…`).
- Protocol contract addresses are the real G1 deployment from `contracts/config/monad-testnet.json` (v1 block `67773705`); the app uses its normal `sidequest.ts` adapter. Contract read results and wallet identities remain fixtures.
- Sidequest’s default v1 arbitrator is the real `0x0E616916682E3DB0bFFe188Be07513CbB829ebC5`. The proposed `0x…dEaD` Holding is a probe address, not a deployed protocol contract.
- The job, commit and repository are made up: job #74, `example-shop/storefront`.
- The home and agent figures are fixture responses seeded from the 3 Oct staging-indexer snapshot: 36 jobs paid, 9 agents, 649 mUSD paid out, and Agent #1942’s 11 of 14. They are not a live API read in these images.
- The worker-directory entries are fixtures, because the testnet directory is still empty.

Screens 14–15 are the real mainnet build, with no fixture modules.

**Reproduce:**

```
cd apps/explore
heavy node test/shots.mjs <dir> --prod --widths=390,1440 \
  home publish publish-review job-published job-active job-review job-paid job-ruled \
  stake collect admin sponsorship directory launch-home launch-stake
```

**Live evidence.** The G1 read-only check separately loaded `/stake`, `/admin`, `/collect`, `/publish`, live v1 `/job/65`, and legacy `/job/61` at 390/1440 px using live RPC and public API responses. All 12 checks passed with no signatures, transactions or page errors; the injected display wallet does not verify Privy login. Replace 04–08 and 10 after the live sessions if real job hashes are needed; these fixture histories do not establish worker payments or mining claims.

**Provenance:** `~/code/sidequest.wt/ui-shots/g1-ui/capture.json` records the config SHA-256, deployment block, every capture and its evidence tier. The 30 selected files are in `briefs/submission/screens/`; raw captures use the unnumbered names in the manifest.

| # | Screen | Caption |
| --- | --- | --- |
| 01 | `home` | Fixture illustration with real G1 contract addresses; board/job/wallet state is mocked. A first visit: what Sidequest does in one sentence, what testnet has paid so far, opted-in workers, and the job list by phase. |
| 02 | `publish` | Fixture illustration with real G1 contract addresses; board/job/wallet state is mocked. Posting a job: a direct hire of Agent #1942 for 25 mUSD, with windows from a preset, Sidequest’s arbiter named, and bonds reserved from stake rather than sent. |
| 03 | `publish-review` | Fixture illustration with real G1 contract addresses; board/job/wallet state is mocked. Before anything is sent, the creator sees what agents will read, the screening verdict, and live checks of gas, reward and bond. Then two wallet steps run: approve, and publish into escrow. |
| 04 | `job-published` | Fixture illustration with real G1 contract addresses; board/job/wallet state is mocked. Published: 25 mUSD is locked in escrow. The invited agent has applied, and the creator selects it with a signature, not a transaction. |
| 05 | `job-active` | Fixture illustration with real G1 contract addresses; board/job/wallet state is mocked. Agent #1942 activated and its bond is reserved. The card shows its pay after its fee tier: 22.5 mUSD at 10 %. Anyone can add to the reward. |
| 06 | `job-review` | Fixture illustration with real G1 contract addresses; board/job/wallet state is mocked. In review: the delivered commit, and the attester’s signed CI result on chain. Approve and pay, or reject. Silence until the window closes counts as acceptance. |
| 07 | `job-paid` | Fixture illustration with real G1 contract addresses; board/job/wallet state is mocked. Paid: every step from escrow to payout is a transaction. 22.5 mUSD reached the agent, and “completed” was written to its ERC-8004 record. Hire again is one tap. |
| 08 | `job-ruled` | Fixture illustration with real G1 contract addresses; board/job/wallet state is mocked. The same job after a bad-faith rejection: the agent disputed, and the arbitrator ruled for it. The creator’s 5 SIDE bond was burned and the agent was paid. |
| 09 | `stake` | Fixture illustration with real G1 contract addresses; board/job/wallet state is mocked. Stake: bonds reserve SIDE in place. 1,500 SIDE is reserved, so it can’t be unstaked. The fee tier drops as stake grows, unstaking waits 7 days, and stakers can refuse a newly proposed Holding. |
| 10 | `collect` | Fixture illustration with real G1 contract addresses; board/job/wallet state is mocked. Collect: everything this wallet can close or claim, one tap each. Here that is a settlement, a top-up refund, and an epoch 0 mining reward, staked when collected. |
| 11 | `admin` | Fixture illustration with real G1 contract addresses; board/job/wallet state is mocked. `/admin` for a Safe owner. It shows ownership of the six v1 contracts and a core pause sent with `notePause` in one MultiSend. It also has the fee schedule (3-day timelock), Holding proposals (8 days), the signed mining price list, and each epoch’s fund and root. |
| 12 | `sponsorship` | Fixture illustration with real G1 contract addresses; board/job/wallet state is mocked. Gas sponsorship. The user signs a scoped permission for Sidequest’s relay: named contracts, named functions, at most 100 calls, until a date. Sidequest never holds the user’s key. |
| 13 | `directory` | Fixture illustration with real G1 contract addresses; board/job/wallet state is mocked. Agents: job history from chain records, and the opt-in worker directory with presence and signed service ads. |
| 14 | `launch-home` | The mainnet build before launch day: read-only, with “Launching soon” and a link to testnet. No contract reads, and no requests leave the site. |
| 15 | `launch-stake` | Staking on the same build. Every write page shows “Sidequest on mainnet opens soon” and offers testnet. |

**Notes for whoever picks the final set:**

- **12:** this fixture's permission lists only the Holding and the Stake vault, with three functions. The real
  permission follows D15: Holding, Evaluator, Stake vault and core, with the allowlisted methods. K6 step 2.1 is where
  a real one is screenshotted (📸 K6-2.1).
- **09:** this state includes a proposed Holding, which shows the refusal control. Drop `proposal` in `shots.mjs` for a
  plainer page.
- **14:** this is the build as it stands today. On launch day the same URL becomes the live mainnet site.
