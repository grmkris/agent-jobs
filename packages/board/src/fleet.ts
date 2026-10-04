/** Durable records shared by the website, MCP connector and local companion. */
export type FleetSqlValue = string | number | null
export interface FleetSql {
  all<T>(query: string, ...params: FleetSqlValue[]): Promise<T[]>
  batch(statements: ReadonlyArray<{ query: string; params: readonly FleetSqlValue[] }>): Promise<void>
}

export type ManagedAgent = {
  id: string; name: string; owner: string; walletAddress: string; privyWalletId?: string; privyAppId?: string
  agentId?: string; kind: 'privy' | 'external'; status: string; policyId?: string
  generation: number; createdAt: number; lastHeartbeatAt?: number; companionVersion?: string; deviceFingerprint?: string; launchId?: string; firstPromptHash?: string; pid?: number
}
export type Approval = {
  id: string; agentId: string; owner: string; action: string; payload: Record<string, unknown>
  createdAt: number; expiresAt: number; status: 'pending'|'approved'|'rejected'|'expired'; operationId: string; execution?:{state:'claimed'|'completed';transactionHashes?:string[]}
}

export const FLEET_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS managed_agents (id TEXT PRIMARY KEY,name TEXT NOT NULL,owner TEXT NOT NULL,wallet_address TEXT NOT NULL,privy_wallet_id TEXT,privy_app_id TEXT,agent_id TEXT,kind TEXT NOT NULL,status TEXT NOT NULL,policy_id TEXT,generation INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,last_heartbeat_at INTEGER,companion_version TEXT,launch_json TEXT)`,
  `CREATE INDEX IF NOT EXISTS managed_agents_owner ON managed_agents(owner)`,
  `CREATE TABLE IF NOT EXISTS agent_pairings (id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,owner TEXT NOT NULL,code_hash TEXT NOT NULL,public_key TEXT,expires_at INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0,generation INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS agent_approvals (id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,owner TEXT NOT NULL,action TEXT NOT NULL,payload_json TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE)`,
  `CREATE INDEX IF NOT EXISTS agent_approvals_owner ON agent_approvals(owner,status)`,
  `CREATE TABLE IF NOT EXISTS agent_activity (id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,kind TEXT NOT NULL,detail_json TEXT NOT NULL,created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY,client_name TEXT NOT NULL,redirect_uris_json TEXT NOT NULL,created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS oauth_requests (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,redirect_uri TEXT NOT NULL,state TEXT,code_challenge TEXT NOT NULL,scope TEXT NOT NULL,resource TEXT NOT NULL,owner TEXT,expires_at INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS oauth_codes (code_hash TEXT PRIMARY KEY,request_id TEXT NOT NULL,client_id TEXT NOT NULL,redirect_uri TEXT NOT NULL,code_challenge TEXT NOT NULL,scope TEXT NOT NULL,agent_ids_json TEXT NOT NULL,agent_generations_json TEXT NOT NULL DEFAULT '{}',expires_at INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0)`,
  // Keep the pre-family oauth_tokens table untouched. New grants use versioned tables, so legacy grants reauthorize.
  `CREATE TABLE IF NOT EXISTS oauth_tokens_v2 (token_hash TEXT PRIMARY KEY,client_id TEXT NOT NULL,owner TEXT NOT NULL,scope TEXT NOT NULL,resource TEXT NOT NULL,agent_ids_json TEXT NOT NULL,agent_generations_json TEXT NOT NULL DEFAULT '{}',expires_at INTEGER NOT NULL,refresh_hash TEXT,family_id TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS oauth_token_families_v2 (id TEXT PRIMARY KEY,revoked INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS agent_gateway_operations (operation_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,state TEXT NOT NULL,provider_json TEXT,raw_transaction TEXT,transaction_hash TEXT,created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS approval_execution (approval_id TEXT PRIMARY KEY,claim_id TEXT NOT NULL,state TEXT NOT NULL,transaction_hashes_json TEXT,continuation_json TEXT,created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS agent_challenges (id TEXT PRIMARY KEY,owner TEXT NOT NULL,wallet_address TEXT NOT NULL,message TEXT NOT NULL,expires_at INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS agent_runtime (agent_id TEXT PRIMARY KEY,token_hash TEXT NOT NULL,public_key TEXT NOT NULL,device_fingerprint TEXT NOT NULL,generation INTEGER NOT NULL,health_challenge TEXT,challenge_expires_at INTEGER NOT NULL DEFAULT 0)`,
] as const

const bytes = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map(x => x.toString(16).padStart(2,'0')).join('')
export const fleetRandom = (n = 24) => bytes(n)
export const fleetHash = async (value: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2,'0')).join('')
}
const fromRow = (r: Record<string, unknown>): ManagedAgent => ({
  id: String(r.id), name: String(r.name), owner: String(r.owner), walletAddress: String(r.wallet_address),
  ...(r.privy_wallet_id ? { privyWalletId: String(r.privy_wallet_id) } : {}), ...(r.privy_app_id ? { privyAppId: String(r.privy_app_id) } : {}), ...(r.agent_id ? { agentId: String(r.agent_id) } : {}),
  kind: r.kind === 'external' ? 'external' : 'privy', status: String(r.status), ...(r.policy_id ? { policyId: String(r.policy_id) } : {}),
  generation: Number(r.generation), createdAt: Number(r.created_at), ...(r.last_heartbeat_at ? { lastHeartbeatAt: Number(r.last_heartbeat_at) } : {}), ...(r.companion_version ? { companionVersion: String(r.companion_version) } : {}), ...(r.device_fingerprint ? { deviceFingerprint: String(r.device_fingerprint) } : {}), ...(r.launch_json ? JSON.parse(String(r.launch_json)) as {launchId:string;firstPromptHash:string;pid:number} : {}),
})
export async function migrateFleet(sql: FleetSql): Promise<void> {
  await sql.batch(FLEET_SCHEMA.map(query => ({ query, params: [] })))
}
export async function listManagedAgents(sql: FleetSql, owner: string): Promise<ManagedAgent[]> { return (await sql.all<Record<string,unknown>>('SELECT a.*,r.device_fingerprint FROM managed_agents a LEFT JOIN agent_runtime r ON r.agent_id=a.id AND r.generation=a.generation WHERE a.owner = ? ORDER BY a.created_at DESC', owner)).map(fromRow) }
export async function getManagedAgent(sql: FleetSql, id: string, owner?: string): Promise<ManagedAgent|undefined> { const rows = await sql.all<Record<string,unknown>>(`SELECT a.*,r.device_fingerprint FROM managed_agents a LEFT JOIN agent_runtime r ON r.agent_id=a.id AND r.generation=a.generation WHERE a.id = ?${owner === undefined ? '' : ' AND a.owner = ?'}`, ...(owner === undefined ? [id] : [id,owner])); return rows[0] ? fromRow(rows[0]) : undefined }
export async function createManagedAgent(sql: FleetSql, input: { owner:string; name:string; walletAddress:string; privyWalletId?:string; privyAppId?:string; agentId?:string; kind?:'privy'|'external'; now:number }): Promise<ManagedAgent> {
  const id = `agt_${fleetRandom(12)}`; await sql.batch([{ query:'INSERT INTO managed_agents (id,name,owner,wallet_address,privy_wallet_id,privy_app_id,agent_id,kind,status,generation,created_at) VALUES (?,?,?,?,?,?,?,?,?,0,?)', params:[id,input.name,input.owner,input.walletAddress,input.privyWalletId ?? null,input.privyAppId ?? null,input.agentId ?? null,input.kind ?? 'privy','created',input.now] }]); return (await getManagedAgent(sql,id))!
}
export async function issuePairing(sql: FleetSql, agent: ManagedAgent, now:number): Promise<{code:string;expiresAt:number;id:string}> { const code = fleetRandom(20), id=`pair_${fleetRandom(10)}`, expiresAt=now+600; await sql.batch([{query:'UPDATE agent_pairings SET used=1 WHERE agent_id = ? AND used=0',params:[agent.id]},{query:'INSERT INTO agent_pairings (id,agent_id,owner,code_hash,expires_at,generation) VALUES (?,?,?,?,?,?)',params:[id,agent.id,agent.owner,await fleetHash(code),expiresAt,agent.generation]}]); return {code,expiresAt,id} }
export async function consumePairing(sql:FleetSql, code:string, input:{agentId:string;owner:string;publicKey?:string;now:number}):Promise<boolean>{const hash=await fleetHash(code); const rows=await sql.all<{id:string;generation:number}>('SELECT id,generation FROM agent_pairings WHERE code_hash=? AND agent_id=? AND owner=? AND used=0 AND expires_at>=?',hash,input.agentId,input.owner,input.now); if(!rows[0])return false; await sql.batch([{query:'UPDATE agent_pairings SET used=1,public_key=? WHERE id=?',params:[input.publicKey ?? null,rows[0].id]},{query:'UPDATE managed_agents SET status=\'paired\' WHERE id=? AND generation=?',params:[input.agentId,rows[0].generation]}]);return true}
export async function heartbeat(sql:FleetSql, input:{agentId:string;owner:string;generation:number;status:string;version?:string;now:number}):Promise<boolean>{const r=await sql.all<{id:string}>('SELECT id FROM managed_agents WHERE id=? AND owner=? AND generation=?',input.agentId,input.owner,input.generation);if(!r[0])return false; await sql.batch([{query:'UPDATE managed_agents SET status=?,last_heartbeat_at=?,companion_version=? WHERE id=? AND generation=?',params:[input.status,input.now,input.version ?? null,input.agentId,input.generation]},{query:'INSERT INTO agent_activity (id,agent_id,kind,detail_json,created_at) VALUES (?,?,?,?,?)',params:[`act_${fleetRandom(10)}`,input.agentId,'health',JSON.stringify({status:input.status,version:input.version}),input.now]}]);return true}
export async function listApprovals(sql:FleetSql, owner:string, now:number):Promise<Approval[]>{await sql.batch([{query:"UPDATE agent_approvals SET status='expired' WHERE owner=? AND status='pending' AND expires_at<=?",params:[owner,now]}]);const rows=await sql.all<Record<string,unknown>>('SELECT a.*,e.state AS execution_state,e.transaction_hashes_json FROM agent_approvals a LEFT JOIN approval_execution e ON e.approval_id=a.id WHERE a.owner=? ORDER BY a.created_at DESC',owner);return rows.map(r=>({id:String(r.id),agentId:String(r.agent_id),owner:String(r.owner),action:String(r.action),payload:JSON.parse(String(r.payload_json)) as Record<string,unknown>,createdAt:Number(r.created_at),expiresAt:Number(r.expires_at),status:String(r.status) as Approval['status'],operationId:String(r.operation_id),...(r.execution_state?{execution:{state:String(r.execution_state) as 'claimed'|'completed',...(r.transaction_hashes_json?{transactionHashes:JSON.parse(String(r.transaction_hashes_json)) as string[]}: {})}}:{})}))}
export async function decideApproval(sql:FleetSql,id:string,owner:string,decision:'approve'|'reject',now:number):Promise<Approval|undefined>{const rows=await sql.all<Record<string,unknown>>('SELECT * FROM agent_approvals WHERE id=? AND owner=?',id,owner);if(!rows[0])return undefined;await sql.batch([{query:'UPDATE agent_approvals SET status=? WHERE id=? AND owner=? AND status=\'pending\'',params:[decision==='approve'?'approved':'rejected',id,owner]}]);return (await listApprovals(sql,owner,now)).find(x=>x.id===id)}
