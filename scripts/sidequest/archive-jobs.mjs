/** Anonymous pre-G1d archive. Run from the repository root; no env or session files are loaded. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Ajv from 'ajv'
import { getAddress } from 'viem'

const ORIGINS = Object.freeze({ dev: 'https://dev.sidequest.exchange', prod: 'https://sidequest.exchange' })
const usage = 'usage: archive-jobs.mjs --stage <dev|prod> [--date YYYY-MM-DD] [--out FILE]'
const addressSchema = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' }
const object = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: true,
})
const array = (items) => ({ type: 'array', items })
const envelope = (result) => object({ ok: { const: true }, result })
const id = { type: 'string', minLength: 1 }
const jobSchema = object({ job_id: { type: 'string', pattern: '^[1-9][0-9]*$' }, chain_id: { const: 10143 } }, [
  'job_id',
])
const ajv = new Ajv()
const validators = {
  protocol: ajv.compile(
    envelope(
      object({
        network: { const: 'monad-testnet' },
        chainId: { const: 10143 },
        contracts: object({ core: addressSchema, stacks: object({ main: object({ holding: addressSchema }) }) }),
      }),
    ),
  ),
  jobs: ajv.compile(object({ ok: { const: true }, jobs: array(jobSchema), index: { type: ['object', 'null'] } })),
  boards: ajv.compile(
    object({
      ok: { const: true },
      boards: array(object({ id: { type: 'string', pattern: '^(public|[a-z0-9-]{3,32})$' } })),
    }),
  ),
  tasks: ajv.compile(envelope(array(object({ taskId: id, jobId: { type: ['string', 'null'] } })))),
  requests: ajv.compile(envelope(array(object({ requestId: id, taskId: { type: ['string', 'null'] }, status: id })))),
}

export function parseArchiveArgs(args, today = new Date().toISOString().slice(0, 10)) {
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i],
      value = args[i + 1]
    if (!['--stage', '--date', '--out'].includes(flag) || value === undefined || value.startsWith('--'))
      throw new Error(`archive: ${usage}`)
    const key = flag.slice(2)
    if (Object.hasOwn(options, key)) throw new Error(`archive: duplicate ${flag}`)
    options[key] = value
  }
  const stage = options.stage,
    date = options.date ?? today
  if (
    !['dev', 'prod'].includes(stage) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    throw new Error(`archive: ${usage}`)
  const out = options.out ?? `docs/evidence/sidequest-${stage}/${date}-pre-g1d-jobs.json`
  if (!out.endsWith('.json')) throw new Error('archive: --out must end in .json')
  return { stage, date, out }
}

/** Parse at the HTTP boundary, retaining every extra public field for the archive. */
async function readJson(fetcher, origin, path, validator, args) {
  const init = {
    method: args === undefined ? 'GET' : 'POST',
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(30_000),
    headers: { accept: 'application/json' },
    ...(args === undefined
      ? {}
      : { headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(args) }),
  }
  const response = await fetcher(origin + path, init)
  if (!response.ok) throw new Error(`archive: ${path} returned HTTP ${response.status}`)
  const body = await response.json()
  if (!validator(body)) throw new Error(`archive: invalid public response for ${path}`)
  return body
}

function stageFacts(protocol) {
  return {
    chain: { network: protocol.network, chainId: protocol.chainId },
    core: getAddress(protocol.contracts.core),
    holding: getAddress(protocol.contracts.stacks.main.holding),
  }
}

function unique(rows, key, label) {
  if (new Set(rows.map((row) => row[key])).size !== rows.length) throw new Error(`archive: duplicate ${label}`)
  return rows
}

/** Public lists have no anonymous cursor. Refuse known truncation instead of silently losing records. */
function coverage(jobs, offers, requests) {
  if (jobs.length >= 200)
    throw new Error('archive: /data/jobs reached its 200-row limit; an exhaustive export needs a paginated read')
  if (offers.length >= 500)
    throw new Error('archive: task_index reached its 500-row limit; an exhaustive export needs a paginated read')
  if (
    requests.filter((row) => row.taskId === null && row.status?.startsWith('Accepting')).length >= 50 ||
    requests.filter((row) => row.taskId !== null || row.status?.startsWith('Expired')).length >= 50
  )
    throw new Error(
      'archive: list_quote_requests reached its 50-row group limit; an exhaustive export needs a paginated read',
    )
  return {
    jobs: 'all configured indexed jobs returned by /data/jobs; index progress recorded separately',
    offers: 'all task_index rows returned on this board, including drafts',
    quoteRequests: {
      scope: "this board's anonymous open requests plus requests closed or picked within seven days",
      historicalComplete: false,
      reason: 'Older closed requests and private bids are not exposed by the anonymous API.',
      openLimit: 50,
      recentLimit: 50,
    },
  }
}

async function readBoard(fetcher, origin, board) {
  const prefix = board.id === 'public' ? '' : `/b/${board.id}`
  const [tasksBody, requestsBody] = await Promise.all([
    readJson(fetcher, origin, `${prefix}/api/task_index`, validators.tasks, {}),
    readJson(fetcher, origin, `${prefix}/api/list_quote_requests`, validators.requests, { recent: true }),
  ])
  const offers = unique(tasksBody.result, 'taskId', 'task id').map((row) => ({ ...row, boardId: board.id }))
  const requests = unique(requestsBody.result, 'requestId', 'request id').map((row) => ({ ...row, boardId: board.id }))
  return { board, taskIndex: offers, quoteRequests: requests, coverage: coverage([], offers, requests), prefix }
}

/** Same reads as Explore, plus runtime contract identities. All methods here are anonymous reads. */
export async function readStage(stage, { fetcher = globalThis.fetch, observedAt = new Date().toISOString() } = {}) {
  if (!Object.hasOwn(ORIGINS, stage)) throw new Error('archive: stage must be dev or prod')
  const origin = ORIGINS[stage]
  const protocol = (await readJson(fetcher, origin, '/api/protocol_info', validators.protocol, {})).result
  const facts = stageFacts(protocol)
  const [jobsBody, boardsBody] = await Promise.all([
    readJson(fetcher, origin, '/data/jobs', validators.jobs),
    readJson(fetcher, origin, '/data/boards', validators.boards),
  ])
  const jobs = unique(jobsBody.jobs, 'job_id', 'job id')
  const listed = unique(boardsBody.boards, 'id', 'board id')
  if (!listed.some((board) => board.id === 'public'))
    throw new Error('archive: board directory is missing the public board')
  const jobScope = coverage(jobs, [], []).jobs
  const boards = []
  for (const board of listed) boards.push(await readBoard(fetcher, origin, board))
  const offers = boards.flatMap((board) => board.taskIndex)
  const quoteRequests = boards.flatMap((board) => board.quoteRequests)
  const after = stageFacts((await readJson(fetcher, origin, '/api/protocol_info', validators.protocol, {})).result)
  if (JSON.stringify(facts) !== JSON.stringify(after))
    throw new Error('archive: deployment changed during capture; retry before cutover')
  const byJob = new Map(offers.filter((offer) => offer.jobId !== null).map((offer) => [offer.jobId, offer]))
  return {
    schemaVersion: 1,
    evidenceTier: 'anonymous-public-api-readback',
    observedAt,
    stage,
    origin,
    ...facts,
    index: jobsBody.index,
    coverage: {
      jobs: jobScope,
      quoteRequests: {
        historicalComplete: false,
        reason:
          'Anonymous lists omit older closed requests and private bids. Per-board limits and scope are recorded below.',
      },
    },
    boards: boards.map(({ prefix: _prefix, ...board }) => board),
    jobs: jobs.map((job) => ({
      ...job,
      chainId: facts.chain.chainId,
      core: facts.core,
      holding: facts.holding,
      offer: byJob.get(job.job_id) ?? null,
    })),
    quoteRequests,
    taskIndex: offers,
    reads: [
      { method: 'POST', path: '/api/protocol_info', arguments: {}, repeatedAfterCapture: true },
      { method: 'GET', path: '/data/jobs' },
      { method: 'GET', path: '/data/boards' },
      ...boards.flatMap(({ prefix }) => [
        { method: 'POST', path: `${prefix}/api/task_index`, arguments: {} },
        { method: 'POST', path: `${prefix}/api/list_quote_requests`, arguments: { recent: true } },
      ]),
    ],
  }
}

export const outputPath = ({ stage, date, out }) =>
  resolve(out ?? `docs/evidence/sidequest-${stage}/${date}-pre-g1d-jobs.json`)

export function writeArchive(payload, target) {
  const path = resolve(target)
  if (existsSync(path)) throw new Error(`archive: output already exists: ${path}`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', { flag: 'wx', mode: 0o644 })
  return path
}

async function main() {
  const options = parseArchiveArgs(process.argv.slice(2))
  const target = outputPath(options)
  if (existsSync(target)) throw new Error(`archive: output already exists: ${target}`)
  const payload = await readStage(options.stage)
  const path = writeArchive(payload, target)
  console.log(
    JSON.stringify({
      stage: payload.stage,
      jobs: payload.jobs.length,
      quoteRequests: payload.quoteRequests.length,
      path,
    }),
  )
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname))
  await main().catch((error) => {
    console.error(
      error.message?.startsWith('archive:')
        ? error.message
        : 'archive: public read unavailable; provider details suppressed',
    )
    process.exitCode = 1
  })
