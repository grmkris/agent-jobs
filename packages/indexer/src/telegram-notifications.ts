/** Finalized chain facts produce informational notifications; no chain operation is sent here. */
import type { Network } from '@sidequest/sdk'
import { type AsyncSql, stmt } from './store.ts'
import type { JobRow } from './read.ts'
import {
  enqueuePublicRequest,
  enqueueTelegram,
  telegramChainId,
  telegramPublicChannel,
  publicOrigin,
} from './telegram.ts'

type Event = {
  contract: string
  block: number
  log_index: number
  tx_hash: string
  job_id: string
  name: string
  args_json: string
  timestamp: number
}
const eventId = (chainId: number, e: Event) => `${chainId}:${e.contract}:${e.block}:${e.log_index}:${e.tx_hash}`
const NOTIFIED = [
  'Published',
  'Activated',
  'JobSubmitted',
  'Ruled',
  'PayoutDeferred',
  'RefundDeferred',
  'PayoutOwed',
  'JobCompleted',
  'JobRejected',
  'JobExpired',
  'Cancelled',
]
const PAID = new Set(['Accepted', 'Silence', 'RuledForWorker'])

export async function queueTelegramNotifications(
  sql: AsyncSql,
  network: Network,
  now: number,
  options: {
    channel?: string
    limit?: number
    caughtUp?: boolean
  } = {},
) {
  const chainId = telegramChainId(network)
  const [checkpoint] = await sql.all<{ updated_at: number; core_address: string | null }>(
    'SELECT updated_at, core_address FROM checkpoint WHERE chain_id = ?',
    chainId,
  )
  // Reminders must never be sent from a stalled index. Bot link replies can still drain independently.
  if (
    options.caughtUp === false ||
    checkpoint === undefined ||
    checkpoint.core_address === null ||
    checkpoint.updated_at < now - 120
  )
    return { processed: 0, reminders: 0, stale: true }
  const events = await sql.all<Event>(
    `SELECT e.*, b.timestamp FROM events e
    JOIN block_times b ON b.chain_id = e.chain_id AND b.block = e.block
    WHERE e.chain_id = ? AND e.name IN (${NOTIFIED.map(() => '?').join(',')})
    AND NOT EXISTS (SELECT 1 FROM telegram_notified_events n
      WHERE n.id = CAST(e.chain_id AS TEXT) || ':' || e.contract || ':' || e.block || ':' || e.log_index || ':' || e.tx_hash)
    ORDER BY e.block, e.log_index LIMIT ?`,
    chainId,
    ...NOTIFIED,
    options.limit ?? 200,
  )
  const notify = async (
    wallets: Array<string | null>,
    id: string,
    text: string,
    at: number,
    guard?: { jobId: string; until: number },
  ) => {
    for (const wallet of new Set(wallets.filter((w): w is string => w !== null).map((w) => w.toLowerCase()))) {
      const [link] = await sql.all<{ chat_id: string; linked_at: number }>(
        'SELECT chat_id, linked_at FROM telegram_links WHERE chain_id = ? AND wallet = ?',
        chainId,
        wallet,
      )
      if (link === undefined || link.linked_at > at) continue
      await enqueueTelegram(sql, {
        id: `${id}:${wallet}`,
        chatId: link.chat_id,
        wallet,
        text,
        now,
        ...(guard === undefined ? {} : { silenceGuard: { chainId, ...guard } }),
      })
    }
  }
  for (const e of events) {
    const id = eventId(chainId, e)
    const [job] = await sql.all<JobRow>('SELECT * FROM jobs WHERE chain_id = ? AND job_id = ?', chainId, e.job_id)
    if (job === undefined) continue
    const args = JSON.parse(e.args_json) as Record<string, unknown>
    const url = `${publicOrigin()}/job/${encodeURIComponent(e.job_id)}`
    if (e.name === 'Published' && e.timestamp >= now - 3600) {
      await enqueuePublicRequest(sql, options.channel ?? telegramPublicChannel(network), {
        boardId: 'public',
        taskId: e.job_id,
        kind: 'job',
        coreAddress: checkpoint.core_address,
        network,
        now,
      })
    }
    if (e.name === 'JobSubmitted')
      await notify(
        [job.creator, job.approver],
        `telegram:delivery:${id}`,
        `Delivery submitted for Sidequest job #${e.job_id}. Review the work.\n${url}`,
        e.timestamp,
      )
    if (e.name === 'Activated')
      await notify(
        [job.creator, job.worker],
        `telegram:hired:${id}`,
        `Sidequest job #${e.job_id} is active.\n${url}`,
        e.timestamp,
      )
    if (e.name === 'Ruled')
      await notify(
        [job.creator, job.worker],
        `telegram:ruling:${id}`,
        `The arbitrator ruled for the ${args.forWorker === true ? 'worker' : 'creator'} on Sidequest job #${e.job_id}.\n${url}`,
        e.timestamp,
      )
    if (e.name === 'PayoutOwed') {
      await notify(
        [typeof args.to === 'string' ? args.to : null],
        `telegram:owed:${id}`,
        `Sidequest job #${e.job_id} has a payout to collect.\n${publicOrigin()}/collect`,
        e.timestamp,
      )
    } else if (
      ['PayoutDeferred', 'RefundDeferred', 'JobCompleted', 'JobRejected', 'JobExpired', 'Cancelled'].includes(e.name)
    ) {
      const contributors = await sql.all<{ contributor: string }>(
        'SELECT DISTINCT contributor FROM top_ups WHERE chain_id = ? AND job_id = ? AND refunded = 0',
        chainId,
        e.job_id,
      )
      const hasRefunds =
        job.kind === 'sidequest-v1' && job.outcome !== null && job.outcome !== 'None' && !PAID.has(job.outcome)
      const unsettled = job.settlement_outcome === 'None'
      if (unsettled || hasRefunds)
        await notify(
          [
            ...(unsettled ? [job.creator, job.worker] : []),
            ...(hasRefunds ? contributors.map((c) => c.contributor) : []),
          ],
          `telegram:collect:${chainId}:${e.job_id}:${e.tx_hash}`,
          `Sidequest job #${e.job_id} has a decision recorded. Review Collect for settlement or refunds.\n${publicOrigin()}/collect`,
          e.timestamp,
        )
    }
    // A crash before this marker repeats only INSERT OR IGNORE notifications with deterministic ids.
    await sql.batch([stmt('INSERT OR IGNORE INTO telegram_notified_events (id, processed_at) VALUES (?, ?)', id, now)])
  }
  const submitted = await sql.all<JobRow & { submitted_at: number; submitted_tx: string }>(
    `SELECT j.*, b.timestamp AS submitted_at, s.tx_hash AS submitted_tx FROM jobs j
    JOIN submissions s ON s.chain_id = j.chain_id AND s.job_id = j.job_id
    JOIN block_times b ON b.chain_id = s.chain_id AND b.block = s.block
    WHERE j.chain_id = ? AND j.status = 'submitted' AND (j.outcome IS NULL OR j.outcome = 'None')
    AND EXISTS (SELECT 1 FROM telegram_links l WHERE l.chain_id = j.chain_id AND l.wallet IN (lower(j.creator), lower(j.approver), lower(j.worker)))`,
    chainId,
  )
  let reminders = 0
  for (const job of submitted) {
    const window = job.review_window
    if (window === null || !Number.isSafeInteger(window) || window <= 0) continue
    const paysAt = job.submitted_at + window
    if (now < paysAt - 86400 || now >= paysAt) continue
    await notify(
      [job.creator, job.approver, job.worker],
      `telegram:silence:${chainId}:${job.job_id}:${job.submitted_tx}`,
      `Sidequest job #${job.job_id}: silence accepts this delivery at ${new Date(paysAt * 1000).toISOString()}. Review the work before then.\n${publicOrigin()}/job/${encodeURIComponent(job.job_id)}`,
      now,
      { jobId: job.job_id, until: paysAt },
    )
    reminders++
  }
  return { processed: events.length, reminders, stale: false }
}
