# G2 plan refusal audit

Source reviewed: `5a2497d` and `0e09210`, compared with the 1 Oct applied revision
`d6ccc5b` recorded in `docs/staging-release-2026-10-01.md`. Backend did not run a
staging plan, apply, provider mutation or transaction. The coordinator's scoped
rerun at `0e09210` confirmed `Database: update`, `Api.DirectoryObject` and
`Explore.API`; D21 authorizes the migration-input correction and field diagnostics.

## Storage: Database migration input

The strongest source explanation is `Database: update`, caused by B12 commit
`953159c` (`feat(staging): approve reviewed v1 changes`). It changed the release
preflight's `AGENT_JOBS_APPLY_MIGRATIONS` from `1` to `0`.

The 1 Oct declaration introduced by `cb8c24e` supplies `migrations` only when that
flag is `1`. The 1 Oct release used `1`, so its saved desired props include that
input. The next release now requests props without it. In the pinned Alchemy
provider, `Cloudflare/D1/Database.ts` returns an undefined diff when no migration
input or other explicit change is present. `Plan.ts` then falls back to
`havePropsChanged(oldProps, news)`: removing the input requests an update. The
offline regression reproduces that fallback and confirms the storage guard
refuses it.

Disabling further migrations was intentional; the resulting storage update was
unintended. The `Database` declaration has not changed since `cb8c24e`.
`Manifests` has not changed since `1e3102c` (30 Sep), including its staging
`forceDestroy` setting. No intervening Alchemy dependency change explains it.
The coordinator's scoped rerun confirms the actual storage refusal is Database.

## Binding identity

Commit `94dd107` (B12-002) added comparison of every planned wire identity to the
live census, including noop bindings. That intentional protection can expose an
older mismatch or an unresolved planned identity; it remains in place.

The 1 Oct applied shape, from `git show d6ccc5b:alchemy.run.ts` and its Api/DO
declarations, is unchanged in the relevant fields:

- Api exports the self-hosted `DirectoryObject`, with no explicit namespace ID,
  script name or environment. The provider supplies the class name and omits the
  host script for a local binding. Existing blank-script normalization already
  treats that as Api. The namespace census introduced in `94dd107` fetches the
  account's namespace list once and filters it by hosted script; it does not read
  pagination metadata or subsequent pages. A missing page or unexpected census
  field shape can therefore cause `namespaceList` drift without a changed
  binding. A different class, explicit script, environment or namespace ID still
  refuses; those are not justified by a source change.
- Explore uses `env: { API: api, ... }`, which creates a service binding to the
  existing Api Worker without an explicit environment or entrypoint. Cloudflare
  may return an explicit default for either omitted field. Existing comparison
  equates missing/null/empty, but does not equate any nonempty default string to
  omission. A field label distinguishes `environment`/`entrypoint` defaults from
  a different `service` target. This commit does not normalize those defaults.

The next coordinator plan names all differing fields (names only). Backend has
not read live values, so paging/defaults are hypotheses, not confirmed causes.

The suggested v1 candidates did not change infrastructure identity:

- B8b `e7b42e4` adds runtime reads from the existing `Manifests` binding, without
  changing the bucket declaration or binding.
- B10 `da9c5dc` canonicalizes instance names within the existing `DirectoryObject`
  namespace; the class, logical resource and binding names remain unchanged.
- B9 `d1b9448` adds runtime Telegram tables/outbox and approved secrets, without
  changing Database props, namespaces or the indexer cron.
- B6 `687db33` uses a reserved sponsorship instance in the existing Board
  namespace, without adding a namespace or binding.

Do not attribute the binding drift to any of these without the scoped result.
No identity exception or approved binding change is proposed.

## D21 correction

The runner restores `AGENT_JOBS_APPLY_MIGRATIONS=1` as D21 authorizes. The
unconditional Database/Manifests noop-only checks, provider-action refusal and
every-wire identity comparisons remain. The regression hashes real SQL files
with the pinned D1 migration detector: unchanged applied input is noop; adding a
new migration requests an update and is refused. No migration is executed.

There is no storage-write or binding exception, and no manifest permission for a
migration. The coordinator reruns the read-only plan; neither binding drift is
considered resolved until its field and live meaning are explained.

## D21 follow-up: G2-PLAN-3

The coordinator's read-only probe at `db78e88` confirmed both causes: the account
has 41 namespaces over 20-item pages without `total_pages`, and DirectoryObject
is on a later page; Explore.API's live environment is the platform default
`production` while its desired environment is omitted.

The namespace reader now keeps the response envelope and traverses pages until
`total_count` is covered. Missing/changed totals, mismatched counts, wrong page
numbers, changed page sizes, duplicate identities, overfull pages and short pages before the end all refuse. It filters
for the three staging hosts only after reading the complete account list.

Only service-binding environment comparison normalizes missing/null/empty to
`production` on both sides. Explicit staging still differs from production, and
entrypoint, DO environment and every other comparison retain their prior rules.

The list-read audit covers all release-helper reads and their pinned provider
contracts:

| Endpoint | Contract and handling |
| --- | --- |
| Account Durable Object namespaces | Page/total_count traversal, fixed in this WP. Provider upload already uses `listNamespaces.items()` to traverse namespaces. |
| Account Workers domains | Corrected by STAGING-GUARD-G2-001: the pinned API is paginated, so the census uses fail-closed page/total_count traversal before filtering Hireling domains. Missing metadata refuses. |
| R2 buckets | Supports `per_page` and lexicographic `start_after`, without a response continuation token/count. The runner now traverses sorted full pages until a short page, refusing malformed/repeated pages. This matches the pinned Bucket provider's exhaustive walk. |
| Worker deployments | The live API is paginated despite the pinned schema: G2-PLAN-4 traverses page/total_count, checks every created_on, and proves page 1's first row is the unique newest in descending order. It requires one 100% version. |
| Worker schedules | Live responses have no result_info; the complete per-script collection is shape-checked, with any returned total_count checked. |
| Worker secrets | The runner reads names/types from the per-script settings binding collection, never a separate secrets list or secret values. The secrets-list API is single-collection mode if used by a provider. |
| Zone Worker routes | No runner list read; the selected stack declares no routes. The pinned route-list API is a complete collection without page parameters. |
| D1 databases | The runner addresses the owned database by its exact ID; no database list. Storage is noop-only, so database reconciliation/listing never runs in an accepted apply. |
| R2 domain/lifecycle lists | Storage is noop-only; no bucket reconciliation runs in an accepted apply. |

Fake-API regressions put DirectoryObject on page 3 with no total_pages, and
verify incomplete totals/pages refuse. R2 tests cover later-page discovery and
repeated-page refusal. No provider call, staging plan or apply ran in backend.

The offline directory fixture's source hashes are refreshed for B10's reviewed
code; its extracted schemas and migration permissions are unchanged.


## G2-PLAN-4: deployment history and safe diagnostics

The coordinator's counts-only probe corrected the pinned API contract: deployments
return 10 per page (Api 39, Indexer 18, Explore 42), with total_count/total_pages.
Domains returned all 11 rows and schedules had no result_info. The runner now
exhausts deployment pages using the same fail-closed pagination checks. It validates
all created_on timestamps, rejects a tied newest timestamp, and requires descending
order with the unique newest at page 1's first row before accepting one 100% version.

Census checks and release guard failures now use StagingReleaseError with a fixed,
value-free code allowlist. The release catch renders only those codes; arbitrary
errors, including provider failures, remain generic. Effect failures preserve our
own codes without printing raw causes. Contextual plan blocker labels keep their
existing field/name/action sanitizers and all prior refusals remain enforced.

## G2-PLAN-5: provider artifact cache and guard diagnostics

The coordinator's rerun reached `prepareArtifacts` after census and plan
protections. The previous guard treated every missing `build` entry as one
condition, so it could not distinguish a missing resource bag from a provider
cache that had not been populated. The guard now reports only
`guard-artifact-store-missing(Api|Indexer|Explore)` or
`guard-artifact-build-missing(Api|Indexer|Explore)`, using the fixed worker
logical-id allowlist; it never includes an FQN, path, digest or provider value.

The pinned Alchemy source (`node_modules/alchemy`, 2.0.0-beta.79) puts the
default Worker bundle in the resource-scoped `Artifacts.cached("build")` bag in
`WorkerProvider.prepareBundle`. Both `Plan.providePlanScope` and
`Apply.provideLifecycleScope` create that bag from the resource FQN, and the
Alchemy session supplies one root `ArtifactStore` to both phases. The builder's
options are `id`, `main`, `getCompatibility(props)`, an external or Effect
entry, the AgentJobs stack/stage, and `props.build`.

`WorkerProvider.diff` can return before `hasChanged` or bundle preparation for
metadata, domains, routes, crons, or legacy-id changes. That means a forced diff
is not a reliable way to make the cache. `prepareArtifacts` now invokes the
same pinned Rolldown `WorkerBundle.build` with the same options and the exact
native resource FQN scope whenever Api or Indexer has no cached build. It then
reads that FQN's `build` value, resolves the provider's in-flight Effect when
needed, and hashes the exact file bytes that Apply will upload. Unsupported
source/script/prebuilt/Python arms refuse closed rather than bypassing the
digest pin. Explore remains on its accepted Vite source-tree/build-env/env-file
pin path because the provider's Vite build is produced during reconcile and is
not stored under `build`; the pre-upload reread remains mandatory.

Tests use the provider-shaped FQN bag and `cached("build")`, prove an uncached
default bundle is reused after the source changes, resolve an in-flight cached
Effect, exercise both diagnostic labels, refuse unreadable bytes and unsupported
source arms, and retain the Explore Vite pin. No staging plan or apply ran in
backend.

STAGING-GUARD-G2-001 corrects the earlier domain-list audit conclusion: the
pinned Workers `listDomains` is a paginated operation. The census now exhausts
its pages before filtering Hireling's two domains and requires pagination
metadata. Regressions find a target on page 3 and refuse missing/changed totals.

STAGING-GUARD-G2-002 requires a nonempty unique deployment id across all pages
and strictly decreasing timestamps, including older equal timestamps. Regressions
cover a duplicate id on a later page, missing ids and equal older timestamps
across a page boundary; newest uniqueness and one-version/100% checks remain.
