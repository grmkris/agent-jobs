import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { AgentProfiles, AgentStore, fromNodeSqlite } from '@sidequest/board'
import * as sdk from '@sidequest/sdk'
import {
  profileReader,
  profileSummary,
  profilesResponse,
  registrationBody,
  registrationResponse,
} from '../src/profiles.ts'

const deployment = sdk.deployment('monad-testnet')
const origin = 'https://dev.sidequest.exchange'
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql = fromNodeSqlite(db)
  const agents = new AgentStore(sql, () => 1000)
  agents.create({
    id: 'one',
    operator: deployment.sidequest!.safe,
    privyUserId: 'did:privy:test',
    name: 'Quill',
    registry: deployment.identity,
    chainId: deployment.chainId,
  })
  const profiles = new AgentProfiles(sql, () => 1001)
  profiles.update(
    'one',
    { description: 'Reviews code', tagline: 'Careful reviews', avatarKey: `avatars/${'a'.repeat(64)}.png` },
    'owner',
  )
  return { agents, profiles, reader: profileReader(sql, () => 1001, deployment) }
}

it('renders a current ERC-8004 registration with configured chain/registry and MCP version', async () => {
  const f = fixture()
  f.agents.bindRegistry('one', '2089')
  const hosted = (await f.reader.registration('one'))!
  expect(registrationBody(origin, hosted)).toMatchObject({
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'Quill',
    description: 'Reviews code',
    image: `${origin}/avatars/${'a'.repeat(64)}.png`,
    registrations: [
      { agentId: 2089, agentRegistry: `eip155:${deployment.chainId}:${deployment.identity.toLowerCase()}` },
    ],
    services: [
      { name: 'web', endpoint: `${origin}/agent/2089` },
      { name: 'MCP', endpoint: `${origin}/mcp`, version: '2026-07-28' },
    ],
    supportedTrust: ['reputation', 'crypto-economic'],
    active: true,
  })
  f.profiles.update('one', { description: 'Updated' }, 'agent')
  expect(registrationBody(origin, (await f.reader.registration('one'))!).description).toBe('Updated')
  const response = await registrationResponse(f.reader, origin, '/profiles/one.json')
  expect(response.status).toBe(200)
  expect(response.headers['cache-control']).toBe('public, max-age=60')
})

it('omits image, web and registrations before mint and returns 404 for unknown keys', async () => {
  const f = fixture()
  f.profiles.update('one', { avatarKey: null }, 'owner')
  const body = registrationBody(origin, (await f.reader.registration('one'))!)
  expect(body).not.toHaveProperty('image')
  expect(body).not.toHaveProperty('registrations')
  expect(body.services).toEqual([{ name: 'MCP', endpoint: `${origin}/mcp`, version: '2026-07-28' }])
  expect((await registrationResponse(f.reader, origin, '/profiles/missing.json')).status).toBe(404)
  expect((await registrationResponse(f.reader, origin, '/profiles/../one.json')).status).toBe(404)
})

it('reads every minted managed profile, filters by ID and keeps images on the origin', async () => {
  const f = fixture()
  expect(await f.reader.profiles()).toEqual([])
  f.agents.bindRegistry('one', '2089')
  expect((await f.reader.profiles()).map((p) => profileSummary(origin, p))).toEqual([
    {
      agentId: '2089',
      name: 'Quill',
      description: 'Reviews code',
      tagline: 'Careful reviews',
      image: `${origin}/avatars/${'a'.repeat(64)}.png`,
    },
  ])
  expect((await profilesResponse(f.reader, origin, '/data/profiles')).status).toBe(200)
  expect((await profilesResponse(f.reader, origin, '/data/profiles/2089')).status).toBe(200)
  expect((await profilesResponse(f.reader, origin, '/data/profiles/2090')).status).toBe(404)
  f.profiles.update('one', { avatarKey: null }, 'owner')
  expect(profileSummary(origin, (await f.reader.registration('one'))!).image).toBeNull()
})

it('preserves uint256 identities outside the safe JSON integer range', async () => {
  const f = fixture()
  f.agents.bindRegistry('one', '9007199254740993')
  expect(registrationBody(origin, (await f.reader.registration('one'))!).registrations?.[0]?.agentId).toBe(
    '9007199254740993',
  )
})
