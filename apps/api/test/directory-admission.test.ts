import { expect, it, vi } from 'vitest'
import { directoryAdmission } from '../src/directory-admission.ts'
import type { DirectoryCall } from '../src/directory-object.ts'
import type { AdmissionCall, AdmissionReply } from '../src/admission-rate.ts'

const wallet = '0x1111111111111111111111111111111111111111'
const request = (patch: Partial<DirectoryCall> = {}): DirectoryCall => ({ network: 'monad-mainnet', rpcUrl: '', audience: 'https://sidequest.exchange', agentId: '7', action: 'prepare', kind: 'Enrollment', payload: {}, admission: { boardId: 'public', bearer: 'session', caller: wallet, ip: '203.0.113.7' }, ...patch })
function fixture(reply: AdmissionReply = { ok: true }) {
  const admit = vi.fn(async (_input: AdmissionCall) => JSON.stringify(reply))
  const bindings = { NETWORK: 'monad-mainnet', Board: { idFromName: vi.fn(() => ({ toString: () => 'admission' })), get: () => ({ admit }) } }
  return { admit, bindings }
}

it('cannot hide a signed mutation behind a public-read tool label or forged metadata', async () => {
  const { bindings, admit } = fixture()
  const auth = { ...request().admission!, tool: 'list_directory', network: 'monad-testnet' }
  expect(await directoryAdmission(bindings, request({ action: 'submit', record: { kind: 'Heartbeat' }, admission: auth }))).toBeUndefined()
  expect(admit).toHaveBeenCalledExactlyOnceWith({ ...auth, network: 'monad-mainnet', tool: 'post_heartbeat' })
})

it('passes session, edge IP, drain refusal and retry metadata unchanged', async () => {
  const refusal = { ok: false as const, code: 'rate-limited', message: 'wallet write limit reached', retryAfter: 23 }
  const { bindings, admit } = fixture(refusal)
  expect(await directoryAdmission(bindings, request())).toEqual(refusal)
  expect(admit).toHaveBeenCalledExactlyOnceWith({ ...request().admission, network: 'monad-mainnet', tool: 'prepare_directory_enrollment' })
})

it('refuses malformed actions and runtime network mismatch before calling admission', async () => {
  const { bindings, admit } = fixture()
  expect(await directoryAdmission(bindings, request({ network: 'monad-testnet' }))).toMatchObject({ code: 'forbidden' })
  expect(await directoryAdmission(bindings, request({ kind: 'Unknown' as never }))).toMatchObject({ code: 'invalid' })
  expect(await directoryAdmission(bindings, request({ action: 'remove' as never }))).toMatchObject({ code: 'invalid' })
  expect(admit).not.toHaveBeenCalled()
})

it('keeps public reads and testnet signature flows free of mainnet write counters', async () => {
  const { bindings, admit } = fixture()
  expect(await directoryAdmission(bindings, request({ action: 'read' }))).toBeUndefined()
  expect(await directoryAdmission({ ...bindings, NETWORK: 'monad-testnet' }, request({ network: 'monad-testnet' }))).toBeUndefined()
  expect(admit).not.toHaveBeenCalled()
})

it('fails closed when the shared admission namespace is unavailable', async () => {
  expect(await directoryAdmission({ NETWORK: 'monad-mainnet' }, request())).toMatchObject({ code: 'unavailable' })
})
