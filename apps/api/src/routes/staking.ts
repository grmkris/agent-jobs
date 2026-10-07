/** The public staking data routes shared by the Worker and real-fork HTTP regressions. */
import { BoardError, delegationPositions, positionFilters } from '@sidequest/board'
import type { AsyncSql } from '@sidequest/indexer'
import type { Ctx } from '@sidequest/sdk'
import { backingCard, stakingSnapshot } from '../staking-index.ts'
import { jsonResponse } from '../json.ts'

export function isStakingDataPath(path: string): boolean {
  return path === '/data/delegations' || /^\/data\/backing\/0x[0-9a-fA-F]{40}$/.test(path)
}

export async function stakingDataRoute(
  sql: AsyncSql,
  ctx: Ctx | undefined,
  url: URL,
  now: number,
  headers: Record<string, string> = {},
) {
  try {
    if (ctx === undefined) throw new BoardError('unavailable', 'vault reads are unavailable')
    const filters = positionFilters(
      {
        ...(url.searchParams.has('wallet') ? { wallet: url.searchParams.get('wallet')! } : {}),
        ...(url.pathname.startsWith('/data/backing/')
          ? { account: url.pathname.slice('/data/backing/'.length) }
          : url.searchParams.has('account')
            ? { account: url.searchParams.get('account')! }
            : {}),
      },
      undefined,
      (message) => new BoardError('invalid', message),
    )
    const result =
      url.pathname === '/data/delegations'
        ? await delegationPositions(ctx, await stakingSnapshot(sql, ctx, filters, now))
        : await backingCard(sql, ctx, filters.account!, filters.wallet, now)
    return jsonResponse({ ok: true, ...result }, { headers })
  } catch (error) {
    const code = error instanceof BoardError ? error.code : 'unavailable'
    const message = error instanceof BoardError ? error.message : 'vault or index reads are unavailable'
    return jsonResponse(
      { ok: false, code, message },
      { status: code === 'invalid' ? 400 : code === 'chain' ? 502 : 503, headers },
    )
  }
}
