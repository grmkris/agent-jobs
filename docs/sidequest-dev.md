# Sidequest development release

Sidequest is the product, `sidequest` is the repository/package identity, and the
development service belongs at **https://dev.sidequest.exchange** on Monad
testnet (10143). The apex is reserved for a separately authorized mainnet release.
New sessions, OAuth scopes, signing domains, Safe, contracts, D1, R2 and Worker
names use Sidequest. There are no old-domain redirects or compatibility aliases.

The identity uses a two-path mark: work branches out and returns with a result.
Evergreen (`#124230`) sits on warm paper; dark mode uses pale mint. An editorial
serif headlines the landing page, while the application keeps readable, compact
type. Status colours keep their established meanings. App icons and favicon are
generated from the same SVG. Contrast, focus and reduced-motion gates still apply.

The latest guarded dev application release is `4dc03be`, deployed on 6 October 2026
at 14:33:59 UTC. The [host-parity live receipt](evidence/sidequest-dev/2026-10-06-4dc03be-live.json)
records its source/tree, green gates and successful guarded update. Host acceptance and
authenticated MCP calls remain unverified.

The previous signed-off dev application release was `e90b9f5`, deployed on 6 October 2026
at 11:51:14 UTC. The [dated live receipt](evidence/sidequest-dev/2026-10-06-e90b9f5-live.json)
records the exact source/tree, Worker versions, authority binding, anonymous browser smoke and
public readback. It includes the video-review application and the anonymous publisher-handoff fix. Public health, release,
directory, agent setup and OAuth discovery checks pass. Anonymous writes and
MCP requests require authentication. Twenty browser page/theme/viewport checks
passed without page errors or overflow. The narrow Privy origin update has since
saved successfully, and the repeated sign-in modal smoke has no provider errors.
The Privy display name, evergreen color and Sidequest icon were saved and read
back through the narrow branding form. Authenticated MCP enumeration and real
human login remain unverified. Anonymous 390px/1440px browser checks visually
confirmed the deployed icon in the live sign-in modal with no provider errors.
The separate Sidequest routine policy now pins the fresh contracts and preserves
the legacy policy and its recovery authority. Its dev binding is guarded by a
private journal and a four-field dev overlay. See
[the cutover handoff](sidequest-agent-handoff-2026-10-06.md) for dated readbacks.
The indexer retains its minute cron and progressing checkpoints; one completed
testnet hire is now indexed. V11 verified chain events entering the feed and a
paid request to the public `/x402/demo` endpoint. Its local test-wallet signature
does not establish acceptance of the hosted managed signer.

## Release

Use Node 24 through the installed pnpm runner:

```sh
heavy pnpm check
pnpm sidequest:test
pnpm db:generate --check
heavy pnpm dlx node@24 scripts/sidequest/dev-release.mjs plan
SIDEQUEST_DEV_RELEASE=1 heavy pnpm dlx node@24 scripts/sidequest/dev-release.mjs
```

The runner checks `main`, committed release source, Cloudflare account/zone
ownership, fresh names (or exact owned state for a later update), RPC chain,
signer addresses, completed Safe ownership, and fresh Privy authority readback.
It reads `.sidequest/privy-dev.env` only after validating the frozen authority
journal and confirming the original credential was replaced. It deploys a committed export;
four explicitly known neighbour files can remain dirty without entering the
release. No worktree files are moved. `.alchemy/state/Sidequest/dev` is the sole
dev backend, independent of the historical staging stack. The generated directory
migration is deliberately applied to this new D1. Provider output and any
credential-bearing state remain in ignored private files.

Testnet setup scripts require `SIDEQUEST_TESTNET_SEND=1`. Native gas and Safe
creation persist signed bytes before sending and reconcile the original hash on
resumption. Forge deploys use fresh encrypted keystores, a separate broadcast
directory, fixed gas pricing, and the existing candidate → live verification →
promotion → Safe acceptance procedure. A partial deployment must be reconciled;
starting it again is refused. SIDE has one billion fixed initial units and no
faucet or mint hook. mUSD/mEUR are explicitly labelled testnet faucet assets.

## Acceptance and remaining integration work

Record live receipts in `docs/reality-check.md`: release metadata, health, MCP
enumeration and anonymous refusal, directory reads, canonical domain/TLS, and
two indexer cron observations with checkpoint progression. Browser proof covers
desktop/mobile, light/dark, assets and console/network errors. Real Privy OAuth
consent is separate from an anonymous page check; its provider allowlist and
branding must name the new origin before claiming authentication acceptance.

Historical configs and receipts retain their actual names and addresses. Before
retiring the prior stack, reconcile jobs, pending sends, bond reservations,
deferred settlement, owed payouts, operator grants and managed-wallet authority.
Existing testnet keys exposed in an earlier diagnostic are treated as compromised;
new Sidequest uses fresh keys, and old keys are retained solely for deliberate
reconciliation until their authorities can be removed safely.

The three old local crew containers were stopped at 04:34 UTC on 6 October,
with containers and journals retained. V11 subsequently reconciled the eight
named legacy jobs in 15 successful transactions, including job 131's settlement;
its original Collect journal remains untouched. The residual 0.9 mUSD and wider
Board authority inventory still block old-provider retirement.
[Executed evidence](evidence/sidequest-dev/2026-10-06-legacy-reconciliation-executed.json)
records that boundary.

Rename notices were attempted before overlapping edits; the stored mytmux
receipts still have unknown delivery. V1.1 and profile have now explicitly
acknowledged the rename after resuming. The verified local
[agent handoff](sidequest-agent-handoff-2026-10-06.md) records exact operations,
track heads, ownership and pending gates. GitHub is `grmkris/sidequest`, companion
deliveries are `grmkris/sidequest-demo-deliveries`, and the shared origin points to
the new repository. The reviewed reset, V1.1 fixes, S3–S5/P1b, profile C8–C14, Explore W4, the canonical x402 routing fix
and the 6 October video-review implementation are published and deployed through `e90b9f5`. Further
authenticated MCP, inbox, webhook and managed-signing proofs remain V11's lane.
Physical checkout/worktree/tmux paths stay stable while their owners integrate.

The read-only policy planner is
`pnpm exec bun packages/sdk/scripts/privy/sidequest-policy-plan.ts`. It verifies
the archived policy differs only in the reviewed name/four pins and produces a
separate-policy payload; it never updates legacy recovery authority. App and
routine-signer credentials exposed during a search are treated as compromised.
Credential rotation, isolated Sidequest authority and provider readback precede
managed signing acceptance; the old recovery journals/resources remain retained.

The isolated cutover is `packages/sdk/scripts/privy/sidequest-cutover.ts`:
`prepare` verifies retained authority and freezes a fresh local routine key;
after the app secret is replaced, `SIDEQUEST_PRIVY_APPLY=1 ... apply` creates one
fresh one-key routine quorum and the exact separate 11-rule policy. Creation
intents are saved before requests; a lost response requires reconciliation and
never triggers another creation request. `verify` performs provider GETs and
checks the ignored dev overlay. It preserves the existing policy-admin quorum
and every legacy signer/policy entry in `.env.local`. The dev runner alone merges
the verified overlay into the deployment environment; historical staging and
production remain outside this cutover.
