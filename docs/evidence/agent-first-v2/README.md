# Spec v2 P0 authority evidence — 4 October 2026

[p0-authority.json](p0-authority.json) contains the sanitized provider results, identifiers, all eleven
Monad testnet transaction receipts, measured costs and source hashes. This is fixture evidence on chain 10143.
The operator is a fresh local fixture key; the agent wallet belongs to an API-created Privy fixture user.
It establishes the underlying signing and delegation integrations, not genuine-user onboarding or a deployed v2 service.

| Proof | Result | Evidence |
| --- | --- | --- |
| P0.1 | PASS (Claude accepted) | User ownership and signer/policy binding read back; Worker WebCrypto P-256 authorization accepted; EIP-712 wallet signature recovered correctly. |
| P0.2 | PASS-WITH-NOTE | Eight initial `policy_violation` denials, plus wrong 7702 target. Three bounded export probes were refused: raw point without/with routine authorization returned `400 invalid_data`; SPKI with routine authorization returned 401. These do not prove policy evaluation of export. The actual policy has an explicit export DENY and no export ALLOW. No positive owner export control exists for this fixture. |
| P0.3 | PASS | Routine-key policy update and signer removal returned `401 invalid_data`; readback unchanged. |
| P0.4 | PASS | Relayed upgrades, registration to operator DeleGator, and upgraded-agent consent. Registry agent **2001** is owned by `0x37D8Cf41ec626FA5E3bF096ef9923CbB9F36823e`; agentWallet is `0x27100E3DEb7f48a148B2387c3Be6605E2D5c0419`. |
| P0.5 | PASS | Real nested redemptions, 116-byte terms equal to MetaMask delegation-core 3.0.0 and onchain `getTermsInfo`; live start, cap, wrong recipient/token and rollover checks with a 90-second fixture period. Separate real Monad fork covers the exact 25 mUSD / seven-day / 30-day terms and expiry. |
| P0.6 | PASS | One relay transaction pulled exactly 1 mUSD, approved Holding and published fixture job **107** as the agent. The job was cancelled and refunded. Both fixture spending allowances were disabled and read back as disabled. |
| P0.7 | DEFERRED, per plan | A fixture has no genuine Privy browser session. Kris must prove owner recovery signing of the server-created wallet during P8. No fixture signer is substituted for that result. |

| Measured shape | Transaction | Charged gas | Recommended floor input |
| --- | --- | ---: | ---: |
| Register through the relay grant | [0xeacca82f…d6ec96](https://testnet.monadscan.com/tx/0xeacca82fb5611c207e36ff078e29189e76c6e487074adb5ac72b3dde33d6ec96) | 645,709 | 850,000 |
| Set agent wallet through the relay grant | [0x93b8587b…d2498e](https://testnet.monadscan.com/tx/0x93b8587b67f40837a6c9358db02e3efb366cdd52bc7df45768c7d504b1d2498e) | 424,527 | 550,000 |
| Nested first-period redemption | [0xecd702d4…2a77b](https://testnet.monadscan.com/tx/0xecd702d4a4403462d83a3fb908589bbf80d025c43f743fc71b0844c91ab2a77b) | 754,669 | 950,000 |
| Nested redemption after rollover | [0xc8501606…c2db](https://testnet.monadscan.com/tx/0xc85016061b53ddff9e529ccc6ef5152ac710408de023f8d5a7bad0807681c2db) | 604,197 | 950,000 |
| Atomic allowance pull + approval + publish | [0x809165b1…3a27e](https://testnet.monadscan.com/tx/0x809165b1c08c0e5ab0d4811557d36bf0b216caea3e50e31a1695e73cae83a27e) | 1,771,615 | 2,250,000 |

The publish inner call used **465,815 gas**, established by `debug_traceTransaction` with `callTracer`.
That trace number excludes the redemption and token operations. Monad charged the transaction's full requested
1,771,615 gas. Floors are conservative inputs for the P2/P3 builders; existing payout floors in `V1_GAS` are unchanged.

Privy enforced the typed-data chain, verifying contract, primary type and exact schema; `Delegation.delegate = relay`;
`AgentWalletSet.newWallet = wallet.address`; the 7702 target; and the absence of transaction signing/sending.
Domain name/version, Selection spending/job linkage, fresh-net budget linkage, B1/B2/B3 caveat templates, and the
7702 chain restriction remain app-enforced requirements for the later application implementation.

All sends persisted exact signed bytes, hash and nonce before broadcast in an ignored, mode-600 private journal.
Resumes reconciled the original hashes. Two runner budget holds occurred before broadcast: first the runner
over-reserved already-mined maximum fees, then the measured atomic batch required more fee exposure than its
initial 0.5 MON cap. The corrected accounting uses actual mined receipt costs plus unresolved signed fee exposure;
the final run cap was 1 MON, below the configured 10 MON daily policy, with a 2 MON relay reserve.
Actual P0 relay expenditure was **0.632758122 MON**; all eleven receipts succeeded. This number covers this run,
not an inventory of other hosted relay activity. No extra transaction was sent for either budget hold.

Run from the repository root:

```sh
pnpm exec bun packages/sdk/scripts/privy/setup.ts
pnpm exec bun packages/sdk/scripts/live/prove-authority.ts
heavy pnpm check
```

The fork suite is `packages/sdk/scripts/live/authority.fork.test.ts`; enable it with `MONAD_TESTNET_RPC_URL`
and run it through `heavy pnpm --filter @agent-jobs/sdk exec vitest run scripts/live/authority.fork.test.ts`.
It only broadcasts to its local Anvil instance. The two P-256 tests and the fee-exposure regression are pure tests.
No new mocked tests were added. Never print `.env.local`, `~/.config/secrets.env`, or the ignored `.local` journals.

Validation passed: `heavy pnpm check` (exit 0, including lint); two real fork cases plus two pure P-256 cases;
and the pure fee-exposure regression. The default repository gate skips RPC-dependent suites, while the explicit
fork command enables them. Unchanged Vite+ tasks may replay cache. An unrelated existing Telegram workerd
assertion failed once, then passed both its isolated retry and the final full gate without API source changes.
The literal scan against actual credentials found no secrets in the owned files. The operator fixture private key
is held in ignored `.env.local`, not the receipt journal.

P0 ends here. P1 and releases await Claude; genuine-user recovery and the broader A01–A08 acceptance remain open.
