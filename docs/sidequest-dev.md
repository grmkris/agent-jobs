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

The development URL was deployed on 6 October 2026. Public health, release,
directory, agent setup and OAuth discovery checks pass. Anonymous writes and
MCP requests require authentication. Twenty browser page/theme/viewport checks
passed without page errors or overflow. The narrow Privy origin update has since
saved successfully, and the repeated sign-in modal smoke has no provider errors.
App display name, authenticated MCP enumeration and real human login remain
unverified. The routine signer still pins archived contracts; a separate Sidequest
policy must preserve the legacy policy and its recovery authority. See
[the cutover handoff](sidequest-agent-handoff-2026-10-06.md) for dated readbacks.
The indexer cron has produced progressing checkpoints with no jobs in this fresh
deployment.

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
signer addresses and completed Safe ownership. It deploys a committed export;
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
with containers and journals retained. Legacy demand job 131 has an unresolved
saved Collect intent; its owner must reconcile it before broadcasting or removing
state. [Stop evidence](evidence/sidequest-dev/2026-10-06-legacy-workloads.json)
records the exact boundary. Old provider-resource retirement remains pending.

Rename notices were attempted before overlapping edits; the stored mytmux
receipts still have unknown delivery. V1.1 and profile have now explicitly
acknowledged the rename after resuming. The verified local
[agent handoff](sidequest-agent-handoff-2026-10-06.md) records exact operations,
track heads, ownership and pending gates. GitHub is `grmkris/sidequest`, companion
deliveries are `grmkris/sidequest-demo-deliveries`, and the shared origin points to
the new repository. Local reset commits await the checked push candidate.
Physical checkout/worktree/tmux paths stay stable while their owners integrate.
