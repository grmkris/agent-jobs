import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { outputPath, parseArchiveArgs, readStage, writeArchive } from './archive-jobs.mjs'

const CORE = '0x1111111111111111111111111111111111111111'
const HOLDING = '0x2222222222222222222222222222222222222222'

function fixtureFetch(calls) {
  return async (url, init = {}) => {
    assert.equal(init.credentials, 'omit')
    assert.equal(init.redirect, 'error')
    assert.equal(Object.hasOwn(init.headers, 'authorization'), false)
    assert.equal(Object.hasOwn(init.headers, 'cookie'), false)
    const parsed = new URL(url)
    calls.push({
      path: parsed.pathname,
      method: init.method ?? 'GET',
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    })
    const bodies = {
      '/data/jobs': {
        ok: true,
        index: { next_block: 69037583, updated_at: 1791300000 },
        board: null,
        jobs: [{ job_id: '7', status: 'open', creator: CORE }],
      },
      '/api/protocol_info': {
        ok: true,
        result: {
          network: 'monad-testnet',
          chainId: 10143,
          contracts: { core: CORE, stacks: { main: { holding: HOLDING } } },
        },
      },
      '/api/task_index': {
        ok: true,
        result: [
          { taskId: 'task-7', jobId: '7', title: 'archive me' },
          { taskId: 'draft', jobId: null, title: 'draft too' },
        ],
      },
      '/api/list_quote_requests': {
        ok: true,
        result: [
          {
            requestId: 'request-1',
            taskId: null,
            status: 'Accepting quotes — reward not escrowed',
            title: 'quote me',
            createdAt: 1791299999,
          },
        ],
      },
    }
    const body = bodies[parsed.pathname]
    if (body === undefined) return { ok: false, status: 404, json: async () => ({ ok: false }) }
    return { ok: true, status: 200, json: async () => body }
  }
}

test('public archive reads Explore jobs, offers and recent quote requests without credentials', async () => {
  const calls = []
  const archive = await readStage('dev', { fetcher: fixtureFetch(calls), observedAt: '2026-10-07T00:00:00.000Z' })
  assert.deepEqual(calls, [
    { path: '/api/protocol_info', method: 'POST', body: {} },
    { path: '/data/jobs', method: 'GET', body: undefined },
    { path: '/api/task_index', method: 'POST', body: {} },
    { path: '/api/list_quote_requests', method: 'POST', body: { recent: true } },
    { path: '/api/protocol_info', method: 'POST', body: {} },
  ])
  assert.deepEqual(archive.chain, { network: 'monad-testnet', chainId: 10143 })
  assert.equal(archive.core, CORE)
  assert.equal(archive.holding, HOLDING)
  assert.equal(archive.jobs[0].offer.title, 'archive me')
  assert.equal(archive.taskIndex.length, 2)
  assert.equal(archive.quoteRequests[0].requestId, 'request-1')
  assert.equal(archive.coverage.quoteRequests.openLimit, 50)
  assert.equal(archive.coverage.quoteRequests.historicalComplete, false)
})

test('stage hosts and output names are explicit and deterministic', () => {
  assert.throws(() => parseArchiveArgs([]), /--stage/u)
  assert.throws(() => parseArchiveArgs(['--stage', 'staging']), /usage/u)
  assert.throws(() => parseArchiveArgs(['--stage', 'dev', '--stage', 'prod']), /duplicate/u)
  const options = parseArchiveArgs(['--stage', 'prod', '--date', '2026-10-07'])
  assert.equal(outputPath(options), resolve('docs/evidence/sidequest-prod/2026-10-07-pre-g1d-jobs.json'))
  assert.equal(
    parseArchiveArgs(['--stage', 'dev'], '2026-10-07').out,
    'docs/evidence/sidequest-dev/2026-10-07-pre-g1d-jobs.json',
  )
  assert.throws(() => parseArchiveArgs(['--stage', 'dev', '--date', '2026-99-99']), /usage/u)
  assert.throws(() => parseArchiveArgs(['--stage', 'dev', '--date', '2026-02-30']), /usage/u)
})

test('prod reads the production stage public origin', async () => {
  const reader = fixtureFetch([])
  const origins = new Set()
  await readStage('prod', {
    fetcher: async (url, init) => {
      origins.add(new URL(url).origin)
      return reader(url, init)
    },
  })
  assert.deepEqual([...origins], ['https://sidequest.exchange'])
})

test('deployment drift and a public service failure refuse capture', async () => {
  const reader = fixtureFetch([])
  let protocolReads = 0
  await assert.rejects(
    readStage('dev', {
      fetcher: async (url, init) => {
        const response = await reader(url, init)
        const body = structuredClone(await response.json())
        if (new URL(url).pathname === '/api/protocol_info' && ++protocolReads === 2)
          body.result.contracts.core = HOLDING
        return { ...response, json: async () => body }
      },
    }),
    /deployment changed/u,
  )
  await assert.rejects(
    readStage('dev', {
      fetcher: async (url, init) => {
        if (new URL(url).pathname === '/data/jobs') return { ok: false, status: 503 }
        return reader(url, init)
      },
    }),
    /HTTP 503/u,
  )
})

test('known public list limits and duplicate rows refuse a silently incomplete archive', async () => {
  const reader = fixtureFetch([])
  const variants = [
    [
      '/data/jobs',
      (body) => {
        body.jobs = Array.from({ length: 200 }, (_, i) => ({ job_id: String(i + 1) }))
      },
      /200-row limit/u,
    ],
    [
      '/api/task_index',
      (body) => {
        body.result = Array.from({ length: 500 }, (_, i) => ({ taskId: String(i), jobId: null }))
      },
      /500-row limit/u,
    ],
    [
      '/api/list_quote_requests',
      (body) => {
        body.result = Array.from({ length: 50 }, (_, i) => ({
          requestId: String(i),
          taskId: null,
          status: 'Accepting quotes — reward not escrowed',
        }))
      },
      /50-row group limit/u,
    ],
    [
      '/data/jobs',
      (body) => {
        body.jobs.push(body.jobs[0])
      },
      /duplicate job/u,
    ],
  ]
  for (const [path, mutate, expected] of variants) {
    await assert.rejects(
      readStage('dev', {
        fetcher: async (url, init) => {
          const response = await reader(url, init)
          const body = structuredClone(await response.json())
          if (new URL(url).pathname === path) mutate(body)
          return { ...response, json: async () => body }
        },
      }),
      expected,
    )
  }
})

test('archive output refuses overwrites and writes a reviewable JSON file', () => {
  const root = mkdtempSync(join(tmpdir(), 'sidequest-archive-'))
  try {
    const target = join(root, 'jobs.json')
    const payload = { schemaVersion: 1, jobs: [] }
    assert.equal(writeArchive(payload, target), target)
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), payload)
    assert.throws(() => writeArchive(payload, target), /already exists/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('malformed public chain facts fail closed before an archive is written', async () => {
  const fetcher = fixtureFetch([])
  await assert.rejects(
    readStage('dev', {
      fetcher: async (url, init) => {
        const response = await fetcher(url, init)
        if (new URL(url).pathname === '/api/protocol_info')
          return {
            ...response,
            json: async () => ({
              ok: true,
              result: { network: 'monad-testnet', chainId: 10143, contracts: { core: CORE, stacks: { main: {} } } },
            }),
          }
        return response
      },
    }),
    /invalid public response/u,
  )
})
