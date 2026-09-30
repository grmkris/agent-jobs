# Existing staging release: stop before provisioning

The existing testnet must remain untouched; the coordinator has authorized no live code upload or release. Bounded offline guard, digest and migration-fixture implementation is authorized in this worktree; it does not authorize a whole-stack retry, additive migration, state initialization or provider action.

## Incident and current hold (30 September 2026)

The attempted `pnpm deploy:staging` selected remote Alchemy state but had no gate proving that the selected state owned the existing API, Indexer, Explore, storage and hostnames. It therefore began provisioning duplicate resources. Attachment of the already-bound `hireling.xyz` hostname was the late guard, after creation, not a safe preflight.

`docs/reality-check.md` documents original staging's local `.alchemy` backend due unavailable remote Secrets Store permission. Sanitized filesystem metadata plus Cloudflare GET evidence show main's local `AgentJobs/staging` state maps the original live resources with live providers. Direct remote GET evidence shows cached profile `default` maps the duplicates and records duplicate Explore as `creating`. This establishes a command/documentation/backend-identity mismatch and missing early ownership guard, not the sole historical cause or proof that every remote record was absent before the attempt. Local staging may be authoritative; explicitly verify it in place, never automatically fall back, transplant it to a worktree/remote backend, or force-adopt state. The observed duplicate remote backend is rejected for recovery.

**Do not deploy, bootstrap/resume/upgrade a state store, create resources, delete/retire duplicates, detach domains, alter DNS, sign transactions, or send alerts during this hold.** `alchemy plan` can initialize a state backend, so a dry-run label is not permission to execute it. Keep disabled duplicates, live bindings, domain ownership and the existing Indexer cron unchanged.

## Authoritative observed targets

Account: `bceaeae4788dce3493514fde194b4a7e`. Last assertion-checked GET inventory: 30 September 2026, `20:37:36.698Z`; refresh without mutation before a future release, and stop on drift.

| Target | Existing Worker | Observed rollback version |
|---|---|---|
| API | `agentjobs-api-staging-ba2zqmaom6el4lws` | `a3912838-10bc-47f9-a88f-77049307bdf8` |
| Indexer | `agentjobs-indexer-staging-2unhvhpefxd7n2wb` | `774b3286-3a99-448f-9264-3cc21efc0f98` |
| Explore | `agentjobs-explore-staging-67xgxuclftbgtgxn` | `1994c18e-a72a-4ccc-83a1-4523d0395bf0` |

- Existing D1: `1b2ddfdd-650e-4846-8b55-fca07872efec`; existing manifests R2: `agentjobs-manifests-staging-4yyroq65le7dnxbm`.
- Existing `Board` namespace: `eab5801c233a4d1f952a457050958175`.
- Both `hireling.xyz` and `testnet.hireling.xyz` belong to the existing Explore above, in zone `d4ad1574270cad47f2e33381dba31f84`. Explore's API service binding targets the existing API. Preserve the apex redirect to testnet.
- Existing Indexer schedule: `* * * * *`; no schedules may be enabled on duplicates.
- Excluded duplicate Workers: API `agentjobs-api-staging-wifchnd47xdh3tvm`, Indexer `agentjobs-indexer-staging-eabkbqksbeuef5qk`, Explore `agentjobs-explore-staging-lxl2yyrlxhus2wkt`. They are not update, alias, or rollback targets.

## Mandatory fail-closed preflight

An existing-stack update and first-time provisioning are different procedures. Do not make an update behave like first-time provisioning when state is missing.

1. **Readable, authoritative selected state.** Explicitly select the existing backend and verify `AgentJobs/staging`, account, all five `Api`/`Indexer`/`Explore`/`Database`/`Manifests` identities, live provider mode, ready statuses and hashes/provenance before evaluating a provisioner. Authoritative local staging state at `/home/kristjan/code/agent-jobs/.alchemy/state/AgentJobs/staging` may satisfy this gate when freshly checked against existing Cloudflare identities. State-empty e38/e39 worktrees do not. Missing, denied, empty, mismatched, stale or in-progress state stops; never initialize, copy/transplant, adopt, migrate or switch backends automatically. The observed duplicate remote state fails identity checks regardless of permission.
2. **Remote permission is conditional, production distinct.** If an explicitly reviewed existing remote backend is selected, require direct authenticated GET readability plus independently verified account-scoped **Secrets Store: Edit** policy evidence (permission name/ID, token ID, scope and timestamp only). State GET/token validity is not permission proof. Do not probe secret values, grant permission or bootstrap state. Local staging identity verification does not require remote Secrets Store permission. Production continues to require reviewed remote-state readiness under `docs/mainnet-runbook.md`; it does not authorize migrating this staging backend.
3. **Existing-resource and hostname census.** GET-confirm the exact three Workers, 100%-traffic active versions, shared D1/R2/Board identities, Explore API service binding, both domain owners, aliases and Indexer cron. Preserve secret bindings by name; refuse missing configuration or `unset` replacement values. Refuse a duplicate Worker, duplicate storage/namespace, unexpected alias, changed owner, missing binding or target drift.
4. **Complete non-mutating plan.** Require all existing resources and their IDs, source/tree/payload hashes, bindings/aliases, migrations and state/config changes. Today's allowed changes are NONE. A future explicitly authorized release must refuse every unreviewed create/replace/delete, state migration, hostname/cron/binding change, missing resource or hidden alias conflict. Directory DO/schema/binding additions need a separately approved one-time manifest; without it, the first directory release remains impossible intentionally. No `--adopt`, `--force` or `--yes` may bypass a failed gate; evaluating `alchemy plan` is not an approved no-bootstrap planner.
5. **Exact reviewed revision and recovery.** Pin the intended recovery source to `b6c508e06e7df8b70c2a9ad6de2ef65e5062d610`, tree `9d0774bf19f65bd598ae2769b0aff6fe735751f4`, and record every compiled module/asset digest. e39's selection follow-up is separately committed at `5c3cf6fcf67260261b1bf8ff12aa2c185d28083d`; exclude it from this recovery pin unless the coordinator explicitly selects and reviews a new source/tree manifest. Guard/runbook edits are a separate local change, not an automatic change to the release pin. Require old versions, same-Worker rollback commands, old/new/old compatibility evidence, and live-verification criteria before any upload. A changed source target needs another review and updated manifest, never an implicit move to latest main.

Readable remote state and Secrets Store permission are necessary, not sufficient. Matching IDs, absent class/binding gaps, reviewed migration compatibility and explicit coordinator release authorization remain mandatory.

## Directory migration is an independent blocker

The pinned source requires `DirectoryObject` and `DIRECTORY_DATABASE`; the original live API has neither. `DIRECTORY_DATABASE` must alias the existing D1, never duplicate D1 `2118683d-748c-4987-857e-f933ab756c74`. The directory D1 schema is the additive `directory_agents` table, primary key `(chain_id, registry, audience, agent_key)`, in `apps/api/src/directory.ts`; the canonical DO owns journal/generation/nonce state separately.

No live directory namespace ID or class migration tag is approved. The saved settings responses omit migration tag; this is **unknown prior-tag evidence**, not proof that no migration tag exists. Require an authoritative value or confirmed absence before reviewing the concrete transition and compiled class exports. Creating a namespace conflicts with the current no-new-resource hold. Do not reuse the duplicate namespace or strip directory code from the pinned release. Review the exact namespace, exported class, migration tag, existing-D1 alias, additive schema and old-version compatibility under a separate approval before this can pass.

API/Indexer boot and directory reads can execute lazy database migrations. Post-upload `/health` or directory reads are therefore not a substitute for reviewing those changes, nor are they guaranteed storage-read-only. Rollback must preserve additive namespace/schema/state, not delete it.

## Offline guard, not a release authorization

The owned worktree now has a normal-entrypoint guard at `scripts/staging-release/entrypoint.mjs`. Root `deploy:staging` dispatches directly to this local Node guard and exits nonzero with fixed `live-release-hold`/migration/provider blockers; it does not import Alchemy, spawn a provider command, read state or secrets, or fall back to the old whole-stack command. `deploy:prod` is unchanged and remains governed by the production runbook.

`staging:review` validates only a supplied sanitized packet through the same fail-closed evidence checks. `staging:digests` hashes only declared regular non-symlink module/asset bytes under `scripts/staging-release/review-artifacts/`; it never runs Vite/Alchemy, evaluates modules, reads `.env`, discovers outside files or emits a deployable Worker claim. Both outputs retain `applyAuthorized:false`, `deployCommand:null`, `releaseReady:false` and an offline evidence tier. `staging:test` runs the focused offline suites.

The guard's exact resource manifest still requires the existing API/Indexer/Explore IDs, D1/R2/Board/domain/cron ownership, pinned source/tree, rollback versions, no create/replace/delete/alias/state migration plan and fresh backend-specific evidence. The actual live packet is not release-ready: `DirectoryObject`/`DIRECTORY_DATABASE`, namespace/tag, compiled class/provider artifact and workerd/provider rollback compatibility remain unavailable. Synthetic additive migration and old/new/old SQLite fixtures establish only local test behavior, not permission, state ownership, live migration or rollback proof.

This is an offline implementation only. It does not authorize a deployment, state initialization, migration, namespace/binding change, direct Worker upload, rollback, DNS change, identity/wallet action or cron invocation. The direct-Worker API → readback → Indexer → readback → Explore sequence and reverse-order rollback remain future reviewed protocol targets in this runbook and `RECONCILIATION-PLAN.md`.

## Future release and rollback requirements (not executable or authorized now)

After every gate and coordinator approval: update the exact existing API, verify it, update the exact existing Indexer, verify it, then update Explore last. Compile Alchemy source into tested Cloudflare-ready Worker modules/assets; a direct upload without the required bindings/migrations is not a workaround. Never repeat an uncertain upload without version/traffic readback. Release operations are non-atomic; stop at the first failure.

Record prior active versions, returned new version/deployment IDs and module/asset hashes. Roll back changed Workers only, reverse order, with same-Worker `POST /accounts/<account>/workers/scripts/<existing-name>/deployments` and 100% of traffic on the recorded old version. Namespace/class/schema changes may make old-version rollback unavailable: prove compatibility before apply and keep a reviewed compatible recovery bundle if needed. Do not promise that changing code reverses D1/DO state, restore chain-authoritative rows blindly, or delete objects/tables during rollback.

## Live checks required after an authorized release

- Require immutable source/tree → build/module/asset hashes → upload response/version ID → deployed-content/assets verification; version metadata alone does not prove source provenance, and `/health` has no revision field.
- GET `https://testnet.hireling.xyz/health` is 200 with `ok: true`, `runtime: Cloudflare-Workers`, `network: monad-testnet`, `board: public`. GET `/data/directory` is 200 with `ok: true`, an `agents` array and null/string `nextCursor`, not baseline 404. Current reconciliation does not invoke product GETs, which can initialize storage after an update.
- Protocol information (`POST /api/protocol_info`), MCP initialization/tool enumeration and anonymous-mutator/authenticated refusals are separate future authorized non-GET gates, not current GET-only reconciliation. Protocol must report chain 10143 and reviewed deployment addresses; no wallet activity, signature, funding, enrollment, real alert or Telegram update consumption is implied.
- Both existing domain owners, apex redirect, Explore API/ASSETS bindings, D1/R2/Board/directory identities and cron are unchanged or exactly match the separately approved additive manifest.
- Indexer has at least two scheduled observations in five minutes, successful `lastRun` within 180 seconds, a nondecreasing checkpoint and progress when finalized head advances, and no unexplained increase beyond approved finality/lag policy. Missing RPC/threshold evidence is unavailable, not pass.
- Record timestamps and exact IDs, roll back on failed gates using the pre-reviewed recovery path, and leave status blocked if a migration, rollback or authenticated-live gap remains.

Full incident inventory, exact future upload/rollback protocol targets and e39 review are in the fleet track's `RECONCILIATION-PLAN.md`, `RECONCILIATION-inventory.json`, `RECONCILIATION-remote-state.json`, `RECONCILIATION-preflight.json`, and `../e39-hireling-directory/REVIEW-e38-reconciliation.md`. Do not update those observations to imply that this documentation change deployed code.
