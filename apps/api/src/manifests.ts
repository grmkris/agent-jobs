import * as Cloudflare from 'alchemy/Cloudflare'
import { stageProfile } from '../../../infra/stage.ts'

/**
 * Job manifests and artifacts, content-addressed by keccak256 of their canonical JSON. Public
 * reads are the outage promise (spec §3); `forceDestroy` because every stage's contents are
 * disposable until mainnet.
 */
export const Manifests = Cloudflare.R2.Bucket('Manifests', {
  ...(stageProfile() ? { name: stageProfile()!.resources.Manifests } : {}),
  forceDestroy: false,
})
