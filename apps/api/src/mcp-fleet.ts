import { fleetHash, fleetRandom, getManagedAgent, listApprovals, listManagedAgents, type FleetSql } from '@agent-jobs/board'
import type { OAuthGrant } from './oauth.ts'
import type { BoardReply } from './board.ts'

export const fleetTools={
 list_managed_agents:{description:'List the named agents explicitly granted by this OAuth connection. Wallet ownership, worker health and economic authority remain separate.',inputSchema:{type:'object',properties:{}}},
 prepare_agent_onboarding:{description:'Start onboarding a hiring or worker agent. Follow the owner-authenticated website review, then pair the local companion from your coding agent chat.',inputSchema:{type:'object',properties:{name:{type:'string'}}}},
 agent_pairing_status:{description:'Get pairing status without revealing pairing credentials or private keys.',inputSchema:{type:'object',properties:{managedAgentId:{type:'string'}},required:['managedAgentId']}},
 agent_health:{description:'Get signed companion heartbeat freshness. A healthy process does not establish funding, delivery or paid acceptance.',inputSchema:{type:'object',properties:{managedAgentId:{type:'string'}},required:['managedAgentId']}},
 list_approvals:{description:'Discover exact owner approvals for your granted agents. Approval authorizes an action; it never proves a chain transaction or acceptance of work.',inputSchema:{type:'object',properties:{}}},
}
const READ_TOOLS=new Set(['protocol_info','whoami','task_index','fee_quote','pledged_by','sponsor_status','sponsor_operation','mining_proof','list_managed_agents','prepare_agent_onboarding','agent_pairing_status','agent_health','list_approvals'])
const HIRE_TOOLS=new Set(['create_task','request_quotes','pick_quote','select_worker','submit_selection','publish_transactions','cancel_task','approve_work','reject_work','budget_grant_prepare','budget_grant_confirm','revoke_budget','top_up','create_board','update_board'])
const WORK_TOOLS=new Set(['apply','submit_quote','prepare_activation','build_activation','submit_work','dispute','add_statement','prepare_agent_profile','prepare_directory_enrollment','enroll_directory','prepare_heartbeat','post_heartbeat','prepare_service_ad','publish_service_ad','prepare_revoke_service_ad','revoke_service_ad'])
const SHARED_TOOLS=new Set(['report_transaction','stake','request_unstake','withdraw_stake','settlement_actions','collect_actions','report_operation','upgrade_account','sponsor_prepare','sponsor_confirm','sponsor_revoke'])
export const requiredToolScope=(name:string):string|undefined=>name.startsWith('list_')||name.startsWith('get_')||READ_TOOLS.has(name)?'hireling:read':HIRE_TOOLS.has(name)?'hireling:hire':WORK_TOOLS.has(name)?'hireling:work':SHARED_TOOLS.has(name)?'hireling:write':undefined
export const permittedTool=(grant:OAuthGrant,name:string)=>{const required=requiredToolScope(name),scopes=grant.scope.split(' ');return required!==undefined&&(required==='hireling:write'?(scopes.includes('hireling:hire')||scopes.includes('hireling:work')):scopes.includes(required))}
export async function mcpFleetTool(input:{sql:FleetSql;grant:OAuthGrant;tool:string;args:Record<string,unknown>;origin:string;now:number}):Promise<BoardReply|undefined>{
 const {sql,grant,tool,args,origin,now}=input
 if(!Object.hasOwn(fleetTools,tool))return undefined
 if(tool==='list_managed_agents')return {ok:true,result:{agents:(await listManagedAgents(sql,grant.owner)).filter(a=>grant.agentIds.includes(a.id)).map(a=>({...a,status:a.lastHeartbeatAt&&now-a.lastHeartbeatAt>90&&['healthy','ready','launched'].includes(a.status)?'stale':a.status}))}}
 if(tool==='prepare_agent_onboarding')return {ok:true,result:{onboardingUrl:`${origin}/connect?onboard=agent`,instructions:'Create or import an agent in the website, explicitly approve wallet/identity actions, then pair the Node companion. Connect OAuth again to grant the new agent.',automaticWalletAuthority:false}}
 if(tool==='list_approvals')return {ok:true,result:{approvals:(await listApprovals(sql,grant.owner,now)).filter(a=>grant.agentIds.includes(a.agentId))}}
 const id=typeof args.managedAgentId==='string'?args.managedAgentId:''
 const agent=grant.agentIds.includes(id)?await getManagedAgent(sql,id,grant.owner):undefined
 if(!agent)return {ok:false,code:'forbidden',message:'This agent is not granted to this OAuth connection'}
 return {ok:true,result:{agentId:agent.id,status:agent.status,generation:agent.generation,lastHeartbeatAt:agent.lastHeartbeatAt??null,stale:!agent.lastHeartbeatAt||now-agent.lastHeartbeatAt>90,automaticWalletAuthority:false}}
}
/** Queue immutable unsigned wallet output; idempotent repeats refer to the original review. */
export async function queueToolApproval(input:{sql:FleetSql;owner:string;agentId:string;tool:string;args:Record<string,unknown>;result:unknown;now:number;chainId:number;network:string;boardId:string;walletAddress:string}):Promise<{approvalId:string;operationId:string;status:string}|undefined>{
 const result=input.result as {transactions?:unknown[];sign?:unknown}|null
 if(!result||(!Array.isArray(result.transactions)||result.transactions.length===0)&&result.sign===undefined)return undefined
 const frozen={tool:input.tool,args:input.args,result:input.result,chainId:input.chainId,network:input.network,boardId:input.boardId,from:input.walletAddress}
 const payload={...frozen,actionHash:await fleetHash(JSON.stringify(frozen))}
 const operationId=`mcp_${await fleetHash(JSON.stringify({agentId:input.agentId,...payload}))}`
 await input.sql.batch([{query:"UPDATE agent_approvals SET status='expired' WHERE owner=? AND status='pending' AND expires_at<=?",params:[input.owner,input.now]}])
 const existing=await input.sql.all<{id:string;status:string}>('SELECT id,status FROM agent_approvals WHERE operation_id=?',operationId);if(existing[0])return {approvalId:existing[0].id,operationId,status:existing[0].status}
 const id=`approval_${fleetRandom(12)}`
 await input.sql.batch([{query:'INSERT OR IGNORE INTO agent_approvals (id,agent_id,owner,action,payload_json,created_at,expires_at,status,operation_id) VALUES (?,?,?,?,?,?,?,\'pending\',?)',params:[id,input.agentId,input.owner,input.tool,JSON.stringify(payload),input.now,input.now+600,operationId]}])
 const persisted=await input.sql.all<{id:string;status:string}>('SELECT id,status FROM agent_approvals WHERE operation_id=?',operationId)
 return {approvalId:persisted[0]!.id,operationId,status:persisted[0]!.status}
}
