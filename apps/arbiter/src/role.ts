import { Schema } from 'effect'
import type { LocalAccount } from 'viem'
import type { boardClient } from '@sidequest/sdk'

export type Role = 'arbiter' | 'moderator'

export interface RoleArguments {
  readonly role: Role
  readonly once: boolean
}

export function parseRoleArguments(argv: readonly string[]): RoleArguments {
  let role: Role = 'arbiter'
  let once = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--once') once = true
    else if (arg === '--role') {
      const value = argv[index + 1]
      if (value !== 'arbiter' && value !== 'moderator') throw new Error('--role must be arbiter or moderator')
      role = value
      index += 1
    } else if (arg?.startsWith('--')) throw new Error(`unknown option ${arg}`)
  }
  return { role, once }
}

export interface RoleEnvironment {
  readonly privateKey: string
  readonly model: string
  readonly modelBaseUrl: string
  readonly modelApiKey: string
  readonly intervalSeconds: number
  readonly cursorFile?: string
}

const required = (env: NodeJS.ProcessEnv, key: string, fallback?: string): string => {
  const value = env[key] ?? fallback
  if (value === undefined || value === '') throw new Error(`${key} is not set`)
  return value
}

export function roleEnvironment(role: Role, env: NodeJS.ProcessEnv): RoleEnvironment {
  if (role === 'arbiter') {
    return {
      privateKey: required(env, 'V1_ARBITRATOR_PRIVATE_KEY'),
      model: required(env, 'ARBITER_MODEL'),
      modelBaseUrl: required(env, 'ARBITER_MODEL_BASE_URL'),
      modelApiKey: required(env, 'ARBITER_MODEL_API_KEY'),
      intervalSeconds: Number(required(env, 'ARBITER_INTERVAL_SECONDS', '60')),
    }
  }
  return {
    privateKey: required(env, 'MODERATOR_PRIVATE_KEY'),
    model: required(env, 'MODERATOR_MODEL', env.ARBITER_MODEL),
    modelBaseUrl: required(env, 'MODERATOR_MODEL_BASE_URL', env.ARBITER_MODEL_BASE_URL),
    modelApiKey: required(env, 'MODERATOR_MODEL_API_KEY', env.ARBITER_MODEL_API_KEY),
    intervalSeconds: Schema.decodeUnknownSync(Schema.Number.check(Schema.isGreaterThan(0)))(
      Number(required(env, 'MODERATOR_INTERVAL_SECONDS', '15')),
    ),
    cursorFile: required(env, 'MODERATOR_CURSOR_FILE', `${env.HOME ?? '.'}/.sidequest-moderator.cursor`),
  }
}

export interface RoleClient {
  readonly account: LocalAccount
  readonly cursorKey?: string
  readonly board: Pick<ReturnType<typeof boardClient>, 'signIn' | 'call'>
}
