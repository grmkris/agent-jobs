import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expected } from '../../scripts/staging-release/evidence.mjs'

export const sql = {
  checkpoint: 'SELECT chain_id,next_block,block_hash,updated_at FROM checkpoint WHERE chain_id=10143',
  lease: "SELECT id,holder,expires_at FROM lease WHERE id='indexer:10143'",
  acquire: `INSERT INTO lease(id,holder,expires_at)
    VALUES('indexer:10143',?,CAST(strftime('%s','now') AS INTEGER)+300)
    ON CONFLICT(id) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at
    WHERE lease.expires_at<=CAST(strftime('%s','now') AS INTEGER)`,
  rewind: `UPDATE checkpoint SET next_block=?,block_hash=NULL,updated_at=0
    WHERE chain_id=10143 AND next_block=? AND block_hash IS ? AND updated_at=? AND next_block>?
    AND EXISTS(SELECT 1 FROM lease WHERE id='indexer:10143' AND holder=?
      AND expires_at>CAST(strftime('%s','now') AS INTEGER)+30)`,
  release: `UPDATE lease SET expires_at=CAST(strftime('%s','now') AS INTEGER)
    WHERE id='indexer:10143' AND holder=?`,
}

export function targetBlock(config, expectedBlock) {
  const h = config?.deployment?.sidequest
  if (config.network !== 'monad-testnet' || config.chainId !== 10143 || !Number.isSafeInteger(h?.block)
    || !/^0x[\da-f]{40}$/i.test(h.vault ?? '')
    || h.block <= 67856884 || h.vault?.toLowerCase() === '0x6e980b0545be5622f7399e40655aeccb6f56e3fa'
    || config.deployment.main?.kind !== 'sidequest-v1') throw new Error('cutover: requires a promoted G1c testnet config')
  if (expectedBlock !== undefined && h.block !== expectedBlock) throw new Error('cutover: --expect-block differs from config sidequest block')
  return h.block
}

export async function rewindCheckpoint(query, target, holder, validateConfig) {
  await query(sql.acquire, [holder])
  const lease = (await query(sql.lease)).results[0]
  if (lease?.holder !== holder) throw new Error('cutover: lease belongs to another runner; checkpoint untouched')
  try {
    const checkpoint = (await query(sql.checkpoint)).results[0]
    if (!checkpoint || checkpoint.chain_id !== 10143 || !Number.isSafeInteger(checkpoint.next_block)
      || !Number.isSafeInteger(checkpoint.updated_at)) throw new Error('cutover: checkpoint missing or invalid')
    if (checkpoint.next_block <= target) return { changed: false, checkpoint }
    await validateConfig()
    const result = await query(sql.rewind, [target, checkpoint.next_block, checkpoint.block_hash, checkpoint.updated_at, target, holder])
    if (result.changes !== 1) throw new Error('cutover: checkpoint compare-and-swap failed; reconcile before retrying')
    const after = (await query(sql.checkpoint)).results[0]
    if (after?.next_block !== target || after.block_hash !== null || after.updated_at !== 0) throw new Error('cutover: checkpoint readback mismatch')
    return { changed: true, before: checkpoint, checkpoint: after }
  } finally {
    await query(sql.release, [holder])
  }
}

async function main() {
  const args = process.argv.slice(2)
  let yes = false
  let expectBlock
  let version
  let complete = false
  let configPath = 'contracts/config/monad-testnet.json'
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--yes') yes = true
    else if (args[i] === '--prior-invocations-complete') complete = true
    else if (['--expect-block', '--quiescent-version', '--config'].includes(args[i]) && args[i + 1]) {
      const key = args[i]
      const value = args[++i]
      if (key === '--expect-block') expectBlock = Number(value)
      else if (key === '--quiescent-version') version = value
      else configPath = value
    } else throw new Error('cutover: usage indexer-cutover.mjs [--config FILE] [--yes --expect-block N --quiescent-version UUID --prior-invocations-complete]')
  }
  if (yes && (!Number.isSafeInteger(expectBlock) || !/^[a-f0-9-]{36}$/i.test(version ?? '') || !complete)) {
    throw new Error('cutover: apply requires --expect-block, --quiescent-version and --prior-invocations-complete')
  }
  const bytes = readFileSync(configPath, 'utf8')
  const target = targetBlock(JSON.parse(bytes), expectBlock)
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!token) throw new Error('cutover: set CLOUDFLARE_API_TOKEN')
  async function api(path, body) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${expected.accountId}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    })
    const envelope = await response.json()
    if (!response.ok || envelope.success !== true) throw new Error(`cutover: Cloudflare unavailable (${response.status})`)
    return envelope.result
  }
  async function workerIdentity() {
    const settings = await api(`/workers/scripts/${expected.resources.Indexer}/settings`)
    const database = settings.bindings?.find(binding => binding.name === 'Database')
    const network = settings.bindings?.find(binding => binding.name === 'NETWORK')
    if (database?.id !== expected.resources.Database || network?.text !== 'monad-testnet') throw new Error('cutover: live indexer binding/network mismatch')
    if (yes) {
      const deployments = await api(`/workers/scripts/${expected.resources.Indexer}/deployments`)
      const latest = deployments.deployments?.toSorted((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))[0]
      if (latest?.versions?.length !== 1 || latest.versions[0].version_id !== version || latest.versions[0].percentage !== 100) {
        throw new Error('cutover: live indexer version/traffic mismatch')
      }
    }
  }
  const query = async (statement, params = []) => {
    const result = await api(`/d1/database/${expected.resources.Database}/query`, { sql: statement, params })
    if (!Array.isArray(result) || result.length !== 1 || result[0].success !== true) throw new Error('cutover: D1 query unavailable')
    return { results: result[0].results, changes: result[0].meta?.changes }
  }
  await workerIdentity()
  console.log(JSON.stringify({ mode: yes ? 'apply' : 'dry-run', target, checkpoint: (await query(sql.checkpoint)).results, lease: (await query(sql.lease)).results }))
  if (!yes) return
  // Expiry cannot prove an old invocation finished: the coordinator must establish quiescence separately.
  const result = await rewindCheckpoint(query, target, `g1c-replay:${version}:${randomUUID()}`, async () => {
    if (readFileSync(configPath, 'utf8') !== bytes) throw new Error('cutover: config changed during apply')
    targetBlock(JSON.parse(bytes), expectBlock)
    await workerIdentity()
  })
  console.log(JSON.stringify(result))
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  await main().catch(error => {
    console.error(error.message?.startsWith('cutover:') ? error.message : 'cutover: unavailable; provider details suppressed')
    process.exitCode = 1
  })
}
