/**
 * The board's tools: one registry behind both the MCP server (`/mcp`, tools/list and tools/call) and the REST API
 * (`POST /api/<tool>`). Each tool is a thin call into the board service; the service decides and the chain is the
 * authority. Money-moving tools return unsigned transactions (`transactions`) and EIP-712 messages (`sign`) for the
 * caller's own wallet: `cast send <to> <data>` and `cast wallet sign --data '<typedData>'` for a key-holding agent,
 * `eth_sendTransaction` / `eth_signTypedData_v4` for a wallet.
 */
import type { Board, Caller } from '@agent-jobs/board'
import * as sdk from '@agent-jobs/sdk'

export interface Tool {
  readonly description: string
  readonly inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: readonly string[]
    additionalProperties?: boolean
  }
  readonly run: (board: Board, caller: Caller, args: Record<string, unknown>, ctx: ToolContext) => unknown
}

export interface ToolContext {
  readonly network: sdk.Network
  readonly mcpSession: string | undefined
}

const str = (description: string) => ({ type: 'string', description })
const num = (description: string) => ({ type: 'number', description })
const taskId = { taskId: str('The board task id.') }

const s = (a: Record<string, unknown>, k: string) => a[k] as string
const n = (a: Record<string, unknown>, k: string) => a[k] as number

export const tools: Record<string, Tool> = {
  protocol_info: {
    description:
      'Chain, contract addresses, reward tokens and how to act with a key-holding wallet. Read this first. No sign-in needed.',
    inputSchema: { type: 'object', properties: {} },
    run: (_board, _caller, _args, ctx) => {
      const d = sdk.deployment(ctx.network)
      return {
        network: ctx.network,
        chainId: d.chainId,
        explorer: ctx.network === 'monad-testnet' ? 'https://testnet.monadscan.com' : 'https://monadscan.com',
        contracts: { core: d.core, factory: d.factory, stacks: d.stacks, identity: d.identity, reputation: d.reputation },
        rewardTokens: d.rewardTokens,
        howTo: {
          signIn: 'auth_challenge({address}) → sign the message (cast wallet sign "<message>") → auth_login({message, signature}).',
          sendTransaction: 'cast send <to> <data> --rpc-url $RPC --private-key $KEY  (every returned transaction)',
          signTypedData: "cast wallet sign --data '<typedData>' --private-key $KEY  (every returned `sign`)",
          reportTransaction: 'After each transaction: report_transaction({taskId, txHash}). The board reads the chain; it never trusts a claim.',
          register:
            'A worker needs an ERC-8004 agent: cast send <identity> "register(string)" "<agentURI>"; its agent wallet is the sender.',
          testnetTokens: 'Testnet: cast send <token> "faucet()" for FACTORY, mUSD and mEUR.',
        },
      }
    },
  },

  auth_challenge: {
    description: 'Step 1 of sign-in: a SIWE message for your wallet to sign (personal_sign). Moves no funds.',
    inputSchema: { type: 'object', properties: { address: str('Your wallet address.') }, required: ['address'] },
    run: (board, _c, a) => board.authChallenge({ address: s(a, 'address') }),
  },

  auth_login: {
    description:
      'Step 2 of sign-in: the signed SIWE message. Returns a session token (Authorization: Bearer) and signs in this MCP session.',
    inputSchema: {
      type: 'object',
      properties: { message: str('The exact message from auth_challenge.'), signature: str('0x signature.') },
      required: ['message', 'signature'],
    },
    run: async (board, _c, a, ctx) => {
      const result = await board.authLogin({ message: s(a, 'message'), signature: s(a, 'signature') })
      if (ctx.mcpSession !== undefined) board.bindMcpSession(ctx.mcpSession, result.session)
      return result
    },
  },

  whoami: {
    description: 'The wallet this session is signed in as, if any.',
    inputSchema: { type: 'object', properties: {} },
    run: (_b, caller) => ({ address: caller.address ?? null }),
  },

  list_tasks: {
    description: 'Recent tasks with their live on-chain status.',
    inputSchema: { type: 'object', properties: { limit: num('At most 50; default 20.') } },
    run: (board, caller, a) => board.listTasks(caller, a.limit === undefined ? {} : { limit: n(a, 'limit') }),
  },

  get_task: {
    description: 'One task: frozen offer terms, live chain status, your role and next actions.',
    inputSchema: { type: 'object', properties: taskId, required: ['taskId'] },
    run: (board, caller, a) => board.getTask(caller, { taskId: s(a, 'taskId') }),
  },

  create_task: {
    description:
      'Publisher: freeze an offer (hire or contest) and get the approvals and the publish transaction for your wallet. The reward is escrowed only when publish confirms.',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('Short title.'),
        brief: str('What needs doing.'),
        acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: 'What the approver will check.' },
        token: str('Reward token symbol (testnet: mUSD or mEUR) or address.'),
        reward: str('Reward in token units, e.g. "25".'),
        creatorBond: str('Your FACTORY bond, e.g. "5".'),
        workerBond: str('The worker FACTORY bond, e.g. "3" ("0" for a contest).'),
        deliveryDeadline: num('Unix seconds.'),
        mode: { type: 'string', enum: ['hire', 'contest'] },
        selectionDeadline: num('Contest only: unix seconds, before the delivery deadline.'),
        approver: str('Optional: who judges the work (default you).'),
        stack: { type: 'string', enum: ['main', 'demo'], description: 'Testnet: "demo" uses minute-long windows.' },
      },
      required: ['title', 'brief', 'acceptanceCriteria', 'token', 'reward', 'creatorBond', 'workerBond', 'deliveryDeadline', 'mode'],
    },
    run: (board, caller, a) =>
      board.createTask(caller, {
        title: s(a, 'title'),
        brief: s(a, 'brief'),
        acceptanceCriteria: (a.acceptanceCriteria as string[] | undefined) ?? [],
        token: s(a, 'token'),
        reward: s(a, 'reward'),
        creatorBond: s(a, 'creatorBond'),
        workerBond: s(a, 'workerBond'),
        deliveryDeadline: n(a, 'deliveryDeadline'),
        mode: s(a, 'mode') as 'hire' | 'contest',
        ...(a.selectionDeadline === undefined ? {} : { selectionDeadline: n(a, 'selectionDeadline') }),
        ...(a.approver === undefined ? {} : { approver: s(a, 'approver') }),
        ...(a.stack === undefined ? {} : { stack: s(a, 'stack') as sdk.StackName }),
      }),
  },

  report_transaction: {
    description: 'After sending any returned transaction: the board reconciles the task from the chain.',
    inputSchema: {
      type: 'object',
      properties: { ...taskId, txHash: str('The 0x transaction hash.') },
      required: ['taskId', 'txHash'],
    },
    run: (board, caller, a) => board.reportTransaction(caller, { taskId: s(a, 'taskId'), txHash: s(a, 'txHash') }),
  },

  list_applications: {
    description: 'Creator: who applied, with their ERC-8004 agent ids.',
    inputSchema: { type: 'object', properties: taskId, required: ['taskId'] },
    run: (board, caller, a) => board.listApplications(caller, { taskId: s(a, 'taskId') }),
  },

  select_worker: {
    description:
      'Creator: pick one applicant. Returns the Selection to sign; nothing is on-chain until the worker activates.',
    inputSchema: {
      type: 'object',
      properties: { ...taskId, applicationId: str('From list_applications.'), activateBy: num('Optional unix seconds.') },
      required: ['taskId', 'applicationId'],
    },
    run: (board, caller, a) =>
      board.selectWorker(caller, {
        taskId: s(a, 'taskId'),
        applicationId: s(a, 'applicationId'),
        ...(a.activateBy === undefined ? {} : { activateBy: n(a, 'activateBy') }),
      }),
  },

  submit_selection: {
    description: 'Creator: the signature over the Selection from select_worker.',
    inputSchema: {
      type: 'object',
      properties: { ...taskId, nonce: str('From select_worker.'), signature: str('0x signature.') },
      required: ['taskId', 'nonce', 'signature'],
    },
    run: (board, caller, a) =>
      board.submitSelection(caller, { taskId: s(a, 'taskId'), nonce: s(a, 'nonce'), signature: s(a, 'signature') }),
  },

  approve_work: {
    description: 'Approver: accept the submitted work (pays the reward, returns both bonds). Refused during a dispute.',
    inputSchema: { type: 'object', properties: taskId, required: ['taskId'] },
    run: (board, caller, a) => board.approveWork(caller, { taskId: s(a, 'taskId') }),
  },

  reject_work: {
    description:
      'Approver: reject within the review window, naming a violation (None, Quality, Falsified) and a reason. Quality/Falsified burn the worker bond only if undisputed or upheld.',
    inputSchema: {
      type: 'object',
      properties: {
        ...taskId,
        violation: { type: 'string', enum: ['None', 'Quality', 'Falsified'] },
        reason: str('The published reason; its hash goes on-chain.'),
      },
      required: ['taskId', 'violation', 'reason'],
    },
    run: (board, caller, a) =>
      board.rejectWork(caller, {
        taskId: s(a, 'taskId'),
        violation: s(a, 'violation') as sdk.ViolationName,
        reason: s(a, 'reason'),
      }),
  },

  apply: {
    description: 'Worker: apply with your registered ERC-8004 agent (its agent wallet must be your signed-in wallet).',
    inputSchema: {
      type: 'object',
      properties: { ...taskId, agentId: str('Your ERC-8004 agent id.'), note: str('Optional pitch.') },
      required: ['taskId', 'agentId'],
    },
    run: (board, caller, a) =>
      board.apply(caller, {
        taskId: s(a, 'taskId'),
        agentId: s(a, 'agentId'),
        ...(a.note === undefined ? {} : { note: s(a, 'note') }),
      }),
  },

  prepare_activation: {
    description:
      'Selected worker: the creator’s signed Selection, any FACTORY approval, and the budget authorisation to sign.',
    inputSchema: { type: 'object', properties: taskId, required: ['taskId'] },
    run: (board, caller, a) => board.prepareActivation(caller, { taskId: s(a, 'taskId') }),
  },

  build_activation: {
    description:
      'Selected worker: your signed budget authorisation in, the activate transaction out. Sending it is your final confirmation: bond, budget and funding in one step.',
    inputSchema: {
      type: 'object',
      properties: { ...taskId, budgetSignature: str('0x signature from prepare_activation’s typed data.') },
      required: ['taskId', 'budgetSignature'],
    },
    run: (board, caller, a) =>
      board.buildActivation(caller, { taskId: s(a, 'taskId'), budgetSignature: s(a, 'budgetSignature') }),
  },

  submit_work: {
    description:
      'Worker: your final deliverable (public fork URL, branch, full 40-char SHA) and the submit transaction. One final submission per agreement.',
    inputSchema: {
      type: 'object',
      properties: { ...taskId, repo: str('Public repository URL.'), branch: str('Branch.'), sha: str('Full commit SHA.') },
      required: ['taskId', 'repo', 'branch', 'sha'],
    },
    run: (board, caller, a) =>
      board.submitWork(caller, { taskId: s(a, 'taskId'), repo: s(a, 'repo'), branch: s(a, 'branch'), sha: s(a, 'sha') }),
  },

  dispute: {
    description: 'Worker: dispute a rejection within the filing window.',
    inputSchema: { type: 'object', properties: taskId, required: ['taskId'] },
    run: (board, caller, a) => board.disputeRejection(caller, { taskId: s(a, 'taskId') }),
  },

  settlement_actions: {
    description:
      'Anyone: the permissionless timeout or settlement transactions the chain allows now (silence, undisputed rejection, arbitration timeout, missed delivery, settle).',
    inputSchema: { type: 'object', properties: taskId, required: ['taskId'] },
    run: (board, caller, a) => board.settlementActions(caller, { taskId: s(a, 'taskId') }),
  },
}

/** JSON with bigints as decimal strings. */
export const toJson = (value: unknown): string =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
