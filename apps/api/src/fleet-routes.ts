import { fleetHash, fleetRandom, listManagedAgents, getManagedAgent, createManagedAgent, issuePairing, heartbeat, listApprovals, decideApproval, type FleetSql, type ManagedAgent } from '@agent-jobs/board'
import * as sdk from '@agent-jobs/sdk'
import { getAddress, type Address, type Hex } from 'viem'
import type { BoardReply } from './board.ts'
import type { RouteReply } from './oauth.ts'
import { AUTONOMOUS_SIGNING_VERIFIED, restrictedWalletGateway } from './restricted-gateway.ts'
import { verifyPrivyWallet } from './privy-identity.ts'

const good=(result:unknown,status=200):RouteReply=>({status,body:{ok:true,result}})
const fail=(code:string,message:string,status=400):RouteReply=>({status,body:{ok:false,code,message}})
const decode=(value:string)=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))
export async function verifyP256(publicKey:string,signature:string,message:string):Promise<boolean>{try{const key=await crypto.subtle.importKey('spki',decode(publicKey),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);return await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,decode(signature),new TextEncoder().encode(message))}catch{return false}}
const address=(value:unknown):value is string=>typeof value==='string'&&/^0x[0-9a-fA-F]{40}$/.test(value)
const freshness=(agent:ManagedAgent,now:number):ManagedAgent=>agent.lastHeartbeatAt&&now-agent.lastHeartbeatAt>90&&['launched','ready','healthy'].includes(agent.status)?{...agent,status:'stale'}:agent

type Input={sql:FleetSql;method:string;path:string;body:Record<string,unknown>;origin:string;owner?:string|undefined;bearer?:string|undefined;now:number;network:sdk.Network;rpcUrl:string;appId:string;appSecret?:string|undefined;runTool?:(tool:string,args:Record<string,unknown>,caller:string,boardId:string)=>Promise<BoardReply>}
export async function fleetRoute(input:Input):Promise<RouteReply|undefined>{
 const {sql,method,path,body,origin,owner,bearer,now,network,rpcUrl}=input
 if(!path.startsWith('/api/agents')&&!path.startsWith('/api/approvals')&&path!=='/api/live'&&path!=='/api/pairings/complete')return undefined
 const reads=rpcUrl?sdk.context(network,'main',rpcUrl).publicClient:undefined
 const chainWallet=async(id:string)=>reads?.readContract({address:sdk.deployment(network).identity,abi:sdk.identityAbi,functionName:'getAgentWallet',args:[BigInt(id)]})
 if(path==='/api/pairings/complete'&&method==='POST'){
  const code=String(body.code??''),publicKey=String(body.publicKeySpki??''),signature=String(body.signature??'')
  if(!await verifyP256(publicKey,signature,`hireling-pair-v1\n${code}\n${publicKey}`))return fail('forbidden','Invalid P-256 pairing signature',403)
  const [pair]=await sql.all<{id:string;agent_id:string;owner:string;generation:number}>('SELECT * FROM agent_pairings WHERE code_hash=? AND used=0 AND expires_at>?',await fleetHash(code),now)
  const agent=pair?await getManagedAgent(sql,pair.agent_id,pair.owner):undefined
  if(!pair||!agent||pair.generation!==agent.generation)return fail('forbidden','Pairing is expired, revoked or already used',403)
  const consumed=await sql.all<{id:string}>('UPDATE agent_pairings SET used=1,public_key=? WHERE id=? AND used=0 AND expires_at>? RETURNING id',publicKey,pair.id,now);if(!consumed[0])return fail('forbidden','Pairing already used',403)
  const runtimeToken=fleetRandom(32)
  await sql.batch([{query:'INSERT INTO agent_runtime (agent_id,token_hash,public_key,device_fingerprint,generation) VALUES (?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET token_hash=excluded.token_hash,public_key=excluded.public_key,device_fingerprint=excluded.device_fingerprint,generation=excluded.generation,health_challenge=NULL,challenge_expires_at=0',params:[agent.id,await fleetHash(runtimeToken),publicKey,await fleetHash(publicKey),agent.generation]},{query:'UPDATE managed_agents SET status=\'paired\' WHERE id=? AND generation=?',params:[agent.id,agent.generation]}])
  return good({agent:{...agent,status:'paired'},runtimeToken,generation:agent.generation,gatewayEnabled:false,apiOrigin:origin,privyAppId:agent.privyAppId??input.appId,deviceFingerprint:await fleetHash(publicKey)})
 }
 const healthMatch=/^\/api\/agents\/([^/]+)\/health$/.exec(path)
 if(healthMatch){
  const [runtime]=await sql.all<{agent_id:string;public_key:string;generation:number;health_challenge:string|null;challenge_expires_at:number}>('SELECT * FROM agent_runtime WHERE agent_id=? AND token_hash=?',healthMatch[1]!,await fleetHash(bearer??''))
  const agent=runtime?await getManagedAgent(sql,runtime.agent_id):undefined
  if(!runtime||!agent||runtime.generation!==agent.generation)return fail('unauthenticated','Valid runtime pairing required',401)
  if(method==='GET'){const challenge=fleetRandom(24),expiresAt=now+60;await sql.batch([{query:'UPDATE agent_runtime SET health_challenge=?,challenge_expires_at=? WHERE agent_id=? AND generation=?',params:[challenge,expiresAt,agent.id,agent.generation]}]);return good({challenge,expiresAt})}
  if(method==='POST'){
   const status=String(body.status??''),version=String(body.version??''),challenge=String(body.challenge??'')
   if(!['launched','ready','healthy','stopped'].includes(status)||version.length>100||body.generation!==agent.generation||challenge!==runtime.health_challenge||runtime.challenge_expires_at<=now)return fail('forbidden','Expired health challenge or generation mismatch',403)
   const launchId=typeof body.launchId==='string'?body.launchId:'',firstPromptHash=typeof body.firstPromptHash==='string'?body.firstPromptHash:'',pid=typeof body.pid==='number'?body.pid:undefined
   if(status!=='stopped'&&(!launchId||launchId.length>100||!/^[a-f0-9]{64}$/.test(firstPromptHash)||!Number.isSafeInteger(pid)||pid!<1))return fail('invalid','A process ID, launch ID and first prompt hash are required')
   if(status==='ready'&&!['launched','ready'].includes(agent.status)||status==='healthy'&&!['ready','healthy'].includes(agent.status))return fail('conflict','The worker must launch and complete its MCP handshake before reporting healthy',409)
   if((status==='ready'||status==='healthy')&&agent.launchId!==launchId)return fail('conflict','Health does not match the active launch',409)
   if(!await verifyP256(runtime.public_key,String(body.signature??''),`hireling-health-v2\n${agent.id}\n${agent.generation}\n${challenge}\n${status}\n${version}\n${launchId}\n${firstPromptHash}\n${pid??''}`))return fail('forbidden','Invalid health signature',403)
   const consumed=await sql.all<{agent_id:string}>('UPDATE agent_runtime SET health_challenge=NULL,challenge_expires_at=0 WHERE agent_id=? AND generation=? AND health_challenge=? RETURNING agent_id',agent.id,agent.generation,challenge);if(!consumed[0])return fail('forbidden','Health challenge already used',403)
   await sql.batch([{query:'UPDATE managed_agents SET launch_json=? WHERE id=? AND generation=?',params:[JSON.stringify({launchId,firstPromptHash,pid}),agent.id,agent.generation]}])
   await heartbeat(sql,{agentId:agent.id,owner:agent.owner,generation:agent.generation,status,version,now});return good({agentId:agent.id,status,lastHeartbeatAt:now})
  }
 }
 const walletRpc=/^\/api\/agents\/([^/]+)\/wallet\/rpc$/.exec(path)
 if(walletRpc&&method==='POST')return restrictedWalletGateway({sql,managedId:walletRpc[1]!,bearer,body,now,network,rpcUrl,appSecret:input.appSecret,authorityVerified:AUTONOMOUS_SIGNING_VERIFIED})
 if(path.includes('/wallet/'))return fail('unavailable','Unsupported wallet gateway operation',503)
 if(path==='/api/live'&&method==='GET'){
  const agents=owner?(await listManagedAgents(sql,owner)).map(a=>freshness(a,now)):[]
  const activity=owner?await sql.all<{id:string;agent_id:string;kind:string;detail_json:string;created_at:number}>('SELECT act.* FROM agent_activity act JOIN managed_agents a ON a.id=act.agent_id WHERE a.owner=? ORDER BY act.created_at DESC LIMIT 50',owner):[]
  return good({asOf:now,agents,approvals:owner?await listApprovals(sql,owner,now):[],activity:activity.map(a=>({id:a.id,agentId:a.agent_id,kind:a.kind,createdAt:a.created_at,detail:JSON.parse(a.detail_json) as unknown}))})
 }
 if(!owner)return fail('unauthenticated','Sign in with your operator wallet',401)
 if(path==='/api/agents/challenge'&&method==='POST'){
  if(!address(body.walletAddress))return fail('invalid','walletAddress must be an Ethereum address')
  const challengeId=`proof_${fleetRandom(20)}`,expiresAt=now+600,message=`Hireling agent ownership\nOperator: ${owner}\nAgent wallet: ${getAddress(body.walletAddress)}\nChain: ${sdk.deployment(network).chainId}\nAudience: ${origin}\nNonce: ${challengeId}\nExpires: ${expiresAt}`
  await sql.batch([{query:'INSERT INTO agent_challenges (id,owner,wallet_address,message,expires_at) VALUES (?,?,?,?,?)',params:[challengeId,owner,getAddress(body.walletAddress),message,expiresAt]}]);return good({message,challengeId,expiresAt})
 }
 if(path==='/api/agents'&&method==='GET')return good({agents:(await listManagedAgents(sql,owner)).map(a=>freshness(a,now))})
 if(path==='/api/agents'&&method==='POST'){
  const name=typeof body.name==='string'?body.name.trim():'';if(name.length<1||name.length>80||!address(body.walletAddress))return fail('invalid','Provide a name up to 80 characters and a walletAddress')
  const walletAddress=getAddress(body.walletAddress),privyWalletId=typeof body.privyWalletId==='string'?body.privyWalletId:undefined,providedAppId=typeof body.privyAppId==='string'?body.privyAppId:'',appId=providedAppId || input.appId,kind=privyWalletId?'privy':'external'
  if(kind==='privy'){
   if(!appId||!input.appSecret)return fail('unavailable','Privy ownership verification is unavailable',503)
   if(typeof body.privyAccessToken!=='string'||!await verifyPrivyWallet({token:body.privyAccessToken,appId,appSecret:input.appSecret,operator:owner,walletAddress,walletId:privyWalletId!,now}))return fail('forbidden','Privy user must own both the operator wallet and child wallet',403)
  }else{
   const proof=body.proof as {message?:string;signature?:string}|undefined
   if(!proof?.message||!proof.signature||!reads)return fail('forbidden','An agent wallet ownership challenge and signature are required',403)
   const [challenge]=await sql.all<{id:string}>('SELECT id FROM agent_challenges WHERE message=? AND owner=? AND wallet_address=? AND used=0 AND expires_at>?',proof.message,owner,walletAddress,now)
   if(!challenge||!await reads.verifyMessage({address:walletAddress as Address,message:proof.message,signature:proof.signature as Hex}))return fail('forbidden','Invalid or expired agent ownership proof',403)
   const consumed=await sql.all<{id:string}>('UPDATE agent_challenges SET used=1 WHERE id=? AND used=0 RETURNING id',challenge.id);if(!consumed[0])return fail('forbidden','Ownership proof already used',403)
  }
  const agentId=typeof body.agentId==='string'?body.agentId:undefined
  if(agentId!==undefined&&(!/^\d{1,78}$/.test(agentId)||!reads||(await chainWallet(agentId))?.toLowerCase()!==walletAddress.toLowerCase()))return fail('forbidden','The ERC-8004 agent wallet does not match',403)
  if(kind==='external'&&!agentId)return fail('invalid','Importing an external agent requires its ERC-8004 agentId')
  const agents=await listManagedAgents(sql,owner);if(agents.some(a=>a.walletAddress.toLowerCase()===walletAddress.toLowerCase()))return fail('conflict','This wallet is already managed by this operator',409)
  return good({agent:await createManagedAgent(sql,{owner,name,walletAddress,...(privyWalletId?{privyWalletId,privyAppId:appId}:{}),...(agentId?{agentId}:{}),kind,now})},201)
 }
 const match=/^\/api\/agents\/([^/]+)(?:\/(pair|revoke|identity))?$/.exec(path)
 if(match){
  const agent=await getManagedAgent(sql,match[1]!,owner);if(!agent)return fail('not-found','Agent not found',404)
  if(!match[2]&&method==='GET')return good({agent:freshness(agent,now)})
  if(match[2]==='pair'&&method==='POST'){const pair=await issuePairing(sql,agent,now);return good({agentId:agent.id,code:pair.code,expiresAt:pair.expiresAt,pairUrl:`${origin}/connect?pair=${pair.code}`})}
 if(match[2]==='revoke'&&method==='POST'){await sql.batch([{query:'UPDATE managed_agents SET generation=generation+1,status=\'stopped\' WHERE id=? AND owner=?',params:[agent.id,owner]},{query:'DELETE FROM agent_runtime WHERE agent_id=?',params:[agent.id]},{query:'UPDATE agent_pairings SET used=1 WHERE agent_id=?',params:[agent.id]},{query:'UPDATE oauth_tokens_v2 SET revoked=1 WHERE owner=?',params:[owner]}]);return good({agent:await getManagedAgent(sql,agent.id,owner),revoked:true,privySignerRevocationRequired:true})}
  if(match[2]==='identity'&&method==='POST'){const agentId=String(body.agentId??'');if(!/^\d{1,78}$/.test(agentId)||!reads)return fail('invalid','Valid agentId and chain connection required');if((await chainWallet(agentId))?.toLowerCase()!==agent.walletAddress.toLowerCase())return fail('forbidden','Registry agent wallet does not match this agent',403);await sql.batch([{query:'UPDATE managed_agents SET agent_id=? WHERE id=? AND owner=?',params:[agentId,agent.id,owner]}]);return good({agent:await getManagedAgent(sql,agent.id,owner)})}
 }
 const executionMatch=/^\/api\/approvals\/([^/]+)\/(claim|continue|complete)$/.exec(path)
 if(executionMatch&&method==='POST'){
  const approval=(await listApprovals(sql,owner,now)).find(a=>a.id===executionMatch[1]);if(!approval)return fail('not-found','Approval not found',404)
  if(approval.status!=='approved')return fail('forbidden','Approve this exact operation first',403)
  const payload=approval.payload as {actionHash?:string;chainId?:number;network?:string;boardId?:string;from?:string;tool?:string;args?:Record<string,unknown>;result?:{nonce?:string;transactions?:Array<{to:string;data:string;value:string}>}}
  const [execution]=await sql.all<{claim_id:string;state:string;transaction_hashes_json:string|null;continuation_json:string|null}>('SELECT * FROM approval_execution WHERE approval_id=?',approval.id)
  if(executionMatch[2]==='claim'){
   if(body.actionHash!==payload.actionHash)return fail('forbidden','Frozen action hash mismatch',403)
   if(execution){if(body.claimId!==execution.claim_id)return fail('conflict','This operation is already claimed; resume its original execution journal',409);return good({claimId:execution.claim_id,approval})}
   if(approval.expiresAt<=now)return fail('conflict','This operation approval expired',409)
   const claimId=`claim_${fleetRandom(24)}`;const reserved=await sql.all<{claim_id:string}>('INSERT INTO approval_execution (approval_id,claim_id,state,created_at) VALUES (?,?,\'claimed\',?) ON CONFLICT(approval_id) DO NOTHING RETURNING claim_id',approval.id,claimId,now);if(!reserved[0])return fail('conflict','Operation is already claimed by another execution',409)
   return good({claimId,approval:(await listApprovals(sql,owner,now)).find(a=>a.id===approval.id)})
  }
  if(!execution||body.claimId!==execution.claim_id)return fail('forbidden','Original execution claim is required',403)
  if(executionMatch[2]==='continue'){
   if(approval.expiresAt<=now)return fail('conflict','This approval expired before signing',409)
   if(execution.continuation_json)return good({result:JSON.parse(execution.continuation_json) as unknown,approval})
   if(typeof body.signature!=='string'||!/^0x[a-fA-F0-9]+$/.test(body.signature)||!input.runTool||!payload.from||!payload.boardId||!payload.args)return fail('invalid','A signed frozen typed operation is required')
   let tool:string,args:Record<string,unknown>
   if(payload.tool==='select_worker'){tool='submit_selection';args={taskId:payload.args.taskId,nonce:payload.result?.nonce,signature:body.signature}}
   else if(payload.tool==='prepare_activation'){tool='build_activation';args={taskId:payload.args.taskId,budgetSignature:body.signature}}
   else return fail('forbidden','This typed operation cannot use the continuation endpoint',403)
   const result=await input.runTool(tool,args,payload.from,payload.boardId);if(!result.ok)return fail(result.code,result.message,result.code==='forbidden'?403:409)
   await sql.batch([{query:'UPDATE approval_execution SET continuation_json=? WHERE approval_id=? AND claim_id=? AND continuation_json IS NULL',params:[JSON.stringify(result.result),approval.id,execution.claim_id]}]);return good({result:result.result,approval:(await listApprovals(sql,owner,now)).find(a=>a.id===approval.id)})
  }
  if(execution.state==='completed')return good({approval,completed:true})
  if(!reads||payload.chainId!==sdk.deployment(network).chainId||payload.network!==network||!payload.from)return fail('unavailable','Chain verification for this approval is unavailable',503)
  const continuation=execution.continuation_json?JSON.parse(execution.continuation_json) as {transactions?:Array<{to:string;data:string;value:string}>}:undefined
  const transactions=continuation?.transactions??payload.result?.transactions??[]
  const hashes=body.transactionHashes;if(!Array.isArray(hashes)||hashes.length!==transactions.length||!hashes.every(h=>typeof h==='string'&&/^0x[a-fA-F0-9]{64}$/.test(h))||new Set(hashes).size!==hashes.length)return fail('invalid','One unique successful transaction receipt is required for each frozen step')
  if(transactions.length===0&&(!execution.continuation_json||payload.tool!=='select_worker'))return fail('invalid','There is no confirmed transaction or verified selection to complete')
  for(let i=0;i<transactions.length;i++){const frozen=transactions[i]!,hash=hashes[i] as Hex;const [transaction,receipt]=await Promise.all([reads.getTransaction({hash}),reads.getTransactionReceipt({hash})]);if(receipt.status!=='success'||transaction.from.toLowerCase()!==payload.from.toLowerCase()||transaction.to?.toLowerCase()!==frozen.to.toLowerCase()||transaction.input!==frozen.data||transaction.value!==BigInt(frozen.value??'0'))return fail('forbidden','A receipt does not match the exact frozen wallet step',403)}
  await sql.batch([{query:'UPDATE approval_execution SET state=\'completed\',transaction_hashes_json=? WHERE approval_id=? AND claim_id=?',params:[JSON.stringify(hashes),approval.id,execution.claim_id]}]);return good({approval:(await listApprovals(sql,owner,now)).find(a=>a.id===approval.id),completed:true})
 }
 if(path==='/api/approvals'&&method==='GET')return good({approvals:await listApprovals(sql,owner,now)})
 const decision=/^\/api\/approvals\/([^/]+)\/approve$/.exec(path)
 if(decision&&method==='POST'){if(body.decision!=='approve'&&body.decision!=='reject')return fail('invalid','decision must be approve or reject');const approvals=await listApprovals(sql,owner,now);const pending=approvals.find(a=>a.id===decision[1]);if(!pending)return fail('not-found','Approval not found',404);if(pending.status!=='pending')return fail('conflict','Approval expired or already decided',409);const approval=await decideApproval(sql,decision[1]!,owner,body.decision,now);return good({approval})}
 return fail('not-found','No such fleet route',404)
}
