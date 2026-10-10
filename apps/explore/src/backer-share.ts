import { BACKER_SHARE_KEY, decodeBackerShare, identityAbi } from '@sidequest/sdk'
import { maxUint256 } from 'viem'
import { useReadContracts } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { data } from './api.ts'
import { chain, deployed, deployment } from './wallet.ts'

export function shareLabel(bps: number): string {
  return bps === 0 ? 'None' : `${bps / 100} %`
}

/** Current metadata preferences for lists; the indexed schedule gives the effective epoch share. Failed reads stay unknown. */
export function useBackerShares(agentIds: readonly string[]) {
  const ids = [...new Set(agentIds)].filter((id) => /^\d{1,78}$/.test(id) && BigInt(id) <= maxUint256)
  const reads = useReadContracts({
    contracts: ids.map(
      (id) =>
        ({
          address: deployment.identity,
          abi: identityAbi,
          functionName: 'getMetadata',
          args: [BigInt(id), BACKER_SHARE_KEY],
          chainId: chain.id,
        }) as const,
    ),
    query: { enabled: deployed && ids.length > 0, refetchInterval: 30_000 },
  })
  const shares = new Map(
    ids.map((id, index) => {
      const read = reads.data?.[index]
      return [id, read?.status === 'success' ? decodeBackerShare(read.result) : null] as const
    }),
  )
  return { ...reads, shares }
}

export interface BackerShareSchedule {
  agentId: string
  current: { bps: number; epoch: number; since: number }
  next: { bps: number; epoch: number }
  pendingCut: { bps: number; appliesFromEpoch: number; at: number } | null
  unstakeDelay: number
  epochSeconds: number
}

export function useBackerShareSchedule(agentId: string | undefined) {
  return useQuery({
    queryKey: ['backer-share-schedule', agentId],
    enabled: deployed && agentId !== undefined && /^[1-9]\d{0,77}$/.test(agentId) && BigInt(agentId) <= maxUint256,
    queryFn: () => data<BackerShareSchedule>(`backer-share/${agentId}`),
    refetchInterval: 30_000,
    retry: false,
  })
}
