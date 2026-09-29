import {
  consensusIdenticalAggregation, decodeJson, EVMClient, getNetwork, handler,
  hexToBase64, HTTPCapability, HTTPClient, json, ok, Runner, TxStatus,
  type HTTPPayload, type HTTPSendRequester, type Runtime,
} from '@chainlink/cre-sdk'
import { EVM_PB } from '@chainlink/cre-sdk/pb'
import { bytesToHex, keccak256, type Address, type Hex } from 'viem'
import { buildEvidence, canonicalJson, checkRunsUrl, encodeReport, evidenceDigest, requestSchema, type EvidenceRequest } from './evidence.ts'

interface Config {
  chainId: number
  network: string
  cre: { simulation: { gate: Address; receiver: Address; evaluator: Address; reportHash: Hex; gasLimit: string } }
}

function fetchChecks(send: HTTPSendRequester, input: EvidenceRequest, now: number): string {
  const response = send.sendRequest({
    url: checkRunsUrl(input), method: 'GET',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agent-jobs-cre-simulation', 'X-GitHub-Api-Version': '2022-11-28' },
  }).result()
  if (!ok(response)) throw new Error(`GitHub unavailable: HTTP ${response.statusCode}`)
  // Each node validates the response and hashes the same normalized fields before consensus.
  return canonicalJson(buildEvidence(input, json(response), now))
}

function onHttp(runtime: Runtime<Config>, payload: HTTPPayload): string {
  const cfg = runtime.config
  if (cfg.chainId !== 10143 || cfg.network !== 'monad-testnet') throw new Error('only Monad testnet is supported')
  const input = requestSchema.parse(decodeJson(payload.input))
  const now = Math.floor(runtime.now().getTime() / 1000)
  const normalized = new HTTPClient().sendRequest(runtime, fetchChecks, consensusIdenticalAggregation<string>())(input, now).result()
  const parsed = JSON.parse(normalized) as { attestation: ReturnType<typeof buildEvidence>['attestation']; checksJson: string }
  const a = { ...parsed.attestation, jobId: BigInt(parsed.attestation.jobId), validUntil: BigInt(parsed.attestation.validUntil) }
  const reportData = encodeReport(a)
  const sim = cfg.cre.simulation
  if (keccak256(reportData) !== sim.reportHash) throw new Error('report differs from the approved simulation gate payload')
  const digest = evidenceDigest(a, cfg.chainId, sim.evaluator)
  runtime.log(`CI_EVIDENCE ${canonicalJson({ attestation: a, checks: JSON.parse(parsed.checksJson), digest, reportHash: sim.reportHash })}`)
  const chain = getNetwork({ chainFamily: 'evm', chainSelectorName: cfg.network, isTestnet: true })
  if (!chain) throw new Error('Monad testnet selector unavailable')
  const report = runtime.report({ encodedPayload: hexToBase64(reportData), encoderName: 'evm', signingAlgo: 'ecdsa', hashingAlgo: 'keccak256' }).result()
  const result = new EVMClient(chain.chainSelector.selector).writeReport(runtime, {
    receiver: sim.gate, report, gasConfig: { gasLimit: sim.gasLimit },
  }).result()
  const txHash = bytesToHex(result.txHash ?? new Uint8Array(32))
  runtime.log(`CI_REPORT_TX ${txHash}`)
  runtime.log(`CI_REPORT_STATUS ${canonicalJson({ txStatus: result.txStatus, receiverStatus: result.receiverContractExecutionStatus })}`)
  if (result.txStatus !== TxStatus.SUCCESS || result.receiverContractExecutionStatus === EVM_PB.ReceiverContractExecutionStatus.REVERTED) throw new Error(`report delivery failed: ${result.txStatus}/${result.receiverContractExecutionStatus}`)
  return canonicalJson({ digest, txHash, receiver: sim.receiver, gate: sim.gate })
}

export async function main() {
  const runner = await Runner.newRunner<Config>()
  await runner.run(() => [handler(new HTTPCapability().trigger({}), onHttp)])
}
