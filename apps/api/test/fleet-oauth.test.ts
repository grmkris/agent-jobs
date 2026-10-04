import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createManagedAgent, migrateFleet, type FleetSql } from '@agent-jobs/board'
import { oauthRoute, pkceChallenge, resolveOAuth } from '../src/oauth.ts'

const sqlOf = (db: DatabaseSync): FleetSql => ({
  all: async <T>(query: string, ...params: (string|number|null)[]) => db.prepare(query).all(...params) as T[],
  batch: async statements => { db.exec('BEGIN'); try { for (const statement of statements) db.prepare(statement.query).run(...statement.params); db.exec('COMMIT') } catch (error) { db.exec('ROLLBACK'); throw error } },
})

describe('fleet OAuth', () => {
  it('registers, authorizes with PKCE and rotates an audience-scoped token', async () => {
    const sql = sqlOf(new DatabaseSync(':memory:')); await migrateFleet(sql)
    const origin = 'https://hireling.test', redirectUri = 'http://localhost:49321/callback', verifier = 'a'.repeat(64)
    const registered = await oauthRoute({ sql, method:'POST', path:'/oauth/register', query:new URLSearchParams(), origin, siteOrigin:origin, body:{client_name:'test',redirect_uris:[redirectUri]}, now:100 })
    expect(registered?.status).toBe(201); const clientId = (registered?.body as {client_id:string}).client_id
    const started = await oauthRoute({sql,method:'GET',path:'/oauth/authorize',query:new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:'hireling:read',resource:`${origin}/mcp`,code_challenge:await pkceChallenge(verifier),code_challenge_method:'S256',state:'s'}),origin,siteOrigin:origin,body:{},now:101})
    expect(started?.headers?.location).toContain('/connect?oauth_request=')
    const requestId = new URL(started!.headers!.location!).searchParams.get('oauth_request')!
    const consent = await oauthRoute({sql,method:'GET',path:`/oauth/requests/${requestId}`,query:new URLSearchParams(),origin,siteOrigin:origin,owner:'0x0000000000000000000000000000000000000001',body:{},now:102})
    expect(consent?.status).toBe(200)
    const approved = await oauthRoute({sql,method:'POST',path:`/oauth/requests/${requestId}/approve`,query:new URLSearchParams(),origin,siteOrigin:origin,owner:'0x0000000000000000000000000000000000000001',body:{decision:'approve',agentIds:[]},now:102})
    expect(approved?.status).toBe(400)
    // No managed agent means consent must not mint a bearer token.
    const denied = await oauthRoute({sql,method:'POST',path:`/oauth/requests/${requestId}/approve`,query:new URLSearchParams(),origin,siteOrigin:origin,owner:'0x0000000000000000000000000000000000000001',body:{decision:'reject'},now:102})
    expect(denied?.status).toBe(200)
    expect(await resolveOAuth(sql,'invalid',`${origin}/mcp`,103)).toBeUndefined()
  })
  it('checks the exact resource, rotates once, and fences revoked agent generations', async () => {
    const sql = sqlOf(new DatabaseSync(':memory:')); await migrateFleet(sql)
    const owner='0x0000000000000000000000000000000000000001',origin='https://hireling.test',redirectUri='http://127.0.0.1:38111/callback',verifier='b'.repeat(64)
    const agent=await createManagedAgent(sql,{owner,name:'worker',walletAddress:'0x0000000000000000000000000000000000000002',now:100})
    const route=(path:string,body:Record<string,unknown>,now=100,method='POST',query=new URLSearchParams())=>oauthRoute({sql,path,body,now,method,query,origin,siteOrigin:origin,owner})
    const registered=await route('/oauth/register',{redirect_uris:[redirectUri]});const clientId=(registered!.body as {client_id:string}).client_id
    const authorization=await route('/oauth/authorize',{},101,'GET',new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:'hireling:read hireling:work',resource:`${origin}/mcp`,code_challenge:await pkceChallenge(verifier),code_challenge_method:'S256',state:'opaque'}))
    const requestId=new URL(authorization!.headers!.location!).searchParams.get('oauth_request')!
    const consent=await route(`/oauth/requests/${requestId}/approve`,{decision:'approve',agentIds:[agent.id]},102)
    const target=new URL((consent!.body as {result:{redirectUrl:string}}).result.redirectUrl);expect(target.searchParams.get('iss')).toBe(origin);expect(target.searchParams.get('state')).toBe('opaque')
    const exchange={grant_type:'authorization_code',client_id:clientId,redirect_uri:redirectUri,resource:`${origin}/mcp`,code:target.searchParams.get('code'),code_verifier:verifier}
    expect((await route('/oauth/token',{...exchange,resource:`${origin}/b/other/mcp`},103))?.status).toBe(400)
    const issued=await route('/oauth/token',exchange,103);expect(issued?.status).toBe(200)
    const token=issued!.body as {access_token:string;refresh_token:string}
    expect((await resolveOAuth(sql,token.access_token,`${origin}/mcp`,104))?.agentIds).toEqual([agent.id])
    expect(await resolveOAuth(sql,token.access_token,`${origin}/b/other/mcp`,104)).toBeUndefined()
    expect((await route('/oauth/token',exchange,104))?.status).toBe(400)
    const refresh={grant_type:'refresh_token',client_id:clientId,resource:`${origin}/mcp`,refresh_token:token.refresh_token}
    const rotated=await route('/oauth/token',refresh,105);expect(rotated?.status).toBe(200)
    expect(await resolveOAuth(sql,token.access_token,`${origin}/mcp`,106)).toBeUndefined()
    expect((await route('/oauth/token',refresh,106))?.status).toBe(400)
    const current=rotated!.body as {access_token:string;refresh_token:string}
    await sql.batch([{query:'UPDATE managed_agents SET generation=generation+1 WHERE id=?',params:[agent.id]}])
    expect(await resolveOAuth(sql,current.access_token,`${origin}/mcp`,107)).toBeUndefined()
  })
  it('rejects unregistered redirects, foreign grants and unsafe registration', async()=>{
    const sql=sqlOf(new DatabaseSync(':memory:'));await migrateFleet(sql)
    const input={sql,method:'POST',path:'/oauth/register',query:new URLSearchParams(),origin:'https://hireling.test',siteOrigin:'https://hireling.test',now:100}
    expect((await oauthRoute({...input,body:{redirect_uris:['http://public.example/callback']}}))?.status).toBe(400)
    expect((await oauthRoute({...input,body:{redirect_uris:['https://public.example/callback#frag']}}))?.status).toBe(400)
    expect((await oauthRoute({...input,body:{redirect_uris:['https://public.example/callback'],token_endpoint_auth_method:'client_secret_basic'}}))?.status).toBe(400)
  })
})
