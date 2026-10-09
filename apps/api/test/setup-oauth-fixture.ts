import { DatabaseSync } from 'node:sqlite'
import { AgentStore, fromNodeSqlite } from '@sidequest/board'
import { Schema } from 'effect'
import * as sdk from '@sidequest/sdk'
import { getAddress } from 'viem'
import { oauthRoute } from '../src/oauth.ts'
import { pkceChallenge } from '../src/oauth-validation.ts'

export const origin = 'https://board.example'
export const resource = `${origin}/b/team-board/mcp`
export const operator = getAddress(`0x${'11'.repeat(20)}`)
export const outsider = getAddress(`0x${'22'.repeat(20)}`)
const redirectUri = 'http://127.0.0.1:3210/callback'
const verifier = 'a'.repeat(43)
const Tokens = Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String, scope: Schema.String })

export function setupFixture() {
  const db = new DatabaseSync(':memory:')
  const sql = fromNodeSqlite(db)
  let now = 1000
  const agents = new AgentStore(sql, () => now)
  const route = (
    path: string,
    body: Record<string, unknown> = {},
    query = new URLSearchParams(),
    method = 'POST',
    owner: string | null = operator,
  ) =>
    oauthRoute({
      sql,
      path,
      body,
      query,
      method,
      origin,
      siteOrigin: origin,
      now,
      ...(owner === null ? {} : { owner }),
    })
  const request = async (requestedScopes = 'sidequest:setup sidequest:read sidequest:work') => {
    const register = await route('/oauth/register', { redirect_uris: [redirectUri], client_name: 'Coding agent' })
    const clientId = Schema.decodeUnknownSync(Schema.Struct({ client_id: Schema.String }))(register?.body).client_id
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: requestedScopes,
      resource,
      code_challenge_method: 'S256',
      code_challenge: await pkceChallenge(verifier),
      state: 'state-one',
    })
    const authorize = await route('/oauth/authorize', {}, query, 'GET')
    if (authorize?.redirect === undefined) throw new Error('authorization did not redirect')
    const requestId = new URL(authorize.redirect).searchParams.get('oauth_request')!
    return { clientId, requestId, query }
  }
  const connection = async (requestedScopes?: string) => {
    const consent = await request(requestedScopes)
    const approved = await route(`/oauth/requests/${consent.requestId}/approve`, { setup: true, agentIds: [] })
    const redirectUrl = Schema.decodeUnknownSync(
      Schema.Struct({ result: Schema.Struct({ redirectUrl: Schema.String }) }),
    )(approved?.body).result.redirectUrl
    const tokenBody = {
      grant_type: 'authorization_code',
      client_id: consent.clientId,
      resource,
      redirect_uri: redirectUri,
      code: new URL(redirectUrl).searchParams.get('code')!,
      code_verifier: verifier,
    }
    const reply = await route('/oauth/token', tokenBody)
    const tokens = Schema.decodeUnknownSync(Tokens)(reply?.body)
    return { ...consent, tokenBody, tokens }
  }
  const active = (id = 'quill', owner = operator) => {
    const deployment = sdk.deployment('monad-testnet')
    agents.create({
      id,
      operator: owner,
      privyUserId: 'did:privy:owner',
      name: id,
      registry: deployment.identity,
      chainId: deployment.chainId,
    })
    agents.bindWallet(id, `wallet-${id}`, getAddress(`0x${'33'.repeat(20)}`))
    agents.bindRegistry(id, '41')
    for (const state of ['upgraded', 'grants-live', 'registered', 'active'] as const) agents.advance(id, state)
    return agents.get(id)
  }
  return {
    db,
    sql,
    agents,
    route,
    request,
    connection,
    active,
    now: () => now,
    clock: (value: number) => {
      now = value
    },
  }
}
