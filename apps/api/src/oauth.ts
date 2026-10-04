import { fleetHash, fleetRandom, getManagedAgent, listManagedAgents, type FleetSql } from '@agent-jobs/board'

export const OAUTH_SCOPES = ['hireling:read', 'hireling:hire', 'hireling:work'] as const
export type OAuthGrant = { owner:string; scope:string; agentIds:string[]; resource:string; clientId:string; agentGenerations:Record<string,number> }
export type RouteReply = { status:number; body:unknown; headers?:Record<string,string> }
const failure=(error:string,description:string,status=400):RouteReply=>({status,body:{error,error_description:description},headers:{'cache-control':'no-store'}})
const good=(body:unknown,status=200):RouteReply=>({status,body,headers:{'cache-control':'no-store'}})
const redirect=(location:string):RouteReply=>({status:302,body:null,headers:{location,'cache-control':'no-store'}})
const decodeScopes=(scope:unknown):string|undefined=>{if(typeof scope!=='string')return undefined;const values=[...new Set(scope.split(' ').filter(Boolean))];return values.length>0&&values.every(v=>OAUTH_SCOPES.includes(v as typeof OAUTH_SCOPES[number]))?values.join(' '):undefined}
const validRedirect=(value:unknown):value is string=>{if(typeof value!=='string'||value.length>2048)return false;try{const url=new URL(value);return url.username===''&&url.password===''&&url.hash===''&&(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))}catch{return false}}
const validResource=(value:unknown,origin:string):value is string=>{if(typeof value!=='string')return false;try{const u=new URL(value);return u.origin===origin&&!u.search&&!u.hash&&(u.pathname==='/mcp'||/^\/b\/[a-z0-9-]{3,32}\/mcp$/.test(u.pathname))}catch{return false}}
const base64url=(buffer:ArrayBuffer)=>btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')
export const pkceChallenge=async(verifier:string)=>base64url(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)))

export async function resolveOAuth(sql:FleetSql,token:string|undefined,resource:string,now:number):Promise<OAuthGrant|undefined>{
 if(!token)return undefined
 const [r]=await sql.all<{owner:string;scope:string;agent_ids_json:string;agent_generations_json:string;resource:string;client_id:string}>('SELECT t.owner,t.scope,t.agent_ids_json,t.agent_generations_json,t.resource,t.client_id FROM oauth_tokens t JOIN oauth_token_families f ON f.id=t.family_id WHERE t.token_hash=? AND t.revoked=0 AND f.revoked=0 AND t.expires_at>?',await fleetHash(token),now)
 if(!r||r.resource!==resource)return undefined
 const agentIds=JSON.parse(r.agent_ids_json) as string[], agentGenerations=JSON.parse(r.agent_generations_json) as Record<string,number>
 for(const id of agentIds){const agent=await getManagedAgent(sql,id,r.owner);if(!agent||agent.generation!==agentGenerations[id])return undefined}
 return {owner:r.owner,scope:r.scope,agentIds,agentGenerations,resource:r.resource,clientId:r.client_id}
}

export async function oauthRoute(input:{sql:FleetSql;method:string;path:string;query:URLSearchParams;body:Record<string,unknown>;origin:string;siteOrigin:string;owner?:string|undefined;now:number}):Promise<RouteReply|undefined>{
 const {sql,path,method,body,query,origin,siteOrigin,owner,now}=input
 const metadataPath=path==='/.well-known/oauth-protected-resource'?'/mcp':path.startsWith('/.well-known/oauth-protected-resource/')?path.slice('/.well-known/oauth-protected-resource'.length):undefined
 if(metadataPath&&validResource(`${origin}${metadataPath}`,origin))return good({resource:`${origin}${metadataPath}`,authorization_servers:[origin],scopes_supported:OAUTH_SCOPES,bearer_methods_supported:['header']})
 if(path==='/.well-known/oauth-authorization-server')return good({issuer:origin,authorization_endpoint:`${origin}/oauth/authorize`,token_endpoint:`${origin}/oauth/token`,registration_endpoint:`${origin}/oauth/register`,revocation_endpoint:`${origin}/oauth/revoke`,response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],scopes_supported:OAUTH_SCOPES,authorization_response_iss_parameter_supported:true})
 if(path==='/oauth/register'&&method==='POST'){
  const uris=body.redirect_uris;if(!Array.isArray(uris)||uris.length<1||uris.length>8||!uris.every(validRedirect))return failure('invalid_client_metadata','Provide exact HTTPS or loopback redirect URIs')
  if(body.token_endpoint_auth_method!==undefined&&body.token_endpoint_auth_method!=='none')return failure('invalid_client_metadata','Only public PKCE clients are supported')
  const clientName=typeof body.client_name==='string'?body.client_name.slice(0,120):'Coding agent';const clientId=`hl_${fleetRandom(16)}`
  await sql.batch([{query:'INSERT INTO oauth_clients (client_id,client_name,redirect_uris_json,created_at) VALUES (?,?,?,?)',params:[clientId,clientName,JSON.stringify(uris),now]}]);return good({client_id:clientId,client_id_issued_at:now,client_name:clientName,redirect_uris:uris,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']},201)
 }
 if(path==='/oauth/authorize'&&method==='GET'){
  const clientId=query.get('client_id')??'',redirectUri=query.get('redirect_uri')??'';const [client]=await sql.all<{redirect_uris_json:string}>('SELECT redirect_uris_json FROM oauth_clients WHERE client_id=?',clientId)
  if(!client||!(JSON.parse(client.redirect_uris_json) as string[]).includes(redirectUri))return failure('invalid_request','Unknown client or redirect URI')
  const scope=decodeScopes(query.get('scope')??'hireling:read'),challenge=query.get('code_challenge')??'',resource=query.get('resource')
  if(query.get('response_type')!=='code'||query.get('code_challenge_method')!=='S256'||!/^[-_a-zA-Z0-9]{43}$/.test(challenge)||!scope||!validResource(resource,origin))return failure('invalid_request','Require authorization code, PKCE S256, supported scope and explicit MCP resource')
  const id=`oauth_${fleetRandom(20)}`;await sql.batch([{query:'INSERT INTO oauth_requests (id,client_id,redirect_uri,state,code_challenge,scope,resource,expires_at) VALUES (?,?,?,?,?,?,?,?)',params:[id,clientId,redirectUri,query.get('state'),challenge,scope,resource,now+600]}]);return redirect(`${siteOrigin}/connect?oauth_request=${encodeURIComponent(id)}`)
 }
 const consent=/^\/oauth\/requests\/(oauth_[a-f0-9]+)(\/approve)?$/.exec(path)
 if(consent){
  if(!owner)return failure('unauthorized','Sign in through the website',401)
  const [r]=await sql.all<{id:string;client_id:string;client_name:string;redirect_uri:string;state:string|null;code_challenge:string;scope:string;resource:string;expires_at:number}>('SELECT r.*,c.client_name FROM oauth_requests r JOIN oauth_clients c ON c.client_id=r.client_id WHERE r.id=? AND r.used=0 AND r.expires_at>?',consent[1]!,now)
  if(!r)return failure('invalid_request','This consent request expired or was already used')
  const agents=await listManagedAgents(sql,owner)
  if(method==='GET'&&!consent[2])return good({ok:true,result:{request:{id:r.id,clientName:r.client_name,scope:r.scope,resource:r.resource,expiresAt:r.expires_at},agents}})
  if(method==='POST'&&consent[2]){
   const decision=body.decision==='reject'?'reject':'approve',agentIds=body.agentIds
   if(decision==='approve'&&(!Array.isArray(agentIds)||agentIds.length===0||agentIds.length>20||!agentIds.every(id=>typeof id==='string'&&agents.some(a=>a.id===id))))return failure('invalid_request','Select agents owned by this operator')
   const consumed=await sql.all<{id:string}>('UPDATE oauth_requests SET used=1,owner=? WHERE id=? AND used=0 AND expires_at>? RETURNING id',owner,r.id,now);if(!consumed[0])return failure('invalid_request','Consent already used')
   const target=new URL(r.redirect_uri);target.searchParams.set('iss',origin);if(r.state!==null)target.searchParams.set('state',r.state)
   if(decision==='reject')target.searchParams.set('error','access_denied')
   else{const code=fleetRandom(32);await sql.batch([{query:'INSERT INTO oauth_codes (code_hash,request_id,client_id,redirect_uri,code_challenge,scope,agent_ids_json,agent_generations_json,expires_at) VALUES (?,?,?,?,?,?,?,?,?)',params:[await fleetHash(code),r.id,r.client_id,r.redirect_uri,r.code_challenge,r.scope,JSON.stringify(agentIds),JSON.stringify(Object.fromEntries(agents.filter(a=>(agentIds as string[]).includes(a.id)).map(a=>[a.id,a.generation]))),now+120]}]);target.searchParams.set('code',code)}
   return good({ok:true,result:{redirectUrl:target.href}})
  }
 }
 if(path==='/oauth/token'&&method==='POST'){
  const resource=body.resource,clientId=body.client_id;if(typeof clientId!=='string'||!validResource(resource,origin))return failure('invalid_request','Require client_id and resource')
  let grant:OAuthGrant
  let familyId:string
  if(body.grant_type==='authorization_code'){
   const code=typeof body.code==='string'?body.code:'',verifier=typeof body.code_verifier==='string'?body.code_verifier:''
   if(!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))return failure('invalid_grant','Invalid PKCE verifier')
   const [r]=await sql.all<{owner:string;scope:string;resource:string;agent_ids_json:string;agent_generations_json:string;code_challenge:string;redirect_uri:string}>('SELECT c.*,r.owner,r.resource FROM oauth_codes c JOIN oauth_requests r ON r.id=c.request_id WHERE c.code_hash=? AND c.client_id=? AND c.used=0 AND c.expires_at>?',await fleetHash(code),clientId,now)
   if(!r||r.redirect_uri!==body.redirect_uri||r.resource!==resource||r.code_challenge!==await pkceChallenge(verifier))return failure('invalid_grant','Code, resource, redirect or verifier does not match')
   const consumed=await sql.all<{code_hash:string}>('UPDATE oauth_codes SET used=1 WHERE code_hash=? AND used=0 AND expires_at>? RETURNING code_hash',await fleetHash(code),now);if(!consumed[0])return failure('invalid_grant','Code already used')
   familyId=`family_${fleetRandom(16)}`
   await sql.batch([{query:'INSERT INTO oauth_token_families (id) VALUES (?)',params:[familyId]}])
   grant={owner:r.owner,scope:r.scope,resource:r.resource,agentIds:JSON.parse(r.agent_ids_json) as string[],agentGenerations:JSON.parse(r.agent_generations_json) as Record<string,number>,clientId}
  }else if(body.grant_type==='refresh_token'){
   const hash=await fleetHash(String(body.refresh_token??''));const [r]=await sql.all<{owner:string;scope:string;resource:string;agent_ids_json:string;agent_generations_json:string;family_id:string}>('UPDATE oauth_tokens SET revoked=1 WHERE refresh_hash=? AND client_id=? AND resource=? AND revoked=0 AND expires_at>? AND family_id IN (SELECT id FROM oauth_token_families WHERE revoked=0) RETURNING owner,scope,resource,agent_ids_json,agent_generations_json,family_id',hash,clientId,resource,now-86400*7)
   if(!r){
    const [reused]=await sql.all<{family_id:string|null}>('SELECT family_id FROM oauth_tokens WHERE refresh_hash=? AND client_id=? AND resource=? AND expires_at>? LIMIT 1',hash,clientId,resource,now-86400*7)
    if(reused?.family_id) await sql.batch([{query:'UPDATE oauth_token_families SET revoked=1 WHERE id=?',params:[reused.family_id]},{query:'UPDATE oauth_tokens SET revoked=1 WHERE family_id=?',params:[reused.family_id]}])
    return failure('invalid_grant','Refresh token expired or was already rotated')
   }
   familyId=r.family_id
   grant={owner:r.owner,scope:r.scope,resource:r.resource,agentIds:JSON.parse(r.agent_ids_json) as string[],agentGenerations:JSON.parse(r.agent_generations_json) as Record<string,number>,clientId}
  }else return failure('unsupported_grant_type','Supported grants: authorization_code and refresh_token')
  const token=fleetRandom(32),refresh=fleetRandom(32),tokenHash=await fleetHash(token);await sql.batch([{query:'INSERT INTO oauth_tokens (token_hash,client_id,owner,scope,resource,agent_ids_json,agent_generations_json,expires_at,refresh_hash,family_id) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM oauth_token_families WHERE id=? AND revoked=0)',params:[tokenHash,clientId,grant.owner,grant.scope,grant.resource,JSON.stringify(grant.agentIds),JSON.stringify(grant.agentGenerations),now+3600,await fleetHash(refresh),familyId,familyId]}])
  if(!(await sql.all('SELECT t.token_hash FROM oauth_tokens t JOIN oauth_token_families f ON f.id=t.family_id WHERE t.token_hash=? AND t.revoked=0 AND f.revoked=0',tokenHash))[0])return failure('invalid_grant','Token family was revoked during rotation')
  return good({access_token:token,token_type:'Bearer',expires_in:3600,refresh_token:refresh,scope:grant.scope})
 }
 if(path==='/oauth/revoke'&&method==='POST'){if(typeof body.token==='string'){const hash=await fleetHash(body.token),clientId=String(body.client_id??'');await sql.batch([{query:'UPDATE oauth_token_families SET revoked=1 WHERE id IN (SELECT family_id FROM oauth_tokens WHERE (token_hash=? OR refresh_hash=?) AND client_id=?)',params:[hash,hash,clientId]},{query:'UPDATE oauth_tokens SET revoked=1 WHERE family_id IN (SELECT family_id FROM oauth_tokens WHERE (token_hash=? OR refresh_hash=?) AND client_id=?)',params:[hash,hash,clientId]}])}return good({})}
 return undefined
}
