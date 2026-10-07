import { isAddress, isHex } from 'viem'

export interface SignedSelectionRecord {
  nonce: string
  application_id: string
  worker: string
  agent_id: string
  activate_by: number
  signature: string | null
  created_at: number
  application_worker: string | null
  application_agent_id: string | null
}

export interface SelectionChainState {
  status: string
  provider: string | null
  listingMatchesOffer: boolean | null
}

type CreatorSelectionState = 'signed' | 'expired' | 'invalid' | 'unavailable'

export interface CreatorSelection {
  state: CreatorSelectionState
  applicationId: string
  agentId: string
  activateBy: number
}

function matchesApplication(row: SignedSelectionRecord): boolean {
  return (
    row.application_worker !== null &&
    row.application_agent_id !== null &&
    row.application_worker.toLowerCase() === row.worker.toLowerCase() &&
    row.application_agent_id === row.agent_id
  )
}

export async function creatorSelectionProjection(
  rows: readonly SignedSelectionRecord[],
  chain: SelectionChainState,
  now: number,
  deliveryDeadline: number,
  verify: (selection: SignedSelectionRecord) => Promise<boolean>,
): Promise<CreatorSelection[]> {
  if (chain.status !== 'open' && chain.status !== 'lapsed') return []
  return Promise.all(
    rows
      .filter((row) => row.signature !== null)
      .toSorted((left, right) => right.created_at - left.created_at)
      .map(async (selection): Promise<CreatorSelection> => {
        const base = {
          applicationId: selection.application_id,
          agentId: selection.agent_id,
          activateBy: selection.activate_by,
        }
        if (
          !matchesApplication(selection) ||
          !isAddress(selection.worker) ||
          !/^[1-9]\d*$/.test(selection.agent_id) ||
          !/^\d+$/.test(selection.nonce) ||
          !isHex(selection.signature) ||
          selection.signature === '0x' ||
          !Number.isSafeInteger(selection.activate_by) ||
          selection.activate_by >= deliveryDeadline ||
          chain.listingMatchesOffer !== true ||
          chain.provider !== null
        )
          return { ...base, state: 'invalid' }
        if (selection.activate_by < now || deliveryDeadline < now) return { ...base, state: 'expired' }
        try {
          return { ...base, state: (await verify(selection)) ? 'signed' : 'invalid' }
        } catch {
          return { ...base, state: 'unavailable' }
        }
      }),
  )
}
