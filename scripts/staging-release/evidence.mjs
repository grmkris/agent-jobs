export const expected = {
  accountId: 'bceaeae4788dce3493514fde194b4a7e',
  commit: 'b6c508e06e7df8b70c2a9ad6de2ef65e5062d610',
  tree: '9d0774bf19f65bd598ae2769b0aff6fe735751f4',
  resources: {
    Api: 'agentjobs-api-staging-ba2zqmaom6el4lws',
    Indexer: 'agentjobs-indexer-staging-2unhvhpefxd7n2wb',
    Explore: 'agentjobs-explore-staging-67xgxuclftbgtgxn',
    Database: '1b2ddfdd-650e-4846-8b55-fca07872efec',
    Manifests: 'agentjobs-manifests-staging-4yyroq65le7dnxbm',
  },
  versions: {
    Api: 'a3912838-10bc-47f9-a88f-77049307bdf8',
    Indexer: '774b3286-3a99-448f-9264-3cc21efc0f98',
    Explore: '1994c18e-a72a-4ccc-83a1-4523d0395bf0',
  },
  domains: ['hireling.xyz', 'testnet.hireling.xyz'],
  boardNamespace: 'eab5801c233a4d1f952a457050958175',
  duplicateDirectoryNamespace: 'a4ec9b59cf39484f81e8ecf0c5f3eb9f',
  localStateRoot: '/home/kristjan/code/agent-jobs/.alchemy/state/AgentJobs/staging',
}

export function validateStagingEvidence(bundle, now = Date.now()) {
  const blockers = new Set()
  const requireGate = (condition, code) => { if (!condition) blockers.add(code) }
  const fresh = (stamp) => {
    const observed = typeof stamp === 'string' ? Date.parse(stamp) : NaN
    return Number.isFinite(observed) && now >= observed && now - observed <= 300_000
  }
  const snapshot = bundle?.state
  const permission = snapshot?.permission
  const workers = Array.isArray(bundle?.live?.workers) ? bundle.live.workers : []
  const domains = Array.isArray(bundle?.live?.domains) ? bundle.live.domains : []
  const resources = Array.isArray(snapshot?.resources) ? snapshot.resources : []
  const operations = Array.isArray(bundle?.plan?.operations) ? bundle.plan.operations : []
  const sameBindings = (planned, observed) => {
    if (!planned || !observed || typeof planned !== 'object' || typeof observed !== 'object' || Array.isArray(planned) || Array.isArray(observed)) return false
    const plannedKeys = Object.keys(planned).sort()
    const observedKeys = Object.keys(observed).sort()
    return plannedKeys.length === observedKeys.length && plannedKeys.every((key, index) => key === observedKeys[index] && typeof planned[key] === 'string' && planned[key] === observed[key])
  }

  requireGate(bundle?.schemaVersion === 1, 'schema-version')
  requireGate(bundle?.accountId === expected.accountId, 'account-mismatch')
  requireGate(bundle?.stage === 'staging' && bundle?.network === 'monad-testnet', 'stage-network-mismatch')
  requireGate(bundle?.release?.commit === expected.commit && bundle?.release?.tree === expected.tree, 'unreviewed-revision')
  requireGate(bundle?.release?.clean === true && bundle?.release?.reviewed === true, 'release-review-or-dirty-tree')
  requireGate(bundle?.release?.excludedE39Worktree === true && bundle?.release?.excludedE39Revision === '5c3cf6fcf67260261b1bf8ff12aa2c185d28083d', 'e39-revision-not-isolated')
  const localBackend = snapshot?.backend === 'local'
  const remoteBackend = snapshot?.backend === 'remote'
  requireGate(localBackend || remoteBackend, 'state-backend-unknown')
  requireGate(localBackend ? snapshot?.root === expected.localStateRoot : remoteBackend && snapshot?.profile === 'default', 'state-backend-identity-mismatch')
  requireGate(snapshot?.accountId === expected.accountId && snapshot?.stack === 'AgentJobs' && snapshot?.stage === 'staging', 'state-ownership-mismatch')
  requireGate(snapshot?.readable === true && snapshot?.readStatus === 200 && snapshot?.readMethod === (localBackend ? 'filesystem-read' : 'GET'), 'state-unreadable')
  requireGate(fresh(snapshot?.observedAt) && fresh(bundle?.live?.observedAt) && fresh(bundle?.plan?.observedAt), 'stale-or-future-evidence')
  if (remoteBackend) {
    requireGate(permission?.allowed === true && permission?.name === 'Secrets Store Edit' && permission?.accountId === expected.accountId, 'secrets-store-edit-unverified')
    requireGate(permission?.source === 'token-policy-get' && typeof permission?.tokenId === 'string' && permission.tokenId.length > 0 && fresh(permission?.observedAt), 'permission-evidence-unverified')
  }
  requireGate(snapshot?.bootstrapAttempted === false && bundle?.plan?.stateMigration === false, 'state-bootstrap-or-migration')
  requireGate(resources.length === 5, 'state-resource-census')
  requireGate(operations.length === 5, 'plan-resource-census')
  for (const [logicalId, resourceId] of Object.entries(expected.resources)) {
    const matchingState = resources.filter((resource) => resource?.logicalId === logicalId)
    requireGate(matchingState.length === 1 && matchingState[0]?.resourceId === resourceId && matchingState[0]?.accountId === expected.accountId, 'state-resource-identity-mismatch')
    requireGate(matchingState[0]?.status === 'created' || matchingState[0]?.status === 'updated', 'state-not-ready')
    requireGate(matchingState[0]?.providerMode === 'live', 'state-provider-mode-mismatch')
    if (localBackend) requireGate(/^[a-f0-9]{64}$/.test(matchingState[0]?.sha256 ?? ''), 'local-state-digest-missing')
    const matchingPlan = operations.filter((operation) => operation?.logicalId === logicalId)
    requireGate(matchingPlan.length === 1 && matchingPlan[0]?.resourceId === resourceId, 'plan-resource-identity-mismatch')
    const operation = matchingPlan[0]
    const workerTarget = ['Api', 'Indexer', 'Explore'].includes(logicalId)
    requireGate(workerTarget ? ['update', 'noop'].includes(operation?.action) : operation?.action === 'noop', 'new-replaced-deleted-or-data-resource-write')
    const allowedKeys = workerTarget ? ['logicalId', 'resourceId', 'action', 'bindings', 'aliases'] : ['logicalId', 'resourceId', 'action']
    requireGate(operation !== undefined && Object.keys(operation).every((key) => allowedKeys.includes(key)), 'undeclared-plan-operation')
    if (workerTarget) {
      const liveWorker = workers.find((worker) => worker?.logicalId === logicalId)
      requireGate(sameBindings(operation?.bindings, liveWorker?.bindings), 'planned-binding-drift')
      const aliases = Array.isArray(operation?.aliases) ? operation.aliases : undefined
      const requiredAliases = logicalId === 'Explore' ? expected.domains : []
      requireGate(aliases !== undefined && aliases.length === requiredAliases.length && requiredAliases.every((hostname) => aliases.filter((alias) => alias?.hostname === hostname && alias?.service === expected.resources.Explore).length === 1), 'planned-alias-conflict')
    }
  }
  requireGate(bundle?.plan?.commit === expected.commit && bundle?.plan?.tree === expected.tree, 'plan-revision-mismatch')
  for (const key of ['migrations', 'secretChanges', 'resourceCreates', 'domainChanges', 'scheduleChanges']) {
    requireGate(Array.isArray(bundle?.plan?.[key]) && bundle.plan[key].length === 0, 'unapproved-additive-or-config-change')
  }
  requireGate(workers.length === 3, 'live-worker-census')
  for (const logicalId of ['Api', 'Indexer', 'Explore']) {
    const matching = workers.filter((worker) => worker?.logicalId === logicalId)
    const worker = matching[0]
    requireGate(matching.length === 1 && worker?.resourceId === expected.resources[logicalId] && worker?.accountId === expected.accountId, 'live-worker-identity-mismatch')
    requireGate(worker?.activeVersion === expected.versions[logicalId] && worker?.trafficPercent === 100, 'live-version-or-traffic-drift')
    requireGate(bundle?.rollback?.versions?.[logicalId] === expected.versions[logicalId], 'rollback-version-mismatch')
    requireGate(/^[a-f0-9]{64}$/.test(bundle?.release?.artifactHashes?.[logicalId] ?? ''), 'artifact-digest-missing')
  }
  requireGate(domains.length === 2, 'domain-census')
  for (const hostname of expected.domains) {
    const matching = domains.filter((domain) => domain?.hostname === hostname)
    requireGate(matching.length === 1 && matching[0]?.service === expected.resources.Explore, 'domain-ownership-or-alias-conflict')
  }
  const api = workers.find((worker) => worker?.logicalId === 'Api')
  const indexer = workers.find((worker) => worker?.logicalId === 'Indexer')
  const explore = workers.find((worker) => worker?.logicalId === 'Explore')
  requireGate(api?.bindings?.Database === expected.resources.Database && indexer?.bindings?.Database === expected.resources.Database, 'd1-binding-mismatch')
  requireGate(api?.bindings?.Manifests === expected.resources.Manifests && api?.bindings?.Board === expected.boardNamespace, 'r2-or-board-binding-mismatch')
  requireGate(explore?.bindings?.API === expected.resources.Api && indexer?.cron === '* * * * *', 'service-binding-or-cron-mismatch')
  const directoryId = api?.bindings?.DirectoryObject
  requireGate(typeof directoryId === 'string' && /^[a-f0-9]{32}$/.test(directoryId) && directoryId !== expected.duplicateDirectoryNamespace, 'directory-namespace-missing-or-duplicate')
  requireGate(api?.bindings?.DIRECTORY_DATABASE === expected.resources.Database, 'directory-d1-alias-missing-or-wrong')
  requireGate(bundle?.rollback?.reviewed === true && bundle?.rollback?.storageCompatible === true, 'rollback-compatibility-unverified')
  requireGate(bundle?.liveChecks?.health === true && bundle?.liveChecks?.protocolChainId === 10143 && bundle?.liveChecks?.directory === true && bundle?.liveChecks?.domainOwner === true, 'live-check-contract-incomplete')
  requireGate(bundle?.liveChecks?.indexerMaxAgeSeconds === 180 && bundle?.liveChecks?.requireCheckpointProgress === true, 'indexer-check-contract-incomplete')
  return { ok: blockers.size === 0, applyAuthorized: false, blockers: [...blockers] }
}
