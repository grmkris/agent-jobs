import * as Cloudflare from 'alchemy/Cloudflare'
import devInfrastructure from '../../../infra/dev.json' with { type: 'json' }

/**
 * Job manifests and artifacts, content-addressed by keccak256 of their canonical JSON. Public
 * reads are the outage promise (spec §3); `forceDestroy` because every stage's contents are
 * disposable until mainnet.
 */
export const Manifests = Cloudflare.R2.Bucket('Manifests', {
  ...(process.env.SIDEQUEST_STAGE === 'dev' ? { name: devInfrastructure.resources.Manifests } : {}),
  forceDestroy: false,
})
