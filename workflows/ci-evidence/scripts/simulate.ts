import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEventLogs, type Hex } from 'viem'
import { abi, config, deployerKey, dir, fail, input, jsonText, loadKey, local, preflight, registration, root, rpc, save, sim, verifyDeployment } from './common.ts'

async function main() {
  const flags = process.argv.slice(2)
  if (flags.some((f) => f !== '--broadcast') || flags.length > 1) throw new Error('usage: pnpm cre:simulate [--broadcast]')
  const broadcast = flags.includes('--broadcast')
  const built = await preflight()
  if (!sim.gate || !sim.receiver || sim.reportHash !== built.reportHash) throw new Error('run pnpm cre:setup for this exact report first')
  const gateHash = await rpc.readContract({ address: sim.gate, abi, functionName: 'reportHash' })
  if (gateHash !== built.reportHash) throw new Error('onchain report gate mismatch')
  await verifyDeployment()
  if (broadcast && await rpc.readContract({ address: sim.evaluator, abi, functionName: 'usedDigest', args: [sim.receiver, built.digest] })) {
    const stored = await rpc.readContract({ address: sim.evaluator, abi, functionName: 'evidence', args: [BigInt(input.jobId), sim.receiver] })
    if (stored[0] !== built.digest) throw new Error('digest used but current evidence changed; inspect chain history')
    await registration(false, 'disable-verifier')
    console.log(jsonText({ alreadyRecorded: true, newBroadcast: false, digest: built.digest, receiver: sim.receiver, stored }))
    return
  }
  const account = loadKey()
  const operationPath = resolve(local, 'broadcast.json')
  const outputPath = resolve(local, broadcast ? 'simulate-broadcast.log' : 'simulate-dry-run.log')
  if (broadcast && existsSync(operationPath)) {
    const old = JSON.parse(readFileSync(operationPath, 'utf8'))
    throw new Error(`broadcast already attempted (${old.txHash ?? 'inspect journal and nonce'}); reconcile it, do not pay again`)
  }
  let output = ''
  let intent: Record<string, unknown> = {}
  try {
    if (broadcast) {
      // A public forwarder can only submit our immutable, pre-approved bytes through the gate.
      await registration(true, 'enable-verifier')
      const nonce = await rpc.getTransactionCount({ address: account.address, blockTag: 'pending' })
      if (nonce !== await rpc.getTransactionCount({ address: account.address, blockTag: 'latest' })) throw new Error('shared deployer has a pending transaction')
      const gasPrice = await rpc.getGasPrice()
      if (await rpc.getBalance({ address: account.address }) < BigInt(sim.gasLimit) * gasPrice + 30_000_000_000_000_000n) throw new Error('insufficient broadcast gas and cleanup reserve')
      intent = { chainId: config.chainId, sender: account.address, nonce, fromBlock: await rpc.getBlockNumber(), gate: sim.gate, receiver: sim.receiver, digest: built.digest, reportHash: built.reportHash, at: new Date().toISOString() }
      save(operationPath, intent)
    }
    const args = ['workflow', 'simulate', dir, '--target', 'simulation', '--non-interactive', '--trigger-index', '0', '--http-payload', resolve(dir, 'payload.json')]
    if (broadcast) args.push('--broadcast')
    console.log(`cre ${args.join(' ')}`)
    // CRE reads the key from its environment, never from argv or a tracked file.
    const child = spawn('cre', args, { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, CRE_ETH_PRIVATE_KEY: deployerKey() }, stdio: ['ignore', 'pipe', 'pipe'] })
    const stop = () => child.kill('SIGTERM')
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    const capture = (data: Buffer) => {
      const chunk = data.toString()
      output += chunk
      process.stdout.write(chunk)
      writeFileSync(outputPath, output, { mode: 0o600 })
      const hash = /CI_REPORT_TX (0x[0-9a-fA-F]{64})/.exec(output)?.[1]
      if (broadcast && hash) save(operationPath, { ...intent, txHash: hash })
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    const code = await new Promise<number | null>((done, reject) => { child.on('error', reject); child.on('close', done) })
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    if (code !== 0) throw new Error(`CRE simulator exit ${code}; see ${outputPath}`)
    if (!broadcast) return
    const txHash = /CI_REPORT_TX (0x[0-9a-fA-F]{64})/.exec(output)?.[1] as Hex | undefined
    if (!txHash || /^0x0+$/.test(txHash)) throw new Error('simulator did not report a broadcast transaction hash')
    const receipt = await rpc.waitForTransactionReceipt({ hash: txHash })
    if (receipt.status !== 'success') throw new Error(`broadcast reverted: ${txHash}`)
    const events = parseEventLogs({ abi, logs: receipt.logs })
    const attached = events.find((e) => e.eventName === 'EvidenceAttached' && e.address.toLowerCase() === sim.evaluator.toLowerCase())
    const received = events.find((e) => e.eventName === 'ReportReceived' && e.address.toLowerCase() === sim.receiver!.toLowerCase())
    if (!attached || attached.eventName !== 'EvidenceAttached' || !received) throw new Error('forwarder receipt lacks actual receiver/evaluator evidence')
    if (attached.args.digest !== built.digest || attached.args.verifier.toLowerCase() !== sim.receiver.toLowerCase() || attached.args.jobId !== BigInt(input.jobId)) throw new Error('unexpected EvidenceAttached binding')
    const stored = await rpc.readContract({ address: sim.evaluator, abi, functionName: 'evidence', args: [BigInt(input.jobId), sim.receiver] })
    const a = built.attestation
    if (stored[0] !== built.digest || stored[1] !== a.submissionHash || stored[2] !== a.policyHash || stored[3] !== a.testedSha || BigInt(stored[5]) !== a.validUntil || stored[6] !== a.conclusion) throw new Error('stored evidence differs from expected report')
    save(resolve(local, 'proof.json'), { ...intent, txHash, attestation: a, receipt, events, stored })
    save(operationPath, { ...intent, txHash, verified: true })
    console.log(`Verified receiver event, EvidenceAttached and stored digest ${built.digest}`)
  } finally {
    if (broadcast) {
      await registration(false, 'disable-verifier')
      const registered = await rpc.readContract({ address: sim.evaluator, abi, functionName: 'verifiers', args: [sim.receiver] })
      const boardAttesterRegistered = await rpc.readContract({ address: sim.evaluator, abi, functionName: 'verifiers', args: [config.roles.attester] })
      save(resolve(local, 'cleanup.json'), { receiver: sim.receiver, evaluator: sim.evaluator, registered, boardAttesterRegistered, at: new Date().toISOString() })
      console.log(jsonText({ receiver: sim.receiver, registered }))
    }
  }
}
main().catch(fail)
