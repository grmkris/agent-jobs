import { miningEpoch, type MiningSource } from '@agent-jobs/board'

export interface EpochBucket { get(key: string): Promise<{ text(): Promise<string> } | null> }
export const miningArtifactKey = (epoch: string) => `mining/epoch-${miningEpoch(epoch)}.json`

/** Reuses the API's existing Manifests R2 binding. There is no write endpoint or new binding. */
export function r2MiningSource(bucket: EpochBucket | undefined): MiningSource {
  return { load: async epoch => {
    if (bucket === undefined) throw new Error('the mining artifact bucket is unavailable')
    const object = await bucket.get(miningArtifactKey(epoch))
    return object === null ? null : JSON.parse(await object.text()) as unknown
  } }
}
