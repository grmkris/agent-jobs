import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { context } from '../../packages/sdk/src/client.ts'
import { parsePriceList, recoverPriceListSigner, type PriceListFile } from '../../scripts/mining/prices.ts'
import { parseAbi, type Hex } from '../../scripts/mining/viem.ts'

// Read-only live proof of the runbook's encrypted Foundry-keystore signer path.
// Import an authorized testnet key into a run-owned temporary encrypted file,
// sign an off-chain diagnostic price list, verify its owner on the real Safe,
// then delete only this invocation's private temporary directory. No tx.
async function main() {
  const rpc = process.env.MONAD_TESTNET_RPC_URL, key = process.env.SAFE_BACKUP_TESTNET_PRIVATE_KEY
  if (!rpc || !key) throw new Error('set the testnet RPC and backup-owner key by environment name')
  const ctx = context('monad-testnet', 'main', rpc), h = ctx.deployment.hireling
  if (!h || ctx.deployment.chainId !== 10143 || await ctx.publicClient.getChainId() !== 10143) throw new Error('testnet only')
  const repo = resolve(import.meta.dirname, '../..'), directory = mkdtempSync(join(tmpdir(), 'hireling-keystore-proof-'))
  const cast = (args: string[], extraEnv = {}) => {
    const result = spawnSync('cast', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } })
    if (result.status !== 0) throw new Error('keystore command refused')
    return result.stdout.trim()
  }
  try {
    const password = randomBytes(32).toString('hex'), passwordFile = join(directory, 'owner.password')
    writeFileSync(passwordFile, password, { mode: 0o600 })
    cast(['wallet', 'import', 'testnet-owner', '--keystore-dir', directory, '--private-key', key], { CAST_UNSAFE_PASSWORD: password })
    const keystore = join(directory, 'testnet-owner'), input = join(directory, 'unsigned.json'), output = join(directory, 'signed.json')
    const signerArgs = ['--keystore', keystore, '--password-file', passwordFile]
    const address = cast(['wallet', 'address', ...signerArgs]).toLowerCase()
    const example = JSON.parse(readFileSync(new URL('./prices-epoch0-testnet.json', import.meta.url), 'utf8')) as PriceListFile['message']
    // Diagnostic only. This never becomes epoch 0's approved price signature.
    writeFileSync(input, JSON.stringify({ ...example, epoch: '999999' }), { mode: 0o600 })
    const signed = spawnSync('bun', ['--no-env-file', 'scripts/mining/sign-prices.ts', input, '--network', 'monad-testnet', '--out', output, ...signerArgs],
      { cwd: repo, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (signed.status !== 0) throw new Error('sign-prices keystore path refused')
    const file = JSON.parse(readFileSync(output, 'utf8')) as PriceListFile
    const recovered = await recoverPriceListSigner(parsePriceList(file), file.signature as Hex, 10143, h.distributor)
    const block = await ctx.publicClient.getBlockNumber({ cacheTime: 0 })
    const abi = parseAbi(['function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)'])
    const owners = await ctx.publicClient.readContract({ address: h.safe, abi, functionName: 'getOwners', blockNumber: block })
    const threshold = await ctx.publicClient.readContract({ address: h.safe, abi, functionName: 'getThreshold', blockNumber: block })
    if (recovered !== address || !owners.some(a => a.toLowerCase() === recovered) || threshold !== 1n) throw new Error('live Safe owner/signature mismatch')
    console.log(`PASS encrypted keystore: sign-prices.ts EIP-712 recovered current testnet Safe owner ${recovered} at block ${block}; threshold 1; diagnostic epoch 999999; no transaction; temporary key copy removed`)
  } finally { rmSync(directory, { recursive: true }) }
}
await main().catch(() => { console.error('testnet keystore proof refused (details suppressed)'); process.exitCode = 1 })
