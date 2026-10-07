/** Test-only local bucket; production continues to use its existing Manifests resource. */
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { verifyMiningClaim } from '@sidequest/board'
import type { Hex } from 'viem'
import artifact from '../../../packages/board/test/fixtures/mining-epoch.json'
import { miningArtifactKey, r2MiningSource, type EpochBucket } from '../src/mining.ts'

const Manifests = Cloudflare.R2.Bucket('Manifests')
export default class MiningDrill extends Cloudflare.Worker<MiningDrill>()('SidequestMiningLocalDrill', {
  main: import.meta.url, compatibility: { date: '2026-09-01', flags: ['nodejs_compat'] },
}, Effect.gen(function* () {
  const bucket = yield* Cloudflare.R2.ReadWriteBucket(Manifests)
  const env = yield* Cloudflare.WorkerEnvironment
  return { fetch: Effect.gen(function* () {
    yield* HttpServerRequest.HttpServerRequest
    yield* bucket.put(miningArtifactKey('3'), JSON.stringify(artifact))
    const source = r2MiningSource((env as Record<string, unknown>).Manifests as EpochBucket | undefined)
    const file = (yield* Effect.promise(() => source.load('3'))) as typeof artifact
    const account = '0x1111111111111111111111111111111111111111', claim = file.claims[account]!
    const verified = verifyMiningClaim(file.root as Hex, file.epoch, account, claim.amount, claim.proof as Hex[])
    const missing = yield* Effect.promise(() => source.load('4'))
    return HttpServerResponse.jsonUnsafe({ runtime: navigator.userAgent, amount: claim.amount, verified, missing })
  }).pipe(Effect.orDie) }
}).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding))) {}
