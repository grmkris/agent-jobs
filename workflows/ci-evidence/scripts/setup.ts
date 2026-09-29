import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { encodeDeployData, type Hex } from 'viem'
import { abi, config, configPath, fail, loadKey, preflight, registration, root, rpc, sendOnce, sim, jsonText, verifyDeployment } from './common.ts'

async function main() {
  if (process.argv[2] === 'cleanup') {
    if (config.chainId !== 10143 || await rpc.getChainId() !== 10143) throw new Error('testnet only')
    await registration(false, 'disable-verifier')
    console.log('Simulation receiver is not registered as a verifier.')
    return
  }
  if (process.argv.length > 2) throw new Error('usage: pnpm cre:setup')
  const result = await preflight()
  if ((await rpc.readContract({ address: sim.evaluator, abi, functionName: 'admin' })).toLowerCase() !== loadKey().address.toLowerCase()) throw new Error('evaluator admin mismatch')
  if (!sim.gate) {
    const artifact = JSON.parse(readFileSync(resolve(root, 'contracts/out/SimulationReportGate.sol/SimulationReportGate.json'), 'utf8'))
    const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object as Hex, args: [sim.evaluator, sim.forwarder, result.reportHash] })
    const receipt = await sendOnce('deploy-simulation-gate', data)
    if (!receipt.contractAddress) throw new Error('deployment receipt has no contract address')
    sim.gate = receipt.contractAddress
  }
  sim.receiver = await rpc.readContract({ address: sim.gate, abi, functionName: 'receiver' })
  sim.reportHash = await rpc.readContract({ address: sim.gate, abi, functionName: 'reportHash' })
  if (sim.reportHash !== result.reportHash) throw new Error('deployed gate pins a different report')
  if ((await rpc.readContract({ address: sim.gate, abi, functionName: 'forwarder' })).toLowerCase() !== sim.forwarder.toLowerCase()) throw new Error('gate forwarder mismatch')
  if ((await rpc.readContract({ address: sim.receiver, abi, functionName: 'evaluator' })).toLowerCase() !== sim.evaluator.toLowerCase()) throw new Error('receiver evaluator mismatch')
  await verifyDeployment()
  writeFileSync(configPath, jsonText(config))
  console.log(jsonText({ gate: sim.gate, receiver: sim.receiver, reportHash: sim.reportHash, digest: result.digest }))
  // Registration is deferred to the broadcast wrapper, which revokes it in finally.
}
main().catch(fail)
