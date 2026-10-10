import type { DirectoryAgent } from '@sidequest/sdk'
import { type Address, getAddress, isAddress } from 'viem'

/** An agent the signed-in wallet can back from Account › Backing. */
export interface BackableAgent {
  wallet: Address
  name: string
  agentId: string | null
  /** One of the operator's own agents. */
  yours: boolean
  /** What the directory says about it being around, when it is listed. */
  presence?: Pick<DirectoryAgent, 'presence' | 'activity'>
}

/**
 * The agents "Back an agent" offers: the operator's own first (they are the usual reason to come here), then the
 * directory's, each wallet once and never the operator's own wallet, which posting a job backs by itself.
 */
export function backableAgents(
  owner: string,
  managed: readonly { address: string | null; agent_id: string | null; name: string }[],
  directory: readonly ({ wallet: string; agentId: string; profile: { name: string } } & Partial<
    Pick<DirectoryAgent, 'presence' | 'activity'>
  >)[],
): BackableAgent[] {
  const seen = new Set([owner.toLowerCase()])
  const out: BackableAgent[] = []
  const add = (
    wallet: string | null,
    name: string,
    agentId: string | null,
    yours: boolean,
    presence?: BackableAgent['presence'],
  ) => {
    if (wallet === null || !isAddress(wallet, { strict: false }) || seen.has(wallet.toLowerCase())) return
    seen.add(wallet.toLowerCase())
    out.push({
      wallet: getAddress(wallet),
      name: name.trim() || (agentId === null ? 'Agent' : `Agent ID ${agentId}`),
      agentId,
      yours,
      ...(presence === undefined ? {} : { presence }),
    })
  }
  for (const agent of managed) add(agent.address, agent.name, agent.agent_id, true)
  for (const agent of directory)
    add(
      agent.wallet,
      agent.profile.name,
      agent.agentId,
      false,
      agent.presence === undefined
        ? undefined
        : { presence: agent.presence, ...(agent.activity === undefined ? {} : { activity: agent.activity }) },
    )
  return out
}
