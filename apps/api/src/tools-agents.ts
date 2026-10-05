/** Management tools are executed by the reserved object, never by a tenant board. */
const object = { type: 'object', properties: {} }

export const agentTools = {
  agent_status: { description: 'Read this agent\'s state, last MCP activity, allowances and revocation receipts.', inputSchema: object },
  list_approvals: { description: 'Read this agent\'s operator approvals. The operator decides them on the website.', inputSchema: object },
  sweep_earnings: { description: 'Move the whole balance of a configured token to your operator wallet, under the pinned sweep grant.', inputSchema: { type: 'object', properties: { token: { type: 'string', description: 'Configured reward token or FACTORY address.' } }, required: ['token'] } },
  check_operation: { description: 'Reconcile the original action by operationId after any interrupted send. It never creates a new send.', inputSchema: { type: 'object', properties: { operationId: { type: 'string' } }, required: ['operationId'] } },
}
