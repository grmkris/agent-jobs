import type { DirectoryKind } from '@sidequest/sdk'
import { enforceHostedRate, type AdmissionReply } from './admission-rate.ts'
import type { DirectoryCall } from './directory-object.ts'

const methods: Record<DirectoryKind, [string, string]> = {
  Enrollment: ['prepare_directory_enrollment', 'enroll_directory'],
  ServiceAd: ['prepare_service_ad', 'publish_service_ad'],
  Heartbeat: ['prepare_heartbeat', 'post_heartbeat'],
  RevokeAd: ['prepare_revoke_service_ad', 'revoke_service_ad'],
}

/** Derive the rate tool from the operation; callers cannot label a write as a public read. */
export async function directoryAdmission(bindings: Record<string, unknown>, request: DirectoryCall): Promise<Exclude<AdmissionReply, { ok: true }> | undefined> {
  if (bindings.NETWORK !== request.network) return { ok: false, code: 'forbidden', message: 'directory runtime network mismatch' }
  if (request.action === 'read' || (request.network !== 'monad-mainnet' && bindings.DEPLOY_STAGE !== 'prod')) return undefined
  const kind = request.action === 'prepare' ? request.kind : (request.record as { kind?: DirectoryKind } | undefined)?.kind
  if ((request.action !== 'prepare' && request.action !== 'submit') || kind === undefined || !Object.hasOwn(methods, kind)) return { ok: false, code: 'invalid', message: 'unknown directory action or signed kind' }
  const auth = request.admission
  const result = await enforceHostedRate(bindings, { ...auth, network: request.network,
    boardId: auth?.boardId ?? 'public', tool: methods[kind][request.action === 'prepare' ? 0 : 1] })
  return result.ok ? undefined : result
}
