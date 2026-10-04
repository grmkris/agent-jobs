import * as sdk from '@agent-jobs/sdk'
import type { Address } from 'viem'
import type { TxRequest } from './api.ts'
import type { Approval } from './fleet.ts'

export interface FrozenOperation {
  tool: string
  args: Record<string, unknown>
  result: {
    taskId?: string
    operationId?: string
    nonce?: string
    sign?: { description: string; typedData: string }
    transactions?: TxRequest[]
  }
  boardId: string
  from: string
  chainId: number
}

/** Expiry stops fresh prompts; receipt reconciliation never calls this guard. */
export function approvalSendError(expiresAt: number, now = Date.now() / 1000): string | null {
  return expiresAt <= now ? 'This approval expired before the wallet step started. Ask your agent for a fresh request.' : null
}

/** A malformed or different-chain transaction never reaches the wallet. */
export function frozenTransactions(value: unknown, chainId: number): TxRequest[] {
  if (!Array.isArray(value)) throw new Error('The frozen operation has no transaction list.')
  return value.map((entry: unknown) => {
    if (entry === null || typeof entry !== 'object') throw new Error('Invalid frozen transaction.')
    const tx = entry as Record<string, unknown>
    if (
      tx.chainId !== chainId ||
      typeof tx.description !== 'string' ||
      typeof tx.to !== 'string' ||
      !/^0x[0-9a-f]{40}$/i.test(tx.to) ||
      typeof tx.data !== 'string' ||
      !/^0x(?:[0-9a-f]{2})*$/i.test(tx.data) ||
      tx.value !== '0'
    )
      throw new Error('A frozen transaction has a different chain, target, calldata, or value. Nothing was sent.')
    return entry as TxRequest
  })
}

export function frozenOperation(approval: Approval): FrozenOperation {
  const { tool, args, result, boardId, from, chainId } = approval.payload
  if (
    typeof tool !== 'string' ||
    args === null ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    result === null ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    typeof boardId !== 'string' ||
    typeof from !== 'string' ||
    !/^0x[0-9a-f]{40}$/i.test(from) ||
    typeof chainId !== 'number'
  )
    throw new Error('This approval has no executable frozen operation.')
  return {
    tool,
    args: args as Record<string, unknown>,
    result: result as FrozenOperation['result'],
    boardId,
    from,
    chainId,
  }
}

export function signatureFollowup(operation: FrozenOperation, signature: string): { tool: string; args: Record<string, unknown> } {
  if (typeof operation.args.taskId !== 'string') throw new Error('The signed operation has no task id.')
  if (operation.tool === 'select_worker' && typeof operation.result.nonce === 'string')
    return {
      tool: 'submit_selection',
      args: { taskId: operation.args.taskId, nonce: operation.result.nonce, signature },
    }
  if (operation.tool === 'prepare_activation')
    return {
      tool: 'build_activation',
      args: { taskId: operation.args.taskId, budgetSignature: signature },
    }
  throw new Error('This signature is not a supported selection or activation request.')
}

/** Freeze the board-independent caller before a prompt; changing wallets never reuses an approval. */
export function approvalSigner(expected: string, actual: string | undefined, chainId: number, actualChainId: number | undefined): void {
  if (expected.toLowerCase() !== actual?.toLowerCase() || chainId !== actualChainId)
    throw new Error('Select this agent wallet on the correct network before signing.')
}

/** Only the contract-defined selection and budget schemas are signed through this page. */
export function approvalTypedData(operation: FrozenOperation, deployment: sdk.Deployment, now = Date.now() / 1000): string {
  const json = operation.result.sign?.typedData
  if (typeof json !== 'string') throw new Error('This operation has no typed signature request.')
  const typed = JSON.parse(json) as {
    domain?: { name?: unknown; version?: unknown; chainId?: unknown; verifyingContract?: unknown }
    types?: Record<string, unknown>
    primaryType?: unknown
    message?: Record<string, unknown>
  }
  const domain = typed.domain
  const message = typed.message
  const selection = operation.tool === 'select_worker'
  const activation = operation.tool === 'prepare_activation'
  if ((!selection && !activation) || domain === undefined || message === undefined || typed.types === undefined)
    throw new Error('This typed signature is not a supported Hireling selection or activation.')
  const type = selection ? 'Selection' : 'SetBudgetAuthorization'
  const fields = selection ? sdk.selectionTypes.Selection : sdk.setBudgetTypes.SetBudgetAuthorization
  const contract = typeof domain.verifyingContract === 'string' ? domain.verifyingContract : ''
  const configuredHolding = Object.values({
    ...deployment.legacyStacks,
    ...deployment.stacks,
  }).some((stack) => stack?.holding.toLowerCase() === contract.toLowerCase())
  const expectedDomain = selection ? sdk.holdingDomain(deployment.chainId, contract as Address) : sdk.coreDomain(deployment.chainId, deployment.core)
  if (
    operation.chainId !== deployment.chainId ||
    Number(domain.chainId) !== deployment.chainId ||
    domain.name !== expectedDomain.name ||
    domain.version !== expectedDomain.version ||
    (selection ? !configuredHolding : contract.toLowerCase() !== deployment.core.toLowerCase())
  )
    throw new Error('The signature domain is not a configured Hireling contract on this network.')
  if (
    typed.primaryType !== type ||
    JSON.stringify(typed.types[type]) !== JSON.stringify(fields) ||
    Object.keys(typed.types).some((key) => key !== type && key !== 'EIP712Domain')
  )
    throw new Error('The typed signature schema differs from the Hireling contract.')
  if (Object.keys(message).length !== fields.length || !fields.every((field) => Object.hasOwn(message, field.name)))
    throw new Error('The typed signature message has missing or extra fields.')
  for (const field of fields) {
    const value = message[field.name]
    if (field.type === 'address' && (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value))) throw new Error('Invalid address in the frozen signature.')
    if (field.type === 'bytes32' && (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value))) throw new Error('Invalid hash in the frozen signature.')
    if (field.type.startsWith('uint')) {
      if (
        (typeof value !== 'string' && typeof value !== 'number') ||
        !/^\d+$/.test(String(value)) ||
        BigInt(String(value)) >= 2n ** BigInt(field.type.slice(4))
      )
        throw new Error('Invalid integer in the frozen signature.')
    }
  }
  if (selection && String(message.nonce) !== operation.result.nonce) throw new Error('The frozen selection nonce changed.')
  if (activation && (String(message.signer).toLowerCase() !== operation.from.toLowerCase() || message.optParamsHash !== sdk.EMPTY_HASH))
    throw new Error('The budget authorizes a different signer or hook parameters.')
  if (Number(message[selection ? 'activateBy' : 'deadline']) <= now)
    throw new Error('This signature request expired. Ask your agent to prepare a fresh request.')
  return json
}
