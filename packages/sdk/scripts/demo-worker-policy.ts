/** An explicit additive policy migration keeps all signed sends and economic intents intact. */
import { type Address, isAddress } from 'viem'
import { type FlowState, flowJson } from '../src/flow-journal.ts'
import { hashText } from '../src/actions.ts'

export interface DemoBinding {
  chainId: number
  factory: Address
  vault: Address
  core: Address
  identity: Address
  boardUrl: string
  token: Address
  repository: string
}

export function reviewedCreators(input: unknown): Address[] {
  if (!Array.isArray(input) || input.length === 0 || input.some(value => typeof value !== 'string' || !isAddress(value))) {
    throw new Error('Require a nonempty reviewed creator list')
  }
  const creators = input.map(value => value.toLowerCase() as Address)
  if (new Set(creators).size !== creators.length) throw new Error('Duplicate reviewed creator')
  return creators.toSorted()
}

export function demoPolicyBinding(binding: DemoBinding, creators: readonly Address[]): string {
  return hashText(JSON.stringify({ ...binding, creators: reviewedCreators(creators) }))
}

export function originalDemoBinding(binding: DemoBinding, creator: Address): string {
  // Preserve the precise original property order and address spelling for the one-time migration.
  const { chainId, factory, vault, core, identity, boardUrl, token, repository } = binding
  return hashText(JSON.stringify({ chainId, factory, vault, core, identity, boardUrl, creator, token, repository }))
}

export function migrateDemoPolicy(state: FlowState, binding: DemoBinding, originalCreator: Address, next: readonly Address[], at: string): FlowState {
  const saved = state.values['policy/creators']
  const previous = saved === undefined ? [originalCreator] : reviewedCreators(saved)
  const previousBinding = saved === undefined ? originalDemoBinding(binding, originalCreator) : demoPolicyBinding(binding, previous)
  const creators = reviewedCreators(next)
  const nextBinding = demoPolicyBinding(binding, creators)
  if (state.binding === nextBinding) return state
  if (state.binding !== previousBinding) throw new Error('Migration refuses a different deployment or journal binding')
  if (!previous.every(creator => creators.includes(creator.toLowerCase() as Address))) throw new Error('Migration must retain all previously reviewed creators')
  const priorMigrations = state.values['policy/migrations'] ?? []
  if (!Array.isArray(priorMigrations)) throw new Error('Invalid policy migration history')
  const migrated = {
    ...state,
    binding: nextBinding,
    values: {
      ...state.values,
      'policy/creators': creators,
      'policy/migrations': [...priorMigrations, { at, from: state.binding, to: nextBinding, previous, creators }],
    },
  }
  if (flowJson(state.sends) !== flowJson(migrated.sends)) throw new Error('Migration changed saved sends')
  return migrated
}
