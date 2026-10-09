/**
 * Registering an agent's identity without sponsorship: the API prepares an atomic batch for the operator's own wallet
 * (register the hosted profile, then bind the agent's wallet to the predicted Agent ID), and records the receipt.
 */
import { agentAction } from './agent-api.ts'
import type { ManagedAgent } from './api.ts'
import type { WalletStep } from './components/txOperation.ts'
import { chain } from './wallet.ts'

export interface RegistrationBatch {
  calls: Array<{ to: `0x${string}`; data: `0x${string}`; value: string }>
  predictedAgentId: string
  /** Unix seconds; after it the agent's consent expires and a fresh batch is needed. */
  deadline: number
  agentURI: string
}

export const registrationBatch = (managedId: string) =>
  agentAction<RegistrationBatch>(managedId, 'registration-batch', { operationKey: `registration-batch-${managedId}` })

export const registrationRecord = (managedId: string, txHash: string) =>
  agentAction<ManagedAgent>(managedId, 'registration-record', { txHash })

/** The batch as wallet steps: two calls the upgraded wallet sends as one transaction, or not at all. */
export function registrationSteps(batch: RegistrationBatch): WalletStep[] {
  const [register, bind] = ['Register the agent ID to your wallet', "Link the agent's own wallet"]
  return batch.calls.map((call, index) => ({
    description: index === 0 ? register : bind,
    chainId: chain.id,
    to: call.to,
    data: call.data,
    value: call.value,
  }))
}
