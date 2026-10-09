import { BoardError, type Sql } from '@sidequest/board'
import { AgentProfiles, type AgentProfile } from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { MCP_PROTOCOL_VERSION } from './mcp-metadata.ts'

export interface ProfileSummary {
  agentId: string | null
  name: string
  description: string
  tagline: string
  image: string | null
}

export interface HostedProfile {
  profile: AgentProfile
  agentId: string | null
  registry: string
  chainId: number
}

export interface ProfilesReader {
  registration(agentKey: string): Promise<HostedProfile | null>
  profiles(agentId?: string): Promise<HostedProfile[]>
}

export function profileReader(sql: Sql, now: () => number, deployment: sdk.Deployment): ProfilesReader {
  const store = new AgentProfiles(sql, now)
  const registration = (agentKey: string): HostedProfile | null => {
    const agent = sql.all<{ agent_id: string | null; registry: string; chain_id: number }>(
      'SELECT agent_id,registry,chain_id FROM agents WHERE id=? AND chain_id=? AND registry=?',
      agentKey,
      deployment.chainId,
      deployment.identity.toLowerCase(),
    )[0]
    return agent === undefined
      ? null
      : { profile: store.read(agentKey), agentId: agent.agent_id, registry: agent.registry, chainId: agent.chain_id }
  }
  return {
    registration: async (key) => registration(key),
    profiles: async (agentId) => {
      const rows = sql.all<{ id: string }>(
        `SELECT id FROM agents WHERE chain_id=? AND registry=? AND agent_id IS NOT NULL
         ${agentId === undefined ? '' : 'AND agent_id=?'} ORDER BY created_at,id`,
        deployment.chainId,
        deployment.identity.toLowerCase(),
        ...(agentId === undefined ? [] : [agentId]),
      )
      return rows.flatMap((row) => {
        const found = registration(row.id)
        return found === null ? [] : [found]
      })
    },
  }
}

export function profileOrigin(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new BoardError('invalid', 'Profiles require an HTTPS public origin')
  if (url.username !== '' || url.password !== '') throw new BoardError('invalid', 'Invalid profile origin')
  return url.origin
}

export function profileImage(origin: string, avatarKey: string | null): string | null {
  if (avatarKey === null || !/^avatars\/[0-9a-f]{64}\.(png|jpg|webp)$/.test(avatarKey)) return null
  return `${profileOrigin(origin)}/${avatarKey}`
}

export function profileSummary(origin: string, hosted: HostedProfile): ProfileSummary {
  return {
    agentId: hosted.agentId,
    name: hosted.profile.name,
    description: hosted.profile.description,
    tagline: hosted.profile.tagline,
    image: profileImage(origin, hosted.profile.avatarKey),
  }
}

export interface RegistrationFile {
  type: string
  name: string
  description: string
  image?: string
  services: Array<{ name: string; endpoint: string; version?: string }>
  registrations?: Array<{ agentId: number | string; agentRegistry: string }>
  supportedTrust: string[]
  active: boolean
}

const agentIdValue = (agentId: string): number | string => {
  const value = Number(agentId)
  return Number.isSafeInteger(value) ? value : agentId
}

export function registrationBody(origin: string, hosted: HostedProfile): RegistrationFile {
  const publicOrigin = profileOrigin(origin)
  const image = profileImage(publicOrigin, hosted.profile.avatarKey)
  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: hosted.profile.name,
    description: hosted.profile.description,
    ...(image === null ? {} : { image }),
    services: [
      ...(hosted.agentId === null ? [] : [{ name: 'web', endpoint: `${publicOrigin}/agent/${hosted.agentId}` }]),
      { name: 'MCP', endpoint: `${publicOrigin}/mcp`, version: MCP_PROTOCOL_VERSION },
    ],
    ...(hosted.agentId === null
      ? {}
      : {
          registrations: [
            { agentId: agentIdValue(hosted.agentId), agentRegistry: `eip155:${hosted.chainId}:${hosted.registry}` },
          ],
        }),
    supportedTrust: ['reputation', 'crypto-economic'],
    active: true,
  }
}

export async function registrationResponse(reader: ProfilesReader, origin: string, path: string) {
  const match = /^\/profiles\/([A-Za-z0-9_-]{1,64})\.json$/.exec(path)
  const hosted = match === null ? null : await reader.registration(match[1]!)
  if (hosted === null) return HttpServerResponse.text('not found', { status: 404 })
  return HttpServerResponse.jsonUnsafe(registrationBody(origin, hosted), {
    headers: { 'cache-control': 'public, max-age=60', 'access-control-allow-origin': '*' },
  })
}

export async function profilesResponse(reader: ProfilesReader, origin: string, path: string) {
  const match = /^\/data\/profiles(?:\/([1-9][0-9]{0,77}))?$/.exec(path)
  if (match === null)
    return HttpServerResponse.jsonUnsafe(
      { ok: false, code: 'not-found', message: 'no such data route' },
      { status: 404 },
    )
  try {
    const profiles = await reader.profiles(match[1])
    if (match[1] !== undefined && profiles.length === 0)
      return HttpServerResponse.jsonUnsafe(
        { ok: false, code: 'not-found', message: 'this agent has no hosted profile' },
        { status: 404 },
      )
    return HttpServerResponse.jsonUnsafe({
      ok: true,
      profiles: profiles.map((profile) => profileSummary(origin, profile)),
    })
  } catch {
    return HttpServerResponse.jsonUnsafe(
      { ok: false, code: 'unavailable', message: 'profiles are unavailable' },
      { status: 503 },
    )
  }
}
