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

The offline directory fixture's source hashes are refreshed for B10's reviewed
code; its extracted schemas and migration permissions are unchanged.
