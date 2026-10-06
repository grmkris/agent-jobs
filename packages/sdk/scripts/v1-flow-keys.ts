/** The testnet v1 signer follows the Holding recipe; roles.arbitrator belongs to the legacy pairs. */
import { type Hex, isAddress, zeroAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

function account(name: string, key: string | undefined) {
  if (!key) throw new Error(`${name} is not set (.env.local)`)
  if (!/^0x[\da-fA-F]{64}$/.test(key)) throw new Error(`${name} is invalid`)
  try { return privateKeyToAccount(key as Hex) }
  catch { throw new Error(`${name} is invalid`) }
}

export function v1FlowArbitrators(config: { sidequest: { defaultArbitrator: string } }, env: NodeJS.ProcessEnv) {
  const v1 = account('V1_ARBITRATOR_PRIVATE_KEY', env.V1_ARBITRATOR_PRIVATE_KEY || env.ARBITRATOR_PRIVATE_KEY)
  const expected = config.sidequest.defaultArbitrator
  if (!isAddress(expected) || expected === zeroAddress || v1.address.toLowerCase() !== expected.toLowerCase())
    throw new Error('v1 arbitrator key does not match sidequest.defaultArbitrator')
  const legacyKey = env.LEGACY_ARBITRATOR_PRIVATE_KEY || env.ARBITRATOR_PRIVATE_KEY
  const legacy = legacyKey ? account(env.LEGACY_ARBITRATOR_PRIVATE_KEY ? 'LEGACY_ARBITRATOR_PRIVATE_KEY' : 'ARBITRATOR_PRIVATE_KEY', legacyKey) : undefined
  return { v1, legacy }
}
