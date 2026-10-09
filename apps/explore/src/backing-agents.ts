import { type Address, getAddress, isAddress } from 'viem'

/** An agent the signed-in wallet can back from Account › Backing. */
export interface BackableAgent {
  wallet: Address
  name: string
  agentId: string | null
  /** One of the operator's own agents. */
  yours: boolean
}

/**
 * The agents "Back an agent" offers: the operator's own first (they are the usual reason to come here), then the
 * directory's, each wallet once and never the operator's own wallet, which has its own button.
 */
export function backableAgents(
  owner: string,
  managed: readonly { address: string | null; agent_id: string | null; name: string }[],
  directory: readonly { wallet: string; agentId: string; profile: { name: string } }[],
): BackableAgent[] {
  const seen = new Set([owner.toLowerCase()])
  const out: BackableAgent[] = []
  const add = (wallet: string | null, name: string, agentId: string | null, yours: boolean) => {
    if (wallet === null || !isAddress(wallet, { strict: false }) || seen.has(wallet.toLowerCase())) return
    seen.add(wallet.toLowerCase())
    out.push({
      wallet: getAddress(wallet),
      name: name.trim() || (agentId === null ? 'Agent' : `Agent ID ${agentId}`),
      agentId,
      yours,
    })
  }
  for (const agent of managed) add(agent.address, agent.name, agent.agent_id, true)
  for (const agent of directory) add(agent.wallet, agent.profile.name, agent.agentId, false)
  return out
}
