import assert from 'node:assert/strict'
import test from 'node:test'
import { accountId, stateMode, targets, validateStateRecord } from './state.ts'

test('a remote-state shell variable cannot redirect staging to another backend', () => {
  assert.equal(stateMode({}), 'local')
  assert.equal(stateMode({ AGENT_JOBS_STAGE: 'staging', ALCHEMY_STATE_MODE: 'local' }), 'local')
  for (const env of [
    { ALCHEMY_REMOTE_STATE: '1' },
    { AGENT_JOBS_STAGE: 'staging', ALCHEMY_STATE_MODE: 'remote' },
    { AGENT_JOBS_STAGE: 'prod', AGENT_JOBS_NETWORK: 'monad-mainnet', ALCHEMY_REMOTE_STATE: '1', ALCHEMY_STATE_MODE: 'local' },
    { ALCHEMY_STATE_MODE: 'fallback' },
  ]) assert.throws(() => stateMode(env))
  assert.equal(stateMode({ AGENT_JOBS_STAGE: 'prod', AGENT_JOBS_NETWORK: 'monad-mainnet', ALCHEMY_REMOTE_STATE: '1' }), 'remote')
})

test('staging updates require the original ready resource and live provider', () => {
  const original = { logicalId: 'Api', fqn: 'Api', status: 'updated', providerMode: 'live', instanceId: '0'.repeat(32), attr: { workerName: targets.Api, accountId } }
  assert.doesNotThrow(() => validateStateRecord('Api', original))
  for (const change of [
    { logicalId: 'Other' },
    { fqn: 'duplicate/Api' },
    { status: 'creating' },
    { status: 'updating' },
    { providerMode: 'local' },
    { providerMode: undefined },
    { instanceId: '' },
    { attr: { workerName: 'agentjobs-api-staging-wifchnd47xdh3tvm', accountId } },
    { attr: { workerName: targets.Api, accountId: 'other' } },
  ]) assert.throws(() => validateStateRecord('Api', { ...original, ...change }))
})
