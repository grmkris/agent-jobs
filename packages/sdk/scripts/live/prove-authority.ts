/** P0 uses isolated API-created fixture identities. Stop at the first failed proof. */
import { generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { PrivyApi, PrivyApiError, type PrivyResponse } from '../privy/client.ts'
import { localEnv, required } from '../privy/env.ts'
import { p256AuthorizationSigner } from '../../src/p256.ts'
import { appEnforced, config, schema, signingShapes, type SigningShape } from '../privy/policy.ts'
import { AuthorityChain } from './authority-chain.ts'
import { proveRegistration } from './authority-registration.ts'
import { proveAllowance } from './authority-allowance.ts'
import { proveGas } from './authority-gas.ts'
import { recoverTypedDataAddress, type Address } from 'viem'

const privateDirectory = new URL('./.local/', import.meta.url)
const privatePath = new URL('authority.json', privateDirectory)
const evidenceDirectory = new URL('../../../../docs/evidence/agent-first-v2/', import.meta.url)
const evidencePath = new URL('p0-authority.json', evidenceDirectory)

interface ProofResult {
  proof: number
  name: string
  status: 'pass' | 'pass-with-note' | 'fail' | 'not-run' | 'deferred'
  details: unknown[]
}

interface FixtureState {
  runId: string
  userId?: string
  walletId?: string
  address?: string
  pending?: string
}

const names = [
  'User-owned server wallet, routine signer, Worker WebCrypto RPC authorization',
  'Policy denials and provider/application enforcement boundaries',
  'Routine key cannot mutate policy or wallet signers',
  'Relay registration to a DeleGator and upgraded agent-wallet consent',
  'Nested period allowance redemption, encoding, start and rollover',
  'Measured gas for publish, nested redemption, registration and wallet consent',
  'Client-side recovery signing for the server-created wallet',
]

function saveFixture(state: FixtureState): void {
  mkdirSync(privateDirectory, { recursive: true, mode: 0o700 })
  const temporary = new URL('authority.json.tmp', privateDirectory)
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, privatePath)
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function rpcBody(shape: SigningShape, message: Record<string, unknown>) {
  return {
    method: 'eth_signTypedData_v4',
    params: {
      typed_data: {
        ...schema(shape),
        domain: { name: shape.name, version: '1', chainId: config.chainId, verifyingContract: shape.contract },
        message,
      },
    },
  }
}

async function prove(): Promise<void> {
  const env = localEnv()
  const api = new PrivyApi(required(env, 'PRIVY_APP_ID'), required(env, 'PRIVY_APP_SECRET'))
  const signerId = required(env, 'PRIVY_SIGNER_ID')
  const policyId = required(env, 'PRIVY_POLICY_ID')
  const sign = await p256AuthorizationSigner(required(env, 'PRIVY_SIGNER_KEY'))
  const fixture: FixtureState = existsSync(privatePath)
    ? JSON.parse(readFileSync(privatePath, 'utf8')) : { runId: crypto.randomUUID() }
  saveFixture(fixture)
  const prior = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, 'utf8')) : undefined
  check(!prior || prior.fixture.runId === fixture.runId, 'Evidence and fixture run do not match')
  const results: ProofResult[] = prior?.results ?? names.map((name, index) => ({ proof: index + 1, name, status: 'not-run', details: [] }))
  check(!results.some(result => result.status === 'fail'), 'A prior proof failed; wait for Claude/Kris before further live work')
  for (const result of results) {
    if (result.status === 'pass' || result.status === 'pass-with-note' || result.status === 'deferred') {
      result.details = result.details.filter(detail => !(typeof detail === 'string' && detail.startsWith('Proof failed;')))
    }
  }
  const evidence = {
    recordedAt: prior?.recordedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceStatus: 'uncommitted P0 scripts',
    network: 'monad-testnet',
    chainId: 10143,
    identity: 'fixture (API-created; no genuine user session)',
    fixture,
    signerId,
    policyId,
    appEnforced,
    transactions: prior?.transactions ?? [],
    results,
  }
  function writeEvidence(): void {
    mkdirSync(evidenceDirectory, { recursive: true })
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  }
  async function proof(number: number, action: (details: unknown[]) => Promise<void>): Promise<void> {
    const result = results[number - 1]!
    if (result.status === 'pass' || result.status === 'pass-with-note' || result.status === 'deferred') {
      console.log(`P0.${number} ${result.status.toUpperCase()}: retained fixture proof`)
      return
    }
    try {
      await action(result.details)
      if (number !== 7) result.status = 'pass'
    } catch (error) {
      result.status = 'fail'
      // Never print provider response bodies, signing payloads, or credential-bearing RPC errors.
      result.details.push(error instanceof PrivyApiError ? error.message : 'Proof failed; private journal retains the operation stage and signed bytes')
      writeEvidence()
      console.log(`P0.${number} FAIL: ${result.name}`)
      for (const remaining of results.filter((item) => item.status === 'not-run')) {
        console.log(`P0.${remaining.proof} NOT RUN: stopped after failed proof`)
      }
      throw new Error(`P0.${number} failed; stop for Claude/Kris before further live work`, { cause: error })
    }
    writeEvidence()
    console.log(`P0.${number} ${result.status.toUpperCase()}: ${result.name}`)
  }

  const selection = signingShapes[0]!
  const selectionMessage = {
    jobId: '0', worker: config.roles.relay, agentId: '0', termsHash: `0x${'00'.repeat(32)}`,
    activateBy: String(Math.floor(Date.now() / 1000) + 300), nonce: '0',
  }
  await proof(1, async (details) => {
    if (!fixture.userId) {
      check(!fixture.pending, 'Ambiguous fixture creation; reconcile the original request')
      fixture.pending = 'user'
      saveFixture(fixture)
      const user = await api.checked('POST', '/users', {
        linked_accounts: [{ type: 'email', address: `sidequest-v2-p0-${fixture.runId}@fixture.invalid` }],
        custom_metadata: { fixture: true, purpose: 'Sidequest spec v2 P0', run_id: fixture.runId },
      })
      check(typeof user.id === 'string', 'Privy did not return a fixture user ID')
      fixture.userId = user.id
      delete fixture.pending
      saveFixture(fixture)
    }
    if (!fixture.walletId) {
      check(!fixture.pending, 'Ambiguous fixture wallet creation; reconcile the original request')
      fixture.pending = 'wallet'
      saveFixture(fixture)
      const wallet = await api.checked('POST', '/wallets', {
        chain_type: 'ethereum', owner: { user_id: fixture.userId },
        additional_signers: [{ signer_id: signerId, override_policy_ids: [policyId] }],
      }, undefined, `sidequest-v2-p0-wallet-${fixture.runId}`)
      check(typeof wallet.id === 'string' && typeof wallet.address === 'string', 'Privy did not return fixture wallet identifiers')
      fixture.walletId = wallet.id
      fixture.address = wallet.address
      delete fixture.pending
      saveFixture(fixture)
    }
    const wallet = await api.checked('GET', `/wallets/${fixture.walletId}`)
    check(wallet.chain_type === 'ethereum' && wallet.address === fixture.address, 'Fixture wallet binding mismatch')
    const owner = await api.checked('GET', `/key_quorums/${wallet.owner_id}`)
    const users = owner.user_ids as string[]
    check(users.length === 1 && users[0] === fixture.userId, 'Fixture wallet is not exclusively user-owned')
    const signers = wallet.additional_signers as { signer_id: string; override_policy_ids: string[] }[]
    check(signers.length === 1 && signers[0]?.signer_id === signerId &&
      JSON.stringify(signers[0].override_policy_ids) === JSON.stringify([policyId]), 'Routine signer/policy binding mismatch')
    const body = rpcBody(selection, selectionMessage)
    const rpc = await api.checked('POST', `/wallets/${fixture.walletId}/rpc`, body, sign, crypto.randomUUID())
    const data = rpc.data as { signature: string }
    check(typeof data.signature === 'string', 'RPC returned no signature')
    const recovered = await recoverTypedDataAddress({
      domain: body.params.typed_data.domain,
      types: body.params.typed_data.types,
      primaryType: selection.primaryType,
      message: selectionMessage,
      signature: data.signature as `0x${string}`,
    } as never)
    check(recovered.toLowerCase() === fixture.address?.toLowerCase(), 'RPC signature is not the agent wallet signature')
    details.push({ userId: fixture.userId, walletId: fixture.walletId, address: fixture.address,
      userOwnerVerified: true, signerPolicyVerified: true, webCryptoRpcAccepted: true, recoveredAgentAddress: recovered })
  })

  async function denial(label: string, body: Record<string, unknown>, details: unknown[], route = `/wallets/${fixture.walletId}/rpc`): Promise<void> {
    const response: PrivyResponse = await api.request('POST', route, body, sign, crypto.randomUUID())
    details.push({ label, httpStatus: response.status, code: response.code })
    check(response.status >= 400 && response.status < 500 && /policy/.test(response.code), `${label}: no proven policy denial (HTTP ${response.status}, ${response.code})`)
  }
  await proof(2, async (details) => {
    const correct = rpcBody(selection, selectionMessage)
    const wrongChain = structuredClone(correct)
    wrongChain.params.typed_data.domain.chainId = 143
    await denial('wrong chain', wrongChain, details)
    const wrongDomain = structuredClone(correct)
    wrongDomain.params.typed_data.domain.verifyingContract = config.roles.relay
    await denial('wrong verifying contract', wrongDomain, details)
    const wrongType = structuredClone(correct)
    wrongType.params.typed_data.primary_type = 'UnapprovedSelection'
    wrongType.params.typed_data.types = { EIP712Domain: correct.params.typed_data.types.EIP712Domain!,
      UnapprovedSelection: [...selection.types.Selection!] }
    await denial('wrong primary type', wrongType, details)
    const wrongSchema = structuredClone(correct)
    wrongSchema.params.typed_data.types.Selection = [...selection.types.Selection!].toReversed()
    await denial('wrong exact schema', wrongSchema, details)
    const delegationShape = signingShapes.find((shape) => shape.primaryType === 'Delegation')!
    await denial('wrong delegate', rpcBody(delegationShape, {
      delegate: config.roles.admin, delegator: fixture.address, authority: `0x${'ff'.repeat(32)}`, caveats: [], salt: '0',
    }), details)
    const consentShape = signingShapes.find((shape) => shape.primaryType === 'AgentWalletSet')!
    await denial('wrong newWallet', rpcBody(consentShape, {
      agentId: '0', newWallet: config.roles.relay, owner: config.roles.admin, deadline: String(Math.floor(Date.now() / 1000) + 300),
    }), details)
    await denial('transaction sending', {
      method: 'eth_sendTransaction', caip2: 'eip155:10143', params: { transaction: { to: fixture.address, value: '0x0' } },
    }, details)
    await denial('transaction signing', {
      method: 'eth_signTransaction', params: { transaction: {
        type: 2, chain_id: 10143, to: fixture.address, value: '0x0', nonce: 0,
        gas_limit: '0x5208', max_fee_per_gas: '0x3b9aca00', max_priority_fee_per_gas: '0x0',
      } },
    }, details)
    await denial('wrong 7702 target', { method: 'eth_sign7702Authorization', params: {
      contract: config.roles.relay, chain_id: 10143, nonce: 0,
    } }, details)
    const publicKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey
    const jwk = publicKey.export({ format: 'jwk' })
    const rawPoint = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')])
    const probes = [
      { label: 'raw point, no authorization', key: rawPoint, authorization: undefined },
      { label: 'raw point, routine authorization', key: rawPoint, authorization: sign },
      { label: 'SPKI, routine authorization', key: publicKey.export({ format: 'der', type: 'spki' }), authorization: sign },
    ]
    for (const probe of probes) {
      const response = await api.request('POST', `/wallets/${fixture.walletId}/export`,
        { encryption_type: 'HPKE', recipient_public_key: probe.key.toString('base64') }, probe.authorization)
      details.push({ exportProbe: probe.label, httpStatus: response.status, code: response.code })
      check(response.status >= 400 && response.status < 500, 'Fixture export was not refused')
    }
    const policy = await api.checked('GET', `/policies/${policyId}`)
    const exportRules = (policy.rules as { method: string; action: string }[]).filter(rule => /export/.test(rule.method))
    check(exportRules.every(rule => rule.action === 'DENY'), 'Policy permits export')
    details.push({ note: 'Export refused; these probes do not prove that export reached policy evaluation; no positive owner control is available for this fixture.',
      exportRules, noExportAllowRule: true, unmatchedMethodsDefaultDeny: true, appEnforced,
      providerEnforced: ['typed-data chainId', 'verifyingContract', 'primaryType', 'exact types schema',
        'Delegation.delegate', 'AgentWalletSet.newWallet = signing wallet', '7702 target', 'no transaction signing/sending'] })
  })
  const exportProbes = results[1]!.details.filter((item) => typeof item === 'object' && item !== null && 'exportProbe' in item)
  if (exportProbes.length > 0) {
    results[1]!.status = 'pass-with-note'
    writeEvidence()
    console.log('P0.2 PASS-WITH-NOTE: export refused; bounded classification is recorded separately from policy denials')
  }

  await proof(3, async (details) => {
    const policy = await api.checked('GET', `/policies/${policyId}`)
    const policyResponse = await api.request('PATCH', `/policies/${policyId}`, { name: `${policy.name}` }, sign)
    details.push({ label: 'policy update with routine key', httpStatus: policyResponse.status, code: policyResponse.code })
    check(policyResponse.status === 401 || policyResponse.status === 403, 'Routine key policy mutation was not refused by authorization')
    const walletBefore = await api.checked('GET', `/wallets/${fixture.walletId}`)
    const walletResponse = await api.request('PATCH', `/wallets/${fixture.walletId}`, { additional_signers: [] }, sign)
    details.push({ label: 'signer removal with routine key', httpStatus: walletResponse.status, code: walletResponse.code })
    check(walletResponse.status === 401 || walletResponse.status === 403, 'Routine key signer mutation was not refused by authorization')
    const policyAfter = await api.checked('GET', `/policies/${policyId}`)
    const walletAfter = await api.checked('GET', `/wallets/${fixture.walletId}`)
    check(policyAfter.name === policy.name && JSON.stringify(walletAfter.additional_signers) === JSON.stringify(walletBefore.additional_signers),
      'Authority changed during denied mutations')
  })

  const chain = new AuthorityChain(fixture.runId, fixture.address as Address, fixture.walletId as string, api, sign, env)
  await proof(4, async (details) => {
    await proveRegistration(chain, details)
    evidence.transactions = chain.receipts
  })
  await proof(5, async (details) => {
    await proveAllowance(chain, details)
    evidence.transactions = chain.receipts
  })
  await proof(6, async (details) => {
    await proveGas(chain, details)
    evidence.transactions = chain.receipts
  })
  await proof(7, async (details) => {
    // The plan permits genuine browser recovery signing to remain with Kris/P8 when no genuine user session exists.
    details.push({ status: 'deferred', reason: 'Fixture is API-created and has no genuine Privy browser session; P0.1 proved the server wallet WebCrypto signer only.',
      requiredAt: 'P8 genuine-user acceptance', serverFixtureSignature: false })
    results[6]!.status = 'deferred'
  })

  const manager = chain.ctx.deployment.delegation.manager
  const { delegationHash, delegationManagerAbi } = await import('../../src/delegation/index.ts')
  for (const key of ['allowance/short-period', 'gas/weekly-allowance']) {
    const grant = chain.journal.state.values[key] as import('../../src/delegation/index.ts').Delegation
    check(await chain.ctx.publicClient.readContract({ address: manager, abi: delegationManagerAbi,
      functionName: 'disabledDelegations', args: [delegationHash(grant)] }), 'Fixture allowance was not disabled')
  }
  Object.assign(evidence, chain.summary())
  writeEvidence()
}

try {
  await prove()
} catch (error) {
  console.error(error instanceof PrivyApiError ? error.message : 'P0 stopped; see sanitized proof evidence')
  process.exitCode = 1
}
