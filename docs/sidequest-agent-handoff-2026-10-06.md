# Sidequest agent handoff — 6 October 2026

Recorded at 04:27 UTC (06:27 Ljubljana). This is the durable local handoff for
the Explore, V1.1, profile and FINALIZE-UI tracks. The overnight supervisor will
check resumption after 06:50 Ljubljana; that timing is supervisor-reported, not
a verified provider reset. Existing worktrees, pending work and dated evidence
are preserved.

## Names, domains and deployment scope

| Surface | Current identity |
| --- | --- |
| Product / packages | Sidequest / `sidequest` / `@sidequest/*` |
| Development URL / MCP | `https://dev.sidequest.exchange` / `/mcp` |
| Agent setup | `https://dev.sidequest.exchange/start.md` |
| Network | Monad testnet, chain 10143 |
| Token / contracts | SIDE / `SidequestHolding` / `SidequestEvaluator` |
| OAuth scopes | `sidequest:read`, `sidequest:hire`, `sidequest:work` |
| Cloudflare Workers | `sidequest-api-dev`, `sidequest-indexer-dev`, `sidequest-explore-dev` |
| D1 / R2 | `sidequest-dev-db` / `sidequest-dev-manifests` |
| Authoritative dev state | `.alchemy/state/Sidequest/dev` |
| Promoted chain configuration | `contracts/config/monad-testnet.json` |
| Safe | `0x77923113FD1a71Ad91F81064C3c05cA1EfB44CD8` |
| Fresh deployment block | 68581020 |

The apex `sidequest.exchange` is reserved for a separately authorized mainnet
release. There are no old-domain redirects or signing/session compatibility
aliases in the active Sidequest runtime. Historical receipts keep their actual
names, transaction hashes, URLs and chain addresses.

GitHub is now [`grmkris/sidequest`](https://github.com/grmkris/sidequest)
(repository ID `1388114392`); `origin` is `https://github.com/grmkris/sidequest.git`.
The companion repository is `grmkris/sidequest-demo-deliveries` (ID `1403726158`).
Remote main readback at 04:54 UTC remains `ff3fce60984b5281e10447170911b6fb4e97002b`;
the local reset commits have not been pushed. Physical checkout, worktree and
tmux paths remain `agent-jobs` / `/home/kristjan/code/agent-jobs.wt`. Keep those
paths stable while their owners integrate; a GitHub rename does not move them.

## Landed commits and verified dev gates

| Commit | Change |
| --- | --- |
| `c5625b8` | Sidequest identity reset and fresh testnet/dev deployment implementation |
| `e101fde` | Cloudflare count-based census pagination |
| `d73c76f` | Complete R2 cursor pagination |
| `82d1b26`, `e6aeb3b` | Evergreen two-path mark in favicon and app icons |
| `121dab0` | Development documentation and live evidence |

The deployed source is `e6aeb3b95f80f65fc781b54809aa757c6ad06995`, tree
`c28e25285dfbc4ba7074763076ea9a08303b69e3`, completed at 04:06:04 UTC.
The release journal is `.sidequest/dev-release.json`; public evidence lives in
[the live receipt](evidence/sidequest-dev/2026-10-06-live.json) and
[reality check](reality-check.md). Current main before this handoff is `121dab0`.

The local release gate passed: 519 Solidity tests with 45 skipped; 47 mining
tests with one skipped; package tests, typechecks and lint; `pnpm sidequest:test`,
`pnpm db:generate --check`, and whitespace checks. Public health, release,
directory, `/start.md`, assets and OAuth discovery passed. Anonymous writes and
MCP initialization return 401. Twenty live browser page/theme/viewport checks
passed without page errors or horizontal overflow. Cron checkpoints progressed
68587348 → 68587944 → 68589553; the fresh job index is empty.

Keep the retained application structure and status meanings while integrating
the new abstract two-path mark, SIDE icon, evergreen/paper and mint dark themes.
The global rename also changes environment names, import paths, generated skills,
signing domains, storage keys and test fixtures; do not resurrect old aliases
when resolving integration conflicts. A contract/ABI basename remaining
`Factory` is an implementation identifier, not the token's public symbol.

## Existing tracks and integration order

| Track | Current evidence | Next handoff step |
| --- | --- | --- |
| Explore coordinator `%14` | Alive; screen shows Claude 429 quota failures. | Read this file, review FINALIZE-UI commits, preserve the Sidequest identity during integration. |
| V1.1 coordinator `%13` | Alive; same quota failure. Main has its uncommitted indexer progression/feed fix. `v11` worktree at `8bc2dc5` retains separate API/MCP changes. | Own and commit the indexer fix; review WS5/WS7 worktrees before integration and release. |
| Profile/token chip `%20` | Alive; same quota failure. Clean profile worktree at `1c8b089` with WIP profile/ListingCard/AgentOrb groundwork. | Wait for Explore's explicit base-ready signal, then integrate onto Sidequest and run assigned gates. |
| FINALIZE-UI `%35` | Screen reports completed and stopped after S4; clean detached worktree at `a5171cb`. | Coordinator decides the pending rebase/S5 continuation; preserve the finished commits. |

The FINALIZE-UI commits are S3 `72f8573..2000483` and S4 `a5171cb`.
The exact brief is `/home/kristjan/code/agent-jobs.wt/briefs/finalize-explore/s3-s4.md`.
Its final triage entry and local receipts show all 18 local Explore e2e suites,
typecheck/lint/unit checks, full `heavy pnpm check`, and 76 reviewed screenshots
(38 light + 38 dark at 390/1440) with zero page errors. `g1-readonly` was skipped
by its brief; these are local fixture/browser gates, not Sidequest live proof.
Evidence: `/tmp/finalize-ui-s4-check.log`,
`/tmp/finalize-ui-s4-e2e/results.json`, and
`/tmp/finalize-ui-s4-shots-{light,dark}/capture.json`.

The triage directives at 04:09/04:41 call for rebasing the isolated FINALIZE-UI
worktree onto current main, rerunning S4 gates, then doing S5 from
`briefs/finalize-explore/s5.md`. That rebase/S5 is not evidenced as complete.
Its owner must resolve conflicts against the Sidequest names and already-landed
behavior, then review the actual diff. Do not replay the global rename across
historical evidence. The profile track still waits for an explicit base-ready
signal after the Explore work. This handoff neither resumes the builder nor
cherry-picks another track's commits.

WS5 work remains dirty in `/home/kristjan/code/agent-jobs.wt/v11-ws5` at
`8427695`; its triage entry has scoped gates but an interrupted full gate.
WS7 work remains dirty in `/home/kristjan/code/agent-jobs.wt/v11-ws7` at
`bc3d630`; its triage entry has scoped/full gates and awaits review. Neither is
included in the deployed Sidequest source. Preserve both; V1.1 remains their
integration owner. Provider permissions and runtime-DDL decisions are not
expanded by the rename.

The four formerly pending indexer files were committed by V1.1 as `fd76d04` at
04:52 UTC. Preserve foreign `.artifact-video/` and `packages/sdk/scripts/.local/`;
do not stage them with this handoff. The deployed source remains `e6aeb3b` until
the next reviewed Sidequest dev update.

## Notice delivery and acknowledgement

Read-only pane checks at 04:24–04:25 UTC show the original rename notice text
in `%14`, `%13`, `%20` and `%35`. That does not prove it was processed.
The stored mytmux operations, re-read in this turn, are:

| Pane | Operation | Receipt | Acknowledgement |
| --- | --- | --- | --- |
| `%14` | `op_01m47hy28e0000000000000001` | `tmuxAccepted`, `delivery: unknown` | Not observed |
| `%13` | `op_01m47hy28e0000000000000002` | `tmuxAccepted`, `delivery: unknown` | Not observed |
| `%20` | `op_01m47hy28e0000000000000003` | `tmuxAccepted`, `delivery: unknown` | Not observed |
| `%35` | `op_01m47hy28e000000000000000a` | `notDispatched`, `delivery: failed`; no safe prompt | Not observed |

None is counted as delivered. No notice was resent blindly; no pane was
interrupted, cleared or restarted. The shared triage log is
`/home/kristjan/code/agent-jobs.wt/status/triage.md`. This committed file is the
local handoff for the supervisor/coordinators to read after quota returns.
Record an explicit acknowledgement with owned paths, pending integration and
economic sends before repository moves or old-resource retirement.

## Overnight supervisor readback — 06 October 2026, 04:35 UTC

The canonical public development URL was rechecked after the initial release. `/health`,
`/release.json`, `/data/jobs`, `/data/directory`, both OAuth discovery documents,
`/start.md`, `manifest.webmanifest` and `favicon.svg` returned successfully. The
indexer checkpoint advanced to `68592054`; the fresh index remains empty. The
sanitized receipt is [the public recheck](evidence/sidequest-dev/2026-10-06-public-recheck.json).

The three old local crew containers were stopped cleanly with exit code 0 and retained
with their journals, source mounts and artifacts. Canvas and Studio have no unmatched
sends. Demand retains the unresolved `demand-4/collect/0` signed intent for legacy job
131 (nonce 7, saved hash prefix `0x282b…b3c3`); the testnet RPC readback still shows no
transaction or receipt and latest/pending nonce 7. This is a hold on removal or any
rebroadcast, not proof of full economic retirement. See [legacy workload evidence](evidence/sidequest-dev/2026-10-06-legacy-workloads.json).

Privy was not changed: the dashboard still shows the old app identity and the
shared-browser tab did not reach a settings form. The recorded origin blocker
remains open. Real login and
authenticated MCP remain unverified. The `%14`, `%13`, `%20` notice operations remain
`delivery: unknown`; `%35` remains `notDispatched`. The committed handoff is therefore
the verified local coordination record, with no acknowledgement claimed. No pane was restarted, interrupted or
cleared. FINALIZE-UI S4, profile and V1.1 worktrees remain under their existing owners.

## Remaining gates and release procedure

1. **Privy:** the narrow dashboard origin control added
   `https://dev.sidequest.exchange` and reported successful save. The repeated
   sign-in modal smoke has no provider errors. App display name, real login and
   authenticated MCP remain open. Read-only authority verification reports
   policy drift: only the name, Selection Holding, two core pins and delegation
   relay differ. Preserve legacy policy `s06i5eramn0plwdunkvxf8aj` and its recovery
   authority; create a separately journaled Sidequest policy with the same 11
   rules and fresh pins, then bind it only to the dev stack. Do not blindly PATCH
   the shared policy or broadly PUT app settings.
2. **Pending tracks:** integrate/review the exact FINALIZE-UI/profile/V1.1 work
   under their existing ownership, updating imports/generated outputs and
   rerunning the assigned gates on the resulting Sidequest tree.
3. **Next dev update:** use [the dev runner](sidequest-dev.md). Run the full
   gate once at the release candidate, `pnpm sidequest:test`, and
   `pnpm db:generate --check`; review `dev-release.mjs plan` before applying.
   The runner deploys committed exports and excludes the four known foreign
   dirty paths. Do not update the historical staging stack or transplant state.
4. **Retirement:** the three old local crew containers are now stopped and retained.
   The crew owner must reconcile legacy job 131's saved Collect intent before any
   rebroadcast or removal. Continue inventorying old provider workloads and reconcile original
   operation journals, pending transactions, jobs, reservations, deferred
   settlements, owed payments and grants. Then stop/revoke/remove the reviewed
   old provider workloads; preserve dated chain/provider receipts. Full economic
   retirement remains pending. Do not re-enable old workers against the fresh Sidequest keys.
5. **Repository paths:** GitHub renames and the shared origin are verified.
   Physical checkout/worktree/tmux moves still require owner coordination and
   path repair; none has happened. Run `heavy pnpm check` at the committed push
   candidate before publishing local main to the renamed repository.

Fresh contracts and an empty live index establish deployment; they do not
establish paid-work acceptance. Mainnet remains separately gated.

## Coordinator resumption and path handoff — 04:53 UTC

Read-only pane and shared-triage readback now establish explicit acknowledgements
from V1.1 `%13` and profile `%20`. These acknowledgements do not revise the stored
notice receipts: the original operations still have unknown delivery. Explore
`%14` is actively reading this handoff and has held FINALIZE-UI before rebase/S5.

V1.1 owns `fd76d04`: caught-up is judged against the head indexed in that run,
the cron lease is released, and feed work is capped at 100 events per run. Its
scoped indexer tests/typechecks/lint passed. It cancelled the old staging follow-up
and reports no pending economic sends. WS5 integration is parked in `v11` at
`8bc2dc5`, WS7 in `v11-land7` at `c7de03e`; their original builder worktrees and
dirty edits remain retained. Runtime DDL and x402 decisions retain their existing
review gates. Its child builders were told to hold by their owner.

Profile reports a clean `profile` worktree at `1c8b089`, no economic sends or
deployments, and no child agents. It waits for Explore's explicit base-ready;
its temporary SHIM commit must not land.

Sidequest's remaining owned edits are this handoff, `docs/sidequest-dev.md`, the
append-only Sidequest reality/evidence records, and new Privy cutover tooling.
Explore may coordinate FINALIZE-UI rebase/S4 gates/S5 and profile integration
in its own worktrees now; Sidequest has released `apps/explore/**` and will not
cherry-pick their work. Keep the committed evergreen/paper, mint-dark, abstract
mark, `@sidequest/*`, SIDE, and fresh domain/signing/storage identities. Post
reviewed commit ranges and gates before any new dev release.

The [provider inventory](evidence/sidequest-dev/2026-10-06-provider-inventory.json)
retains the three old staging Workers, their D1/R2 and nine old artifact Workers.
The [legacy index audit](evidence/sidequest-dev/2026-10-06-legacy-obligations.json)
finds seven open/active jobs: 81, 59, 58, 48, 45, 44, 40. Index data is not final
contract reconciliation. Keep the old board/indexer recovery reachable and retain
job 131's original intent; no provider deletion or shared policy cutover is safe
from this audit alone.
