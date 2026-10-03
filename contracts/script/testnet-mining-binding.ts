import { createHash } from 'node:crypto'
import type { Deployment } from '../../packages/sdk/src/deployment.ts'
import { flowJson, type FlowState } from '../../packages/sdk/src/flow-journal.ts'

/** SDK block fields are bigint. Bind their exact values without losing precision. */
export function miningBinding(deployment: Deployment, priceInput: string, owner: string, epoch: bigint) {
  const value = epoch === 0n ? { deployment, priceInput, owner } : { deployment, priceInput, owner, epoch: epoch.toString() }
  return createHash('sha256').update(flowJson(value)).digest('hex')
}

/** Never migrate a saved binding implicitly, including any historical epoch-0 journal. */
export function bindMiningState(state: FlowState, binding: string) {
  if (state.binding !== '' && state.binding !== binding) throw new Error('journal deployment, prices or Safe owner differ; reconcile the original operation')
  state.binding = binding
}
