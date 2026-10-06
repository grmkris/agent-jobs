import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { fromNodeSqlite as boardSql, migrate as migrateBoard } from '@agent-jobs/board'
import { fromNodeSqlite, migrate, stmt } from '@agent-jobs/indexer'
import { boardFeedEvents, recordBoardEvent } from '../src/feed-board.ts'
import { readInbox } from '../src/feed.ts'
import { migrateTelegram } from '../src/telegram.ts'

const creator = '0x1111111111111111111111111111111111111111'
const worker = '0x2222222222222222222222222222222222222222'
const now = 2_000_000
const network = 'monad-testnet' as const

async function setup() {
  const board = boardSql(new DatabaseSync(':memory:'))
  migrateBoard(board)
  board.run("INSERT INTO tasks (id, creator, stack, terms_json, terms_hash, job_id, publish_tx, from_block, created_at) VALUES ('t1', ?, 'main', '{}', '0xaa', NULL, NULL, 1, 1)", creator)
  board.run("INSERT INTO applications (id, task_id, worker, agent_id, note, created_at) VALUES ('a1', 't1', ?, '9', 'direct hire invitation', 1)", worker)
  board.run("INSERT INTO quote_requests (id, creator, stack, request_json, request_hash, quote_deadline, task_id, created_at) VALUES ('r1', ?, 'main', '{\"brief\":\"secret brief\"}', '0xbb', 9, NULL, 1)", creator)
  const d1 = fromNodeSqlite(new DatabaseSync(':memory:'))
  await migrate(d1)
  await migrateTelegram(d1)
  await d1.batch([stmt('INSERT INTO telegram_links VALUES (?, 10143, ?, NULL, 1)', 'chat-worker', worker)])
  return { board, d1 }
}
const call = (tool: string, args: Record<string, unknown>, result: unknown) => ({ tool, args, result, network, boardId: 'public', now })

describe('board feed hook', () => {
  it('addresses quotes, applications, selections and requests to the party who must act, metadata only', async () => {
    const { board } = await setup()
    const quote = boardFeedEvents(board, call('submit_quote', { requestId: 'r1', note: 'worker text' }, { quoteId: 'q1', quoteHash: '0xq1' }))
    expect(quote).toEqual([expect.objectContaining({ id: 'board:public:quote:0xq1', address: creator, kind: 'quote.received', requestId: 'r1', next: { tool: 'list_quotes', args: { requestId: 'r1' } } })])
    expect(JSON.stringify(quote)).not.toMatch(/worker text|secret brief/)
    expect(boardFeedEvents(board, call('apply', { taskId: 't1', note: 'hi' }, { applicationId: 'a9' }))[0]).toMatchObject({ address: creator, kind: 'application.received', taskId: 't1' })
    expect(boardFeedEvents(board, call('submit_selection', { taskId: 't1', nonce: '5' }, { ok: true, worker }))[0]).toMatchObject({ id: 'board:public:selection:t1:5', address: worker, next: { tool: 'prepare_activation' } })
    expect(boardFeedEvents(board, call('request_quotes', {}, { requestId: 'r2' }))[0]).toMatchObject({ address: '*', kind: 'request.opened', requestId: 'r2' })
    expect(boardFeedEvents(board, call('get_task', { taskId: 't1' }, {}))).toEqual([])
    expect(boardFeedEvents(board, call('apply', { taskId: 'nope' }, { applicationId: 'a9' }))).toEqual([])
  })

  it('tells an invited worker only once the offer is escrowed on chain', async () => {
    const { board } = await setup()
    expect(boardFeedEvents(board, call('report_transaction', { taskId: 't1' }, {}))).toEqual([])
    board.run("UPDATE tasks SET job_id = '42' WHERE id = 't1'")
    expect(boardFeedEvents(board, call('report_transaction', { taskId: 't1' }, {}))).toEqual([
      expect.objectContaining({ id: `board:public:invite:t1:${worker}`, address: worker, kind: 'invite.received', jobId: '42', url: 'https://testnet.hireling.xyz/job/42' }),
    ])
  })

  it('writes the inbox and the moved Telegram notice once, and swallows its own failures', async () => {
    const { board, d1 } = await setup()
    const selection = call('submit_selection', { taskId: 't1', nonce: '5' }, { ok: true, worker })
    await recordBoardEvent(board, d1, selection)
    await recordBoardEvent(board, d1, selection)
    expect((await readInbox(d1, { network, address: worker, now })).events.map(e => e.kind)).toEqual(['selection.received'])
    expect(await d1.all('SELECT id, chat_id FROM telegram_outbox')).toEqual([{ id: 'telegram:selected:public:t1:5', chat_id: 'chat-worker' }])
    const broken = { ...d1, batch: async () => { throw new Error('D1 down: secret-ish detail') } }
    await expect(recordBoardEvent(board, broken, selection)).resolves.toBeUndefined()
  })
})
