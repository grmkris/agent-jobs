import { BoardError, AgentStore, type Sql } from '@sidequest/board'
import type * as sdk from '@sidequest/sdk'
import type { Address } from 'viem'
import { Schema } from 'effect'
import { managedProfileUpdates, profileOperationKey } from './agent-profiles.ts'
import type { AgentRouteRequest } from './routes/agents.ts'
import type { ProfileSummary } from './profiles.ts'
import { MAX_AVATAR_BYTES } from './avatars.ts'

const GenerateInput = Schema.Struct({ prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(600)) })
const TextInput = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  tagline: Schema.optionalKey(Schema.String),
})

export function avatarRouteRequest(input: {
  method: string
  path: string
  contentType: string | undefined
  bytes: Uint8Array
  operationKey?: string
}): AgentRouteRequest | undefined {
  const match = /^\/api\/agents\/([A-Za-z0-9_-]{1,128})\/avatar$/.exec(input.path)
  if (match === null || input.method !== 'POST') return undefined
  if (!input.contentType?.toLowerCase().startsWith('image/') || input.bytes.byteLength > MAX_AVATAR_BYTES)
    throw new BoardError('invalid', 'Avatar uploads require image/* bytes, at most 1 MiB')
  return {
    action: 'avatar',
    id: match[1]!,
    avatarBytes: input.bytes,
    body: input.operationKey === undefined ? {} : { operationKey: profileOperationKey(input.operationKey) },
  }
}

export async function agentProfileManagement(input: {
  request: AgentRouteRequest
  sql: Sql
  context: sdk.Ctx
  operator: Address
  bindings: Record<string, unknown>
  rpcUrl: string
  now: () => number
}): Promise<ProfileSummary> {
  const id = input.request.id ?? ''
  new AgentStore(input.sql, input.now).owned(id, input.operator)
  const { operationKey, ...body } = input.request.body
  const key = operationKey === undefined ? crypto.randomUUID() : profileOperationKey(operationKey)
  const origin = Schema.decodeUnknownSync(Schema.String)(input.bindings.PUBLIC_ORIGIN ?? '')
  const updates = managedProfileUpdates({ ...input, origin, boardId: 'public' })
  if (input.request.action === 'avatar') {
    if (input.request.avatarBytes === undefined) throw new BoardError('invalid', 'Raw avatar bytes are required')
    return updates.upload(id, key, input.request.avatarBytes, 'owner')
  }
  return updates.update(id, key, parseOwnerProfile(input.request.action, body), 'owner')
}

function parseOwnerProfile(action: string, body: Record<string, unknown>) {
  try {
    if (action === 'avatar-generate') {
      const parsed = Schema.decodeUnknownSync(GenerateInput, { onExcessProperty: 'error' })(body)
      return { avatar: { generate: parsed.prompt } }
    }
    return Schema.decodeUnknownSync(TextInput, { onExcessProperty: 'error' })(body)
  } catch {
    throw new BoardError('invalid', 'Invalid profile fields or avatar prompt')
  }
}
