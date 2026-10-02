import * as Effect from 'effect/Effect'
import { ArtifactStore, Artifacts, cached, makeScopedArtifacts } from 'alchemy/Artifacts'
import { nativeResource } from './live-plan.mjs'
import { StagingReleaseError } from './errors.mjs'
import { artifactOf, readViteEnvFiles, viteArtifact } from './payload.mjs'

// These pinned provider internals are files, while alchemy's Cloudflare/* export maps only directories.
// Resolve beside its public Artifacts module so Node and Bun use the same installed provider and module flavor.
const artifactsModule = import.meta.resolve('alchemy/Artifacts')
const extension = artifactsModule.endsWith('.ts') ? '.ts' : '.js'
const { getCompatibility } = await import(new URL(`Cloudflare/Workers/Compatibility${extension}`, artifactsModule).href)
const { WorkerBundle } = await import(new URL(`Cloudflare/Workers/Sources/Rolldown${extension}`, artifactsModule).href)

/** The pinned provider's prepareBundle rolldown arm, using its builder, options and cached("build") bag. */
export const providerBundle = (id, props) => Effect.gen(function* () {
  const bundler = yield* WorkerBundle
  return yield* bundler.build({
    id, main: props.main, compatibility: getCompatibility(props),
    entry: props.isExternal ? { kind: 'external' } : { kind: 'effect', exports: props.exports ?? {} },
    stack: { name: 'AgentJobs', stage: 'staging' }, extraOptions: props.build,
  })
}).pipe(cached('build'))

/** Require bytes in the exact bag apply uses; do not substitute another FQN or another artifact key. */
export function* storedBundle(store, fqn, logicalId) {
  const entry = store.get(fqn)
  if (entry === undefined) throw new StagingReleaseError('guard-artifact-store-missing', logicalId)
  let build = entry.get('build')
  if (Effect.isEffect(build)) build = yield* build
  if (build === undefined) throw new StagingReleaseError('guard-artifact-build-missing', logicalId)
  return build
}

/**
 * Build Api/Indexer before digesting, even if diff short-circuited on metadata, crons, domains or legacy IDs.
 * Plan and apply share this store and scope each bag by the native resource FQN. Explore's Vite path retains the
 * reviewed source-tree + build-env + env-file pin and its immediate pre-upload reread (B12-003/SEC-004).
 */
export function* prepareArtifacts(snapshot, key, { exploreDir, env = process.env }) {
  const store = yield* Effect.gen(function* () { return yield* ArtifactStore }).pipe(Effect.provide(snapshot.session.context))
  const artifacts = {}
  for (const id of ['Api', 'Indexer', 'Explore']) {
    const node = nativeResource(snapshot, id)
    const props = node.props ?? node.state?.props ?? {}
    if (node.action === 'noop') { artifacts[id] = { kind: 'unchanged' }; continue }
    if (id === 'Explore' && props.vite) {
      artifacts[id] = viteArtifact(key, id, env, readViteEnvFiles(exploreDir))
      continue
    }
    // Only the stack's default rolldown bundle arm is handled here. Changed source kinds must be reviewed.
    if (props.source || props.script !== undefined || props.vite || !props.main || props.bundle === false || /\.py$/i.test(props.main))
      throw new StagingReleaseError('guard-artifact-source-unsupported', id)
    const fqn = node.resource.FQN
    if (store.get(fqn)?.get('build') === undefined) {
      yield* providerBundle(id, props).pipe(
        Effect.provideService(Artifacts, makeScopedArtifacts(store, fqn)),
        Effect.provide(snapshot.session.context),
      )
    }
    const build = yield* storedBundle(store, fqn, id)
    artifacts[id] = yield* Effect.promise(() => artifactOf(build))
  }
  return artifacts
}
