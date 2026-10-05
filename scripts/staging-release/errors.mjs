import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'

// Only our own failures cross the public diagnostic boundary. Never render provider errors or Effect causes.
const codes = new Set([
  'census-page-size-invalid', 'census-pagination-metadata-missing', 'census-page-not-advancing',
  'census-total-changed', 'census-page-size-changed', 'census-page-shape-invalid', 'census-total-exceeded',
  'census-page-short', 'census-pagination-limit', 'census-collection-shape-invalid', 'census-collection-count-mismatch',
  'census-bucket-page-size-invalid', 'census-bucket-page-shape-invalid', 'census-bucket-page-not-advancing',
  'census-bucket-pagination-limit', 'census-namespace-identities-invalid', 'census-deployments-empty',
  'census-deployment-timestamp-invalid', 'census-deployment-identities-invalid', 'census-deployment-newest-ambiguous', 'census-deployment-order-invalid',
  'census-deployment-traffic-invalid', 'census-manifests-missing', 'census-storage-identity-drift',
  'census-domain-ownership-drift', 'census-worker-identity-drift', 'census-worker-ownership-drift', 'census-cron-drift',
  'census-binding-drift', 'census-board-namespace-drift', 'census-secret-binding-missing',
  'census-agent-signer-binding-missing', 'census-agent-authority-setting-missing',
  'worker-readback-failed', 'worker-health-invalid', 'worker-runtime-invalid', 'directory-readback-failed',
  'guard-checkout-not-main', 'guard-tracked-changes', 'guard-untracked-source', 'guard-credential-missing', 'guard-debug-env-set',
  'guard-plan-protection-failed', 'guard-resource-action-refused', 'guard-directory-binding-drift',
  'guard-resource-census-invalid', 'guard-native-resource-missing', 'guard-state-mode-drift',
  'guard-manifests-update-refused', 'guard-binding-deletion-refused', 'guard-artifact-store-missing',
  'guard-artifact-build-missing', 'guard-artifact-source-unsupported',
  'guard-apply-digest-mismatch', 'guard-checkout-changed', 'guard-approved-changes-changed', 'guard-live-state-changed',
  'guard-artifact-missing', 'guard-upload-payload-changed', 'guard-do-transition-changed',
  'guard-uploaded-bundle-mismatch', 'guard-post-upload-verification-failed',
])

export class StagingReleaseError extends Error {
  #code
  #logicalId
  constructor(code, logicalId) {
    if (!codes.has(code)) throw new Error('Invalid staging release error code')
    if (logicalId !== undefined && !['Api', 'Indexer', 'Explore'].includes(logicalId)) throw new Error('Invalid staging logical id')
    super(code)
    this.name = 'StagingReleaseError'
    this.#code = code
    this.#logicalId = logicalId
  }
  get code() { return this.#code }
  get logicalId() { return this.#logicalId }
}

/** Preserve our diagnostic across Effect's failure/defect wrapper without printing or traversing provider data. */
export async function runStagingEffect(effect) {
  const result = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(result)) return result.value
  for (const reason of result.cause.reasons) {
    const error = Cause.isFailReason(reason) ? reason.error : Cause.isDieReason(reason) ? reason.defect : undefined
    if (error instanceof StagingReleaseError) throw error
  }
  throw new Error('Staging effect failed')
}

export function reportReleaseFailure(error, print = console.error) {
  if (error instanceof StagingReleaseError) {
    print(`Staging release stopped: ${error.code}${error.logicalId === undefined ? '' : `(${error.logicalId})`}`)
    return
  }
  print('Staging release stopped. Read back Cloudflare versions and the private release journal before retrying.')
}
