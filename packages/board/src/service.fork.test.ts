/**
 * S8 / R114-07 on a local anvil fork of Monad testnet (the deployed contracts, nothing sent to the real chain): at
 * most one economic effect per operation when a response is lost or the board restarts mid-operation.
 *
 * - A publish whose confirmation never reached the board: after a restart the board finds the listing on-chain;
 *   the client's retry of the same publish reverts, so the reward is escrowed once.
 * - A relay that broadcast a signed ruling and crashed before recording it: after a restart `submit_ruling` sends
 *   nothing (the ruling nonce is spent); a repeated call sends nothing either; the recorded decision is re-used.
 *
 * Needs MONAD_TESTNET_RPC_URL, ARBITRATOR_PRIVATE_KEY (the demo evaluator's arbitrator signs, as in production) and
 * `anvil` on PATH; skipped otherwise.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import * as sdk from '@agent-jobs/sdk'
import { type Hex, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Board, type BoardConfig, fromNodeSqlite } from './index.ts'

const rpc = process.env.MONAD_TESTNET_RPC_URL ?? ''
const arbitratorKey = process.env.ARBITRATOR_PRIVATE_KEY ?? ''
const hasAnvil = (() => {
  try {
    execFileSync('anvil', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const fork = rpc === '' || arbitratorKey === '' || !hasAnvil ? describe.skip : describe
const PORT = 8661
const url = `http://127.0.0.1:${PORT}`
const NET = 'monad-testnet' as const

let anvil: ChildProcess | undefined
const ctx = () => sdk.context(NET, 'demo', url)

async function rpcCall(method: string, params: unknown[]) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return ((await res.json()) as { result: unknown }).result
}

fork('R114-07 on a testnet fork: lost responses and restarts', () => {
  const db = new DatabaseSync(':memory:')
  const relay = privateKeyToAccount(generatePrivateKey())
  const config = (): BoardConfig => ({
    network: NET,
    contexts: { main: sdk.context(NET, 'main', url), demo: ctx() },
    domain: 'board.test',
    uri: 'https://board.test',
    manifestBaseUrl: 'https://board.test/offers',
    relay: { account: relay, rpcUrl: url },
  })
  /** A board process; a new one on the same database is a restart. */
  const boot = () => new Board(fromNodeSqlite(db), config())
  const creator = privateKeyToAccount(generatePrivateKey())
  const worker = privateKeyToAccount(generatePrivateKey())
  // Parsed lazily: a skipped suite's body still runs at collection, without the key.
  const arbitrator = arbitratorKey === '' ? privateKeyToAccount(generatePrivateKey()) : privateKeyToAccount(arbitratorKey as Hex)
  const w = (a: typeof creator) => sdk.wallet(NET, a, url)

  async function signIn(board: Board, account: typeof creator) {
    const { message } = board.authChallenge({ address: account.address })
    return board.authLogin({ message, signature: await account.signMessage({ message }) })
  }

  beforeAll(async () => {
    anvil = spawn('anvil', ['--fork-url', rpc, '--port', String(PORT), '--silent'], { stdio: 'ignore' })
    for (let i = 0; i < 60; i++) {
      const id = await rpcCall('eth_chainId', []).catch(() => undefined)
      if (id !== undefined) break
      await new Promise((r) => setTimeout(r, 500))
    }
    for (const a of [creator, worker, relay]) await rpcCall('anvil_setBalance', [a.address, `0x${parseEther('100').toString(16)}`])
    const c = ctx()
    for (const token of [c.deployment.factory, c.deployment.rewardTokens[0] as Hex]) await sdk.faucet(c, w(creator), token)
    await sdk.faucet(c, w(worker), c.deployment.factory)
  }, 120_000)

  afterAll(() => {
    anvil?.kill()
  })

  let taskId = ''

  it('a publish whose confirmation was lost is found on-chain after a restart; the retry escrows nothing', async () => {
    const board = boot()
    const { address } = await signIn(board, creator)
    const c = ctx()
    const created = await board.createTask(
      { address },
      {
        title: 'R114-07 lost publish response',
        brief: 'Fork test.',
        acceptanceCriteria: ['a check named "test" passes on the submitted SHA'],
        token: 'mUSD',
        reward: '5',
        creatorBond: '1',
        workerBond: '1',
        deliveryDeadline: Number((await c.publicClient.getBlock()).timestamp) + 3600,
        mode: 'hire',
        stack: 'demo',
        requiredChecks: ['test'],
      },
    )
    taskId = created.taskId
    const before = await sdk.balanceOf(c, c.deployment.rewardTokens[0] as Hex, creator.address)
    await sdk.sendAll(w(creator), c.publicClient, created.transactions)
    // The response to the client is lost: no report_transaction. The board restarts.
    const restarted = boot()
    const seen = await restarted.getTask({ address }, { taskId })
    expect(seen.jobId).not.toBeNull()
    expect(seen.chain.status).toBe('open')
    expect(seen.operations.find((o) => o.kind === 'publish')?.status).toBe('confirmed')
    // The client retries the publish it built: the contract refuses the same terms again.
    const counter = await c.publicClient.readContract({ address: c.deployment.core, abi: sdk.coreAbi, functionName: 'jobCounter' })
    const publishTx = created.transactions.at(-1) as sdk.TxRequest
    await expect(sdk.sendAll(w(creator), c.publicClient, [publishTx])).rejects.toThrow()
    expect(await c.publicClient.readContract({ address: c.deployment.core, abi: sdk.coreAbi, functionName: 'jobCounter' })).toBe(counter)
    expect(before - (await sdk.balanceOf(c, c.deployment.rewardTokens[0] as Hex, creator.address))).toBe(5_000_000n)
  }, 180_000)

  it('a relay that broadcast a ruling and crashed before recording it never sends a second one', async () => {
    const c = ctx()
    const board = boot()
    const pub = await signIn(board, creator)
    const wrk = await signIn(board, worker)
    const agentId = await sdk.registerAgent(c, w(worker), 'https://github.com/grmkris/agent-jobs#fork-test')
    const app = await board.apply({ address: wrk.address }, { taskId, agentId: agentId.toString(), note: 'fork' })
    const sel = await board.selectWorker({ address: pub.address }, { taskId, applicationId: app.applicationId })
    await board.submitSelection({ address: pub.address }, { taskId, nonce: sel.nonce, signature: await sdk.signTypedDataJson(w(creator), sel.sign.typedData) })
    const prep = await board.prepareActivation({ address: wrk.address }, { taskId })
    await sdk.sendAll(w(worker), c.publicClient, prep.transactions)
    const act = await board.buildActivation({ address: wrk.address }, { taskId, budgetSignature: await sdk.signTypedDataJson(w(worker), prep.sign.typedData) })
    await sdk.sendAll(w(worker), c.publicClient, act.transactions)
    const sub = await board.submitWork({ address: wrk.address }, {
      taskId, repo: 'https://github.com/grmkris/runner-spike-fixture', branch: 'dispatch/cb0b4323adb67f08', sha: 'c850f7a58015bafe065257f263a2ecc01da56dfe',
    })
    const [subHash] = await sdk.sendAll(w(worker), c.publicClient, sub.transactions)
    await board.reportTransaction({ address: wrk.address }, { taskId, txHash: subHash as string })
    const rej = await board.rejectWork({ address: pub.address }, { taskId, violation: 'None', reason: 'We changed our minds about CI.' })
    await sdk.sendAll(w(creator), c.publicClient, rej.transactions)
    const dis = await board.disputeRejection({ address: wrk.address }, { taskId, statement: 'The check passes on the submitted SHA.' })
    await sdk.sendAll(w(worker), c.publicClient, dis.transactions)

    const arb = await signIn(board, arbitrator)
    const caller = { address: arb.address }
    await board.arbiterLease(caller, { runner: 'fork-test' })
    const { bundleHash } = await board.getDisputeBundle(caller, { taskId })
    const prepared = await board.prepareRuling(caller, {
      taskId, forWorker: true, slashLoser: false, reason: 'The required check passed on the submitted SHA; the rejection names no defect.', bundleHash, runner: 'fork-test',
    })
    const signature = await sdk.signTypedDataJson(sdk.wallet(NET, arbitrator, url), prepared.sign.typedData)
    // The relay broadcasts, then the process dies before recording the hash: simulate by sending it ourselves.
    const ruling = prepared.ruling as sdk.Ruling
    const workerBefore = await sdk.balanceOf(c, c.deployment.rewardTokens[0] as Hex, worker.address)
    await sdk.ruleWithSignature(c, w(creator), { ...ruling, jobId: BigInt(ruling.jobId), deadline: BigInt(ruling.deadline), nonce: BigInt(ruling.nonce) }, signature as Hex)
    const restarted = boot()
    const relayNonce = await c.publicClient.getTransactionCount({ address: relay.address })
    const again = await restarted.submitRuling(caller, { taskId, signature })
    expect(again).toMatchObject({ relayed: true })
    const twice = await restarted.submitRuling(caller, { taskId, signature })
    expect(twice).toMatchObject({ relayed: true })
    expect(await c.publicClient.getTransactionCount({ address: relay.address })).toBe(relayNonce)
    expect((await sdk.balanceOf(c, c.deployment.rewardTokens[0] as Hex, worker.address)) - workerBefore).toBe(5_000_000n)
    // The recorded decision is final on the board: a different proposal gets the recorded one back (R114-08).
    const reasked = await restarted.prepareRuling(caller, {
      taskId, forWorker: false, slashLoser: false, reason: 'A different model run that would rule the other way.', bundleHash, runner: 'fork-test',
    }).catch((e: Error) => e)
    if (!(reasked instanceof Error)) expect(reasked.decision.forWorker).toBe(true)
  }, 300_000)
})
