import { ADMISSION_OBJECT_NAME, SPONSOR_OBJECT_NAME, sponsorToolNames, AdmissionRateLimits, admissionFailure, Board as BoardService, BoardError, fromDurableObjectSql, parseHostedAdmission, SessionDesk, type RelayRequest, migrateAgentSchema, retireFleetSchema, AgentStore, AgentSigning, AgentExecutor, SponsorDesk } from '@agent-jobs/board'
import { fromD1 } from '@agent-jobs/indexer'
import * as sdk from '@agent-jobs/sdk'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import { type Hex, getAddress, decodeFunctionData, isAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { type ToolContext, toJson, tools } from './tools.ts'
import { admissionIdentity, admissionIpHash, enforceHostedRate, needsWriteRate, type AdmissionCall, type AdmissionNamespace, type AdmissionReply } from './admission-rate.ts'
import { collectSnapshot } from './collect-index.ts'
import { r2MiningSource, type EpochBucket } from './mining.ts'
import { oauthRoute, resolveOAuth } from './oauth.ts'
import type { OAuthGrant } from './oauth.ts'
import { permittedTool, requiredToolScope } from './mcp-policy.ts'
import { resourceBoard } from './oauth-validation.ts'

/** What the Worker passes on every call: the tool, its arguments, the caller's credentials and the runtime env. */
export interface BoardCall {
  readonly tool: string
  readonly args: Record<string, unknown>
  readonly bearer?: string | undefined
  readonly mcpSession?: string | undefined
  /** The signed-in wallet, when the Worker already resolved it from the shared session store (ADR-0008). */
  readonly caller?: string | undefined
  readonly ip?: string | undefined
  readonly agentAuth?: { readonly agentId: string; readonly resource: string }
  readonly env: {
    readonly network: sdk.Network
    readonly boardId: string
    readonly rpcUrl: string
    readonly domain: string
    readonly uri: string
    readonly manifestBaseUrl: string
    /** Jev's model endpoint; an empty key means "unscreened". */
    readonly screening: { readonly baseUrl: string; readonly apiKey: string; readonly model: string }
    /** Attester and relay keys and the GitHub App; empty means evidence is unavailable. */
    readonly attesterKey: string
    readonly relayKey: string
    readonly github: { readonly appId: string; readonly privateKeyPem: string; readonly installationId: string }
  }
}

const key32 = (k: string) => /^0x[0-9a-fA-F]{64}$/.test(k)

export type BoardReply =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly retryAfter?: number; readonly reason?: string }

/**
 * One Durable Object per hosted board (spec §5). It owns the board's SQLite (tasks, applications, selections,
 * sessions, operation records) and runs every tool single-threaded, so two requests never interleave inside one
 * board. Chain reads and verifications go to the RPC the Worker passes in.
 */
export default class Board extends Cloudflare.DurableObject<Board>()(
  'Board',
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState
    const runtimeEnv = yield* Cloudflare.WorkerEnvironment
    let service: { key: string; board: BoardService } | undefined
    let limits: AdmissionRateLimits | undefined
    // Serialize across awaits and service/config replacement, including callers from different tenants.
    let callQueue: Promise<unknown> = Promise.resolve()

    const boardFor = (env: BoardCall['env']): BoardService => {
      const key = JSON.stringify(env)
      if (service?.key === key) return service.board
      const contexts: Partial<Record<sdk.StackName, sdk.Ctx>> = {}
      for (const name of ['main', 'demo', 'fast'] as const) {
        if (sdk.deployment(env.network).stacks[name] !== undefined) contexts[name] = sdk.context(env.network, name, env.rpcUrl)
      }
      const board = new BoardService(fromDurableObjectSql(state.storage.sql.raw, write => state.raw.storage.transactionSync(write)), {
        network: env.network,
        contexts,
        domain: env.domain,
        uri: env.uri,
        manifestBaseUrl: env.manifestBaseUrl,
        collectSnapshot: wallet => collectSnapshot(fromD1((runtimeEnv as Record<string, unknown>).Database as never), contexts.main!, wallet, Math.floor(Date.now() / 1000)),
        miningSource: r2MiningSource((runtimeEnv as Record<string, unknown>).Manifests as EpochBucket | undefined),
        ...(env.screening.apiKey === '' ? {} : { screening: env.screening }),
        ...(key32(env.relayKey) ? { relay: { account: privateKeyToAccount(env.relayKey as `0x${string}`), rpcUrl: env.rpcUrl } } : {}),
        relaySend: async request => {
          const namespace = (runtimeEnv as Record<string, unknown>).Board as { idFromName(name: string): { toString(): string }; get(id: unknown): { relay(req: { env: BoardCall['env']; request: RelayRequest }): Promise<string> } }
          const id = namespace.idFromName(SPONSOR_OBJECT_NAME)
          if (id.toString() === state.id.toString()) return board.relayTransaction(request)
          const reply = JSON.parse(await namespace.get(id).relay({ env, request })) as BoardReply
          if (!reply.ok) throw new BoardError('chain', reply.message)
          return reply.result as Hex
        },
        ...(key32(env.attesterKey) && key32(env.relayKey)
          ? {
              evidence: {
                attester: privateKeyToAccount(env.attesterKey as `0x${string}`),
                relay: privateKeyToAccount(env.relayKey as `0x${string}`),
                rpcUrl: env.rpcUrl,
                ...(env.github.appId === '' ? {} : { github: env.github }),
              },
            }
          : {}),
      })
      service = { key, board }
      return board
    }

    const authenticatedAgent = async (req: BoardCall): Promise<OAuthGrant> => {
      if (req.agentAuth === undefined) throw new BoardError('forbidden', 'Agent authentication is required')
      const bindings = runtimeEnv as Record<string, unknown>
      const namespace = bindings.Board as { idFromName(name: string): unknown; get(id: unknown): { oauthResolve(req: { resource: string; bearer?: string }): Promise<string> } }
      const grant = JSON.parse(await namespace.get(namespace.idFromName(SPONSOR_OBJECT_NAME)).oauthResolve({ resource: req.agentAuth.resource, ...(req.bearer === undefined ? {} : { bearer: req.bearer }) })) as OAuthGrant | null
      const origin = new URL(req.agentAuth.resource).origin
      if (grant === null || !grant.agentIds.includes(req.agentAuth.agentId) || grant.chainId !== sdk.deployment(req.env.network).chainId
        || resourceBoard(grant.resource, origin) !== req.env.boardId || !permittedTool(grant, req.tool, true)
        || req.caller?.toLowerCase() !== grant.address.toLowerCase()) throw new BoardError('forbidden', 'Agent scope, board or wallet mismatch')
      return grant
    }

    return Effect.succeed({
        agentExecute: (req: { env: BoardCall['env']; tool: string; args: Record<string, unknown>; agentId: string; resource: string; bearer?: string; ip?: string }) => Effect.promise(() => {
          const result = callQueue.then(async () => {
            try {
              const bindings = runtimeEnv as Record<string, unknown>
              const namespace = bindings.Board as { idFromName(name: string): { toString(): string }; get(id: unknown): { call(req: BoardCall): Promise<string>; verifyAgentSigning(req: BoardCall & { typedData: string }): Promise<string> } }
              if (namespace.idFromName(SPONSOR_OBJECT_NAME).toString() !== state.id.toString() || req.env.network !== bindings.NETWORK) throw new BoardError('forbidden', 'management object identity mismatch')
              const sql = fromDurableObjectSql(state.storage.sql.raw, write => state.raw.storage.transactionSync(write))
              migrateAgentSchema(sql)
              const grant = await resolveOAuth(sql, req.bearer, req.resource, Math.floor(Date.now() / 1000))
              if (grant === undefined || !grant.agentIds.includes(req.agentId) || !permittedTool(grant, req.tool)
                || resourceBoard(req.resource, new URL(req.resource).origin) !== req.env.boardId) throw new BoardError('forbidden', 'This connection does not grant this agent, tool or board')
              const agents = new AgentStore(sql, () => Math.floor(Date.now() / 1000))
              const agent = agents.get(req.agentId)
              agents.touch(agent.id)
              const { operationKey, managedAgentId: _managedAgentId, ...args } = req.args
              if (requiredToolScope(req.tool) !== 'hireling:read' && typeof operationKey !== 'string') throw new BoardError('invalid', 'Every write requires a stable operationKey; retry with the same key')
              if (req.tool === 'apply' || req.tool === 'submit_quote') {
                if (args.agentId !== undefined && args.agentId !== agent.agent_id) throw new BoardError('forbidden', 'Use this connection\'s registered agentId')
                args.agentId = agent.agent_id
              }
              const ctx = sdk.context(req.env.network, 'main', req.env.rpcUrl)
              const signerKey = typeof bindings.PRIVY_SIGNER_KEY === 'string' ? bindings.PRIVY_SIGNER_KEY : ''
              const appSecret = typeof bindings.PRIVY_APP_SECRET === 'string' ? bindings.PRIVY_APP_SECRET : ''
              if (signerKey === '' || signerKey === 'unset' || appSecret === '' || appSecret === 'unset' || !key32(req.env.relayKey)) throw new BoardError('unavailable', 'Hosted agent signing is unavailable')
              const provider = new sdk.PrivyServer({ appId: String(bindings.PRIVY_APP_ID ?? ''), appSecret, sign: await sdk.p256AuthorizationSigner(signerKey) })
              const signing = new AgentSigning(sql, ctx, provider, () => Math.floor(Date.now() / 1000))
              const auth = { agentId: agent.id, resource: req.resource }
              const prepare = (tool: string, input: Record<string, unknown>): BoardCall => ({ tool, args: input, env: req.env, caller: agent.address!, agentAuth: auth, ...(req.ip === undefined ? {} : { ip: req.ip }), ...(req.bearer === undefined ? {} : { bearer: req.bearer }) })
              const tenant = namespace.get(namespace.idFromName(req.env.boardId))
              const executor = new AgentExecutor({ sql, now: () => Math.floor(Date.now() / 1000), context: ctx, signing,
                sponsor: new SponsorDesk({ sql, ctx, now: () => Math.floor(Date.now() / 1000), relay: { account: privateKeyToAccount(req.env.relayKey as Hex), rpcUrl: req.env.rpcUrl }, fail: (code, message) => new BoardError(code, message) }),
                prepareTool: async input => {
                  const reply = JSON.parse(await tenant.call(prepare(input.tool, input.args))) as BoardReply
                  if (!reply.ok) throw new BoardError(reply.code as never, reply.message)
                  return reply.result as import('@agent-jobs/board').AgentPreparedCall
                },
                verifyToolSigning: input => tenant.verifyAgentSigning({ ...prepare(input.tool, input.args), typedData: input.typedData }),
              })
              return toJson({ ok: true, result: await executor.execute({ agentId: agent.id, boardId: req.env.boardId, tool: req.tool, args, operationKey: typeof operationKey === 'string' ? operationKey : crypto.randomUUID() }) })
            } catch (error) {
              return toJson({ ok: false, code: error instanceof BoardError ? error.code : 'unavailable', message: error instanceof BoardError ? error.message : 'Hosted agent execution is unavailable' })
            }
          })
          callQueue = result.catch(() => undefined)
          return result
        }),
        verifyAgentSigning: (req: BoardCall & { typedData: string }) => Effect.promise(async () => {
          await authenticatedAgent(req)
          return boardFor(req.env).verifyAgentSigning({ address: getAddress(req.caller!) }, { tool: req.tool, args: req.args, typedData: req.typedData })
        }),
        /** OAuth lives beside the agent and sponsor journals, under this object's single-writer queue. */
        oauth: (req: { env: BoardCall['env']; method: string; path: string; query: string; body: Record<string, unknown>; origin: string; bearer?: string }) => Effect.promise(() => {
          const result = callQueue.then(async () => {
            const bindings = runtimeEnv as Record<string, unknown>
            const namespace = bindings.Board as { idFromName(name: string): { toString(): string } }
            if (namespace.idFromName(SPONSOR_OBJECT_NAME).toString() !== state.id.toString() || req.env.network !== bindings.NETWORK) throw new Error('management object identity mismatch')
            const sql = fromDurableObjectSql(state.storage.sql.raw, write => state.raw.storage.transactionSync(write))
            migrateAgentSchema(sql)
            const desk = new SessionDesk({ sql: fromD1(bindings.Database as never), now: () => Math.floor(Date.now() / 1000), verify: async () => false })
            const session = await desk.resolve({ bearer: req.bearer })
            return toJson(await oauthRoute({ sql, method: req.method, path: req.path, query: new URLSearchParams(req.query), body: req.body, origin: req.origin, siteOrigin: req.origin, ...(session === undefined ? {} : { owner: session.address }), now: Math.floor(Date.now() / 1000) }) ?? null)
          })
          callQueue = result.catch(() => undefined)
          return result
        }),
        oauthResolve: (req: { resource: string; bearer?: string; activity?: boolean }) => Effect.sync(() => {
          const bindings = runtimeEnv as Record<string, unknown>
          const namespace = bindings.Board as { idFromName(name: string): { toString(): string } }
          if (namespace.idFromName(SPONSOR_OBJECT_NAME).toString() !== state.id.toString()) throw new Error('management object identity mismatch')
          const sql = fromDurableObjectSql(state.storage.sql.raw, write => state.raw.storage.transactionSync(write))
          migrateAgentSchema(sql)
          return sql
        }).pipe(Effect.flatMap(sql => Effect.promise(async () => {
          const grant = await resolveOAuth(sql, req.bearer, req.resource, Math.floor(Date.now() / 1000))
          if (grant !== undefined && req.activity === true) new AgentStore(sql, () => Math.floor(Date.now() / 1000)).touch(grant.agentIds[0]!)
          return toJson(grant ?? null)
        }))),
        /** Private management storage remains in the existing reserved object. */
        management: (req: { kind: 'migrate' | 'retire' }) => Effect.sync(() => {
          const namespace = (runtimeEnv as Record<string, unknown>).Board as { idFromName(name: string): { toString(): string } } | undefined
          const objectName = req.kind === 'retire' ? '__hireling_fleet_v1__' : SPONSOR_OBJECT_NAME
          if (namespace?.idFromName(objectName).toString() !== state.id.toString()) throw new Error('management object identity mismatch')
          const sql = fromDurableObjectSql(state.storage.sql.raw, write => state.raw.storage.transactionSync(write))
          if (req.kind === 'retire') retireFleetSchema(sql)
          else migrateAgentSchema(sql)
          return 'null'
        }),
        /** Internal relay RPC shares the reserved object's queue and durable nonce ledger with sponsorship. */
        relay: (req: { env: BoardCall['env']; request: RelayRequest }) => Effect.promise(() => {
          const result = callQueue.then(async (): Promise<string> => {
            try {
              const bindings = runtimeEnv as Record<string, unknown>
              const namespace = bindings.Board as { idFromName(name: string): { toString(): string } } | undefined
              if (namespace?.idFromName(SPONSOR_OBJECT_NAME).toString() !== state.id.toString() || req.env.network !== bindings.NETWORK)
                throw new BoardError('forbidden', 'relay object identity or network mismatch')
              const request = req.request, deployment = sdk.deployment(req.env.network)
              // No public generic relay: the three internal send paths still carry verifiable signed authority.
              if (request.authorizationList !== undefined) {
                if (!isAddress(request.to) || request.data !== '0x' || request.authorizationList.length !== 1 || request.authorizationList[0]!.address.toLowerCase() !== deployment.delegation.delegator.toLowerCase())
                  throw new BoardError('forbidden', 'invalid account-upgrade relay request')
              } else {
                const pair = [...Object.values(deployment.stacks), ...Object.values(deployment.legacyStacks)].find(s => s?.evaluator.toLowerCase() === request.to.toLowerCase())
                if (pair === undefined) throw new BoardError('forbidden', 'relay target is not a configured evaluator')
                const decoded = decodeFunctionData({ abi: pair.kind === 'hireling-v1' ? sdk.hirelingEvaluatorAbi : sdk.jobsEvaluatorAbi, data: request.data })
                if (!['attachEvidence', 'ruleWithSignature'].includes(decoded.functionName)) throw new BoardError('forbidden', 'invalid evaluator relay method')
              }
              return toJson({ ok: true, result: await boardFor(req.env).relayTransaction(request) })
            } catch (e) { return toJson({ ok: false, code: e instanceof BoardError ? e.code : 'chain', message: e instanceof Error ? e.message : String(e) }) }
          })
          callQueue = result.catch(() => undefined)
          return result
        }),
        /** Private RPC, reachable only through the existing Board binding's reserved object. */
        admit: (req: AdmissionCall) => Effect.promise(async (): Promise<string> => {
          const bindings = runtimeEnv as Record<string, unknown>
          try {
            const namespace = bindings.Board as AdmissionNamespace | undefined
            if (namespace?.idFromName(ADMISSION_OBJECT_NAME).toString() !== state.id.toString()) throw new Error('admission object identity mismatch')
            const wallet = await admissionIdentity(bindings, req)
            if (!needsWriteRate(req.tool)) return toJson({ ok: true })
            const ipHash = await admissionIpHash(req.ip)
            limits ??= new AdmissionRateLimits(fromDurableObjectSql(state.storage.sql.raw))
            const result = state.raw.storage.transactionSync(() => limits!.consume(wallet, ipHash, req.tool, Math.floor(Date.now() / 1000)))
            return toJson(result)
          } catch {
            return toJson({ ok: false, code: 'forbidden', message: 'hosted write admission requires a valid session, edge IP and runtime policy' } satisfies AdmissionReply)
          }
        }),
        /** Runs one tool and returns its JSON reply; tool errors are replies, not failures. */
        call: (req: BoardCall) =>
          Effect.promise(() => {
            const result = callQueue.then(async (): Promise<string> => {
            const tool = tools[req.tool]
            if (tool === undefined) return toJson({ ok: false, code: 'not-found', message: `no tool ${req.tool}` })
            try {
              const bindings = runtimeEnv as Record<string, unknown>
              const network = bindings.NETWORK as sdk.Network
              const stage = bindings.DEPLOY_STAGE
              const admission = parseHostedAdmission(
                typeof bindings.PROD_ADMISSION_DRAIN === 'string' ? bindings.PROD_ADMISSION_DRAIN : '1',
              )
              if (req.env.network !== network || network === 'monad-mainnet' && stage !== 'prod') {
                return toJson({ ok: false, code: 'forbidden', message: 'Durable Object runtime network/stage mismatch' })
              }
              const namespace = bindings.Board as { idFromName: (name: string) => { toString: () => string } } | undefined
              const sponsored = sponsorToolNames.has(req.tool)
              const objectName = sponsored ? SPONSOR_OBJECT_NAME : req.env.boardId
              if ((sponsored || network === 'monad-mainnet') && (namespace === undefined || namespace.idFromName(objectName).toString() !== state.id.toString())) return toJson({ ok: false, code: 'forbidden', message: 'Durable Object board identity mismatch' })
              let directCaller = req.caller !== undefined ? { address: getAddress(req.caller) } : undefined
              if (req.agentAuth !== undefined) {
                const grant = await authenticatedAgent(req)
                directCaller = { address: getAddress(grant.address) }
                const rate = await enforceHostedRate(bindings, { network, tool: req.tool, boardId: req.env.boardId, bearer: req.bearer, caller: req.caller, ip: req.ip, agentAuth: req.agentAuth })
                if (!rate.ok) return toJson(rate)
              } else if (network === 'monad-mainnet') {
                const desk = new SessionDesk({ sql: fromD1((runtimeEnv as Record<string, unknown>).Database as never), now: () => Math.floor(Date.now() / 1000), verify: async () => false })
                const session = await desk.resolve({ bearer: req.bearer, mcpSession: req.mcpSession })
                if (req.caller !== undefined && session?.address.toLowerCase() !== req.caller.toLowerCase()) return toJson({ ok: false, code: 'forbidden', message: 'Durable Object caller is not the authenticated session wallet' })
                directCaller = session === undefined ? undefined : { address: session.address }
                const directDenied = admissionFailure(admission, network, req.env.boardId, req.tool, directCaller?.address)
                if (directDenied !== undefined) return toJson({ ok: false, code: 'forbidden', message: directDenied })
                const rate = await enforceHostedRate(bindings, { network, tool: req.tool, boardId: req.env.boardId, bearer: req.bearer, mcpSession: req.mcpSession, caller: req.caller, ip: req.ip })
                if (!rate.ok) return toJson(rate)
              }
              const board = boardFor(req.env)
              const caller = directCaller ?? board.resolveCaller({ bearer: req.bearer, mcpSession: req.mcpSession })
              const denied = admissionFailure(admission, network, req.env.boardId, req.tool, caller?.address)
              if (denied !== undefined) return toJson({ ok: false, code: 'forbidden', message: denied })
              const ctx: ToolContext = { network: req.env.network, mcpSession: req.mcpSession }
              const toolResult = await tool.run(board, caller, req.args, ctx)
              return toJson({ ok: true, result: toolResult } satisfies BoardReply)
            } catch (e) {
              const code = e instanceof BoardError ? e.code : 'error'
              const message = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e)
              const reason = e instanceof Error ? (e as { reason?: string }).reason : undefined
              return toJson({ ok: false, code, message, ...(reason === undefined ? {} : { reason }) } satisfies BoardReply)
            }
            })
            callQueue = result.catch(() => undefined)
            return result
          }),
    })
  }),
) {}
