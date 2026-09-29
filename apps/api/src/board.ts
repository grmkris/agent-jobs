import { Board as BoardService, BoardError, fromDurableObjectSql } from '@agent-jobs/board'
import * as sdk from '@agent-jobs/sdk'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import { getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { type ToolContext, toJson, tools } from './tools.ts'

/** What the Worker passes on every call: the tool, its arguments, the caller's credentials and the runtime env. */
export interface BoardCall {
  readonly tool: string
  readonly args: Record<string, unknown>
  readonly bearer?: string | undefined
  readonly mcpSession?: string | undefined
  /** The signed-in wallet, when the Worker already resolved it from the shared session store (ADR-0008). */
  readonly caller?: string | undefined
  readonly env: {
    readonly network: sdk.Network
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
    /** The execution-budget signer (ADR-0005); any empty field means budgets are unavailable. */
    readonly budget: { readonly appId: string; readonly appSecret: string; readonly signerKey: string; readonly signerQuorumId: string }
  }
}

const key32 = (k: string) => /^0x[0-9a-fA-F]{64}$/.test(k)

export type BoardReply =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string }

/**
 * One Durable Object per hosted board (spec §5). It owns the board's SQLite (tasks, applications, selections,
 * sessions, operation records) and runs every tool single-threaded, so two requests never interleave inside one
 * board. Chain reads and verifications go to the RPC the Worker passes in.
 */
export default class Board extends Cloudflare.DurableObject<Board>()(
  'Board',
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState
    let service: { key: string; board: BoardService } | undefined

    const boardFor = (env: BoardCall['env']): BoardService => {
      const key = JSON.stringify(env)
      if (service?.key === key) return service.board
      const contexts: Partial<Record<sdk.StackName, sdk.Ctx>> = {}
      for (const name of ['main', 'demo', 'fast'] as const) {
        if (sdk.deployment(env.network).stacks[name] !== undefined) contexts[name] = sdk.context(env.network, name, env.rpcUrl)
      }
      const board = new BoardService(fromDurableObjectSql(state.storage.sql.raw), {
        network: env.network,
        contexts,
        domain: env.domain,
        uri: env.uri,
        manifestBaseUrl: env.manifestBaseUrl,
        ...(env.screening.apiKey === '' ? {} : { screening: env.screening }),
        ...(key32(env.relayKey) ? { relay: { account: privateKeyToAccount(env.relayKey as `0x${string}`), rpcUrl: env.rpcUrl } } : {}),
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
        ...(env.budget.appId === '' || env.budget.appSecret === '' || env.budget.signerKey === '' || env.budget.signerQuorumId === ''
          ? {}
          : {
              budget: {
                app: { appId: env.budget.appId, appSecret: env.budget.appSecret },
                signerKey: env.budget.signerKey,
                signerQuorumId: env.budget.signerQuorumId,
              },
            }),
      })
      service = { key, board }
      return board
    }

    return Effect.succeed({
        /** Runs one tool and returns its JSON reply; tool errors are replies, not failures. */
        call: (req: BoardCall) =>
          Effect.promise(async (): Promise<string> => {
            const tool = tools[req.tool]
            if (tool === undefined) return toJson({ ok: false, code: 'not-found', message: `no tool ${req.tool}` })
            try {
              const board = boardFor(req.env)
              const caller = req.caller !== undefined ? { address: getAddress(req.caller) } : board.resolveCaller({ bearer: req.bearer, mcpSession: req.mcpSession })
              const ctx: ToolContext = { network: req.env.network, mcpSession: req.mcpSession }
              const result = await tool.run(board, caller, req.args, ctx)
              return toJson({ ok: true, result } satisfies BoardReply)
            } catch (e) {
              const code = e instanceof BoardError ? e.code : 'error'
              const message = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e)
              return toJson({ ok: false, code, message } satisfies BoardReply)
            }
          }),
    })
  }),
) {}
