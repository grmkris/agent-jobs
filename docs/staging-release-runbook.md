# Staging recovery and release

The October 1 recovery is authorized for **Monad testnet only**, using Alchemy
`2.0.0-beta.79`, Effect `4.0.0-rc.117`, the complete stack, and the existing local
Alchemy state. FI-1 expansion and remote-state migration are deferred. Mainnet is
not authorized. The [September 30 hold](history/staging-release-hold-2026-09-30.md)
is historical evidence, not the current release procedure.

## Release commands

Use Node 24 and pnpm from the canonical checkout, on `main`:

On the build box, the system Node remains v22. Use `pnpm dlx node@24` for each
release command. Verified on 5 October 2026: both the command process and its
`node` child report `v24.21.0`. This does not replace the system executable.
For the live runner, the exact invocations are:

```sh
heavy pnpm dlx node@24 scripts/staging-release/release.mjs plan
heavy pnpm dlx node@24 scripts/staging-release/release.mjs apply <digest-from-plan>
```

Use the same prefix for `scripts/staging-release/guard.mjs` and
`scripts/staging-release/digests.mjs`; their review digests include
`process.version`, so regenerate evidence when changing the Node runtime.
Only the release coordinator runs plan/apply.

```sh
pnpm db:generate --check
heavy pnpm check
heavy pnpm staging:test
heavy pnpm deploy:staging plan
heavy pnpm deploy:staging apply <digest-from-plan>
```

Plan and apply are separate, deliberate operations. The apply command recomputes
its plan and refuses a changed source revision, tree, state digest, live census,
migration digest or operation set. Calling `deploy:staging` without those explicit
arguments retains the offline hold. Never invoke raw `alchemy deploy` to bypass
these checks, use `--adopt`, restore stale state, or remove a failed resource record.
The pinned provider is used programmatically within one Effect scope.

The runner verifies the local state before importing Alchemy, reads Cloudflare
ownership and bindings, checks required credential presence, refuses dirty tracked
source or unknown untracked source, and refuses resource creation, replacement,
deletion, adoption, renamed resources and binding deletion. `.artifact-video/` and
`packages/sdk/scripts/.local/` are preserved local artifacts, excluded from release
source. Deployment credentials come from `.env.local`, taking precedence over
unrelated login-shell credentials. Neither values nor raw provider errors belong
in logs.

A local lock serializes release commands. Private snapshots and sanitized release
journals live in `.alchemy/recovery/`; the copied Alchemy state contains credentials
and must remain private. After an interrupted release, inspect the journal and live
versions before retrying; a lock left by a killed process must be investigated,
not automatically removed.

## Owned infrastructure

Account: `bceaeae4788dce3493514fde194b4a7e`.
Local state: `/home/kristjan/code/agent-jobs/.alchemy/state/AgentJobs/staging`.

| Resource | Existing identity |
| --- | --- |
| API | `agentjobs-api-staging-ba2zqmaom6el4lws` |
| Indexer | `agentjobs-indexer-staging-2unhvhpefxd7n2wb` |
| Explore | `agentjobs-explore-staging-67xgxuclftbgtgxn` |
| D1 | `1b2ddfdd-650e-4846-8b55-fca07872efec` |
| R2 | `agentjobs-manifests-staging-4yyroq65le7dnxbm` |
| Board namespace | `eab5801c233a4d1f952a457050958175` |

Both `hireling.xyz` and `testnet.hireling.xyz` remain on Explore. The apex redirects
to testnet. Indexer retains its `* * * * *` cron. No duplicate stack is a release
or rollback target. Remote state is allowed only for an explicitly configured
production release; a stray `ALCHEMY_REMOTE_STATE=1` fails before state selection.

## Hireling v1 approved changes (since 2 Oct 2026)

The runner keeps the migration input **on** (`AGENT_JOBS_APPLY_MIGRATIONS=1`, D21, 3 Oct 2026). The directory
migration was applied on 1 Oct with this input, so turning it off changes the Database's planned props and the plan
refuses with `storage-write-refused(Database: update)`. With it on, Database and Manifests must still plan as noop: a
new migration file is refused like any other storage write. The directory migration and its bindings are already
live, and the plan must leave them unchanged.

Every refusal names what it refused, by identifier only, for example `binding-identity-drift(Explore.API:
environment)`. The field after the colon is the identity field that differs.

**Still refused, always:** migrations, resource creates/deletes/replacements/adoptions, schedule changes, binding
deletions or type changes, and any new grouped or inherited binding. New v1 tables appear only through runtime
`CREATE TABLE IF NOT EXISTS`, never through a migration.

**What the manifest allows.**
- `scripts/staging-release/approved-changes.json` lists, by name only, the secret additions and rotations, plus the
  single domain change, that the guard may accept. It never contains values.
- The plan pins the manifest's bytes and the digest of its module; `apply` re-reads it and refuses if it changed.
- A secret change not listed in the manifest refuses the plan, and so does a tampered digest.

**Releasing the apex.**
- The only allowed domain change releases `hireling.xyz` from staging Explore, so that production can claim it.
- Set `HIRELING_APEX_REDIRECT=0` in the deploying shell for that release.
- `testnet.hireling.xyz` stays on staging.

**Maintenance.**
- Edits to the manifest are coordinator-reviewed commits.
- After a listed change has landed and been verified, remove its entry in a follow-up commit, so the list never
  becomes a standing permission.
- Rotated values go into `.env.local` only; nothing prints them.

**What the apply digest covers (since 2 Oct 2026, reviews B12-001/002).** The digest also commits to the following, and `apply` recomputes each of them:
- **`payload`:** for each Worker,
  - keyed commitments to every secret, plain-text and JSON value;
  - the resource identities and Worker settings, in clear;
  - the upload's build bytes. For Api and Indexer these come from the provider's own build. Explore's Vite build is built during upload, so it is pinned by the source tree, keyed commitments to every build-time environment input (`AGENT_JOBS_NETWORK`, `PRIVY_APP_ID`, `HIRELING_PROD_PRIVY_APP_ID`, `NODE_ENV`, any `VITE_*`) and Vite's `.env*` files (review B12-003). A source scan in `payload.test.mjs` fails if Explore's build starts reading another variable.
- **`transitions`:** the Durable Object migration and tag change that the provider would derive from the live script tags at upload time. Any class creation, rename, deletion or transfer refuses the plan.
- **Live identities:** every planned binding, noop ones included (for example `DirectoryObject` and `DIRECTORY_DATABASE`), is compared to its live identity. Any drift refuses the plan.

Each Worker's payload and transition are recomputed again inside its reconcile, immediately before upload. A difference stops the release before that upload.

**The commitment key.** `.alchemy/recovery/commitment.key` (32 random bytes, mode 0600) is created on the first `plan`.
- Keep it private and in place.
- Replacing or deleting it changes every digest, so any pending `apply <digest>` is then refused and needs a new `plan`.
- Neither the plan packet nor the journal ever prints a value. They show only the commitments and the key's id.

## Directory migration

`pnpm db:generate` generates `apps/api/migrations/0001_directory_agents.sql` from
the implemented directory schema. Review the generated SQL before applying. The
release runner explicitly enables Alchemy's migration operation; ordinary stack
evaluation does not automatically enable migrations. This adds `directory_agents`
with primary key `(chain_id, registry, audience, agent_key)` and Alchemy's migration
bookkeeping. It does not rebuild, delete or rewrite existing job/session tables.

The API adds the SQLite `DirectoryObject` class and aliases `DIRECTORY_DATABASE`
to the **existing** D1. The DO initializes `directory_state` and
`directory_projection` on use. Existing `Board` state remains untouched. The
legacy `BUDGET_SIGNER_PRIVATE_KEY` binding remains inherited without fetching
its value. `PRIVY_APP_SECRET` now has one source: the reviewed `.env.local`
secret binding. The approved manifest permits overwriting that Worker binding
with the locally authenticated app secret; this does not rotate the Privy-side
secret. Remove that manifest entry after release verification. Normalizing the
existing GitHub PEM's escaped newlines does not change the underlying key.

Cloudflare settings omit the prior migration tag. An isolated live rehearsal with
the same pinned Alchemy provider demonstrated an additive class migration with
that same untagged metadata shape, a same-Worker old-version rollback, and a new
Alchemy deploy with both counters preserved. Do not invent a tag from its absence,
add a class-deletion migration, or claim the rehearsal exercises application logic.
Application directory/admission tests run separately in local workerd.

## Apply and recovery

The full Alchemy graph includes storage and all three Workers. Worker reconciliation
is gated API → successful API/directory readback → Indexer/readback → Explore.
A failed upload or readback stops subsequent Worker updates. Retries are readbacks
only, not repeated uploads. The pre-apply journal records the old active versions,
source/state/migration digests and the plan; successful steps record provider bundle
hashes. Keep the storage migration and any new namespace when rolling back code.

For a failed release, read current settings and deployments for each Worker. Roll
back changed Workers in reverse order using Cloudflare's same-Worker deployments
endpoint and 100% traffic on the old version recorded in the journal:

`POST /accounts/<account>/workers/scripts/<original-name>/deployments`

Body: `{"strategy":"percentage","versions":[{"version_id":"<recorded-old-version>","percentage":100}]}`.

Wait for propagation, then read back versions, health, original Board binding,
domains and Indexer checkpoint. A Cloudflare rollback does not update local Alchemy
state; reconcile the observed version/code before a later deploy. Do not restore
an old state snapshot to hide a partial update or delete D1/DO data. The original
old API intentionally lacks the directory route; rollback therefore restores a 404
there. Subsequent rollout must preserve the newly created namespace and its data.

After success, verify MCP tool enumeration, anonymous mutation refusal, testnet
protocol chain ID 10143, both domains and apex redirect, and two successful
scheduled Indexer observations with checkpoint progress. No wallet transaction,
real alert, enrollment or production-admission proof is implied by those checks.
Only then retire proven-unused duplicates and already-integrated clean worktrees.
