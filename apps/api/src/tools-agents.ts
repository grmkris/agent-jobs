/** Management tools are executed by the reserved object, never by a tenant board. */
const object = { type: 'object', properties: {} }

export const agentTools = {
  x402_pay: {
    description: 'Sign an x402 v2 exact USDC payment from this agent wallet on testnet (5 USDC per payment, 20 USDC per rolling day). Send the returned PAYMENT-SIGNATURE header to the resource yourself. Retry the same operationKey for the same nonce and signature.',
    inputSchema: { type: 'object', properties: {
      paymentRequired: { anyOf: [{ type: 'object' }, { type: 'string' }], description: 'Decoded PAYMENT-REQUIRED object or its base64 header.' },
      resource: { type: 'string', description: 'Optional resource URL; must match PAYMENT-REQUIRED.' },
    }, required: ['paymentRequired'] },
  },
  agent_status: { description: 'Read this agent\'s state, last MCP activity, allowances and revocation receipts.', inputSchema: object },
  list_approvals: { description: 'Read this agent\'s operator approvals. The operator decides them on the website.', inputSchema: object },
  sweep_earnings: { description: 'Move the whole balance of a configured token to your operator wallet, under the pinned sweep grant.', inputSchema: { type: 'object', properties: { token: { type: 'string', description: 'Configured reward token or SIDE address.' } }, required: ['token'] } },
  check_operation: { description: 'Reconcile the original action by operationId after any interrupted send. It never creates a new send.', inputSchema: { type: 'object', properties: { operationId: { type: 'string' } }, required: ['operationId'] } },
  get_supported_permissions: { description: 'ERC-7715 wallet_getSupportedExecutionPermissions: the permission types this board grants, its chain and the expiry rule.', inputSchema: object },
  get_permissions: { description: 'This agent\'s permissions from its operator: id, status, expiry, standing rule, and what each allows.', inputSchema: object },
  request_permissions: {
    description: 'Ask your operator for one ERC-7715 permission (erc20-token-periodic, erc20-token-allowance, or sidequest:contract-call for one exact call). '
      + 'A live standing permission that covers it returns granted at once; otherwise the result is an approval and the operator signs it in Explore. '
      + 'Retry the same operationKey to read the decision; a granted result carries permissionId and the ERC-7710 context.',
    inputSchema: { type: 'object', properties: {
      permission: { type: 'object', description: 'One ERC-7715 request: {chainId, to: this agent wallet, from?: operator, permission: {type, isAdjustmentAllowed?, data}, rules: [{type: "expiry", data: {timestamp}}]}. Token types need data.recipient.' },
      standing: { type: 'boolean', description: 'Ask the operator to keep it as a rule: later requests it covers are granted without asking again.' },
    }, required: ['permission'] },
  },
  use_permission: {
    description: 'Redeem a live permission through the relay: a token transfer within its amount to its recipient, or the one approved exact call.',
    inputSchema: { type: 'object', properties: {
      permissionId: { type: 'string', description: 'From request_permissions or get_permissions.' },
      transfer: { type: 'object', properties: { amount: { type: 'string', description: 'Base units as a decimal string.' } }, description: 'Token permissions only.' },
    }, required: ['permissionId'] },
  },
  advertise_service: {
    description: 'List one service in the worker directory for 24 hours, so hirers find you; renew it daily with a new operationKey. '
      + 'Enrolls this agent first if it is not listed. At most ten services. Discovery only: it never admits you to a job or moves money.',
    inputSchema: { type: 'object', properties: {
      service: { type: 'object', description: 'serviceId (lowercase slug), name, description, inputs, outputs, turnaroundSeconds, price {model fixed|per-unit|quote|free/testnet, amountBaseUnits decimal string, token address}.' },
    }, required: ['service'] },
  },
  withdraw_service: {
    description: 'Take one service down (serviceId), or without one leave the directory with every service. Your operator can do the same from Explore.',
    inputSchema: { type: 'object', properties: { serviceId: { type: 'string', description: 'The service to take down; omit to leave the directory.' } } },
  },
  revoke_permission: { description: 'Give a permission back: Sidequest stops sponsoring it. Only the operator can disable it on-chain.', inputSchema: { type: 'object', properties: { permissionId: { type: 'string' } }, required: ['permissionId'] } },
}
