import { Board as BoardService, BoardError, fromDurableObjectSql } from '@agent-jobs/board'
import * as sdk from '@agent-jobs/sdk'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import { type ToolContext, toJson, tools } from './tools.ts'

/** What the Worker passes on every call: the tool, its arguments, the caller's credentials and the runtime env. */
export interface BoardCall {
  readonly tool: string
  readonly args: Record<string, unknown>
  readonly bearer?: string | undefined
  readonly mcpSession?: string | undefined
  readonly env: {
    readonly network: sdk.Network
    readonly rpcUrl: string
    readonly domain: string
    readonly uri: string
    readonly manifestBaseUrl: string
  }
}

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
      for (const name of ['main', 'demo'] as const) {
        if (sdk.deployment(env.network).stacks[name] !== undefined) contexts[name] = sdk.context(env.network, name, env.rpcUrl)
      }
      const board = new BoardService(fromDurableObjectSql(state.storage.sql.raw), {
        network: env.network,
        contexts,
        domain: env.domain,
        uri: env.uri,
        manifestBaseUrl: env.manifestBaseUrl,
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
              const caller = board.resolveCaller({ bearer: req.bearer, mcpSession: req.mcpSession })
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
