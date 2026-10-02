# G2 plan refusal audit

Source reviewed: `5a2497d`, compared with the 1 Oct release source. This audit did
not run a staging plan, apply, provider mutation or transaction. The coordinator's
refused plan reported two unlabeled blockers; the new diagnostics identify their
resource and binding on the next read-only plan.

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
These are source conclusions; the newly scoped plan must confirm which resource
the coordinator's actual refusal names.

## Binding identity

The exact binding cannot be determined from the unlabeled error. Commit
`94dd107` (B12-002) added comparison of every planned wire identity to the live
census, including noop bindings. That intentional protection can expose an older
mismatch or an unresolved planned identity; it must remain in place.

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

## Minimal proposal for coordinator review

Preserve the already-applied migration input in the desired staging shape. The
smallest source change is restoring the runner's flag to `1`; the existing
unconditional Database/Manifests noop-only checks and provider-action refusal
must stay. Under the pinned provider, an unchanged, already-applied migration
input can then select noop; a changed/new migration still requests an update and
is refused before apply. An additional explicit pin of the existing migration
hash and its applied-state hash is an option if a dedicated replay mode is
preferred.

This proposal is not implemented in this commit: the runner remains in mode `0`.
There is no storage-write exception and no manifest permission for a migration.
The coordinator can review the scoped plan before selecting the correction.

The offline directory fixture's source hashes are refreshed for B10's reviewed
code; its extracted schemas and migration permissions are unchanged.
