import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import proposed from '../../../docs/p0-prod-artifact.json' with { type: 'json' }
import { MAINNET_LIVE } from '../../explore/src/release.ts'
import { probeRelease } from '../src/deploy-preflight.ts'
import { validateExploreRelease, validateReleaseProbe, type ProdArtifact } from '../src/prod-config.ts'
import { preLaunch } from './pre-launch.ts'

// PROD-GATE-006: Explore's MAINNET_LIVE (apps/explore/src/release.ts) is pinned in the artifact, agrees with the
// admission mode, and the deployed /release.json is checked against it.

const artifact = (drain: boolean, mainnetLive: boolean) =>
  ({ ...(structuredClone(proposed) as ProdArtifact), admission: { drain }, explore: { mainnetLive } })

test('the checked-in artifact pins the current source value, drained', () => {
  const checkedIn = proposed as ProdArtifact
  expect(checkedIn.explore.mainnetLive).toBe(MAINNET_LIVE)
  expect(validateExploreRelease(checkedIn, MAINNET_LIVE)).toEqual([])
})

test('a drained setup release needs MAINNET_LIVE false; an open release needs it true', () => {
  expect(validateExploreRelease(artifact(true, false), false)).toEqual([])
  expect(validateExploreRelease(artifact(false, true), true)).toEqual([])
  expect(validateExploreRelease(artifact(false, false), false)).toEqual(['explore:mainnetLive must be true to open admission'])
  expect(validateExploreRelease(artifact(true, true), true)).toEqual(['explore:mainnetLive must be false while admission is drained'])
})

test('the pinned value must equal release.ts', () => {
  expect(validateExploreRelease(artifact(false, true), false)).toEqual(['explore:mainnetLive differs from apps/explore/src/release.ts'])
  expect(validateExploreRelease(artifact(true, false), true)).toEqual(['explore:mainnetLive differs from apps/explore/src/release.ts'])
})

test('a missing or malformed pin, or a missing admission mode, refuses', () => {
  const missing = artifact(true, false) as Partial<ProdArtifact>
  delete missing.explore
  expect(validateExploreRelease(missing as ProdArtifact, false)).toEqual(['explore:mainnetLive'])
  expect(validateExploreRelease({ ...artifact(true, false), explore: { mainnetLive: 'false' as unknown as boolean } }, false)).toEqual(['explore:mainnetLive'])
  expect(validateExploreRelease({ ...artifact(true, false), admission: {} as ProdArtifact['admission'] }, false)).toEqual(['admission mode'])
})

test('the served release.json must equal the artifact', () => {
  // What the vite build emits on mainnet: writesOpen is mainnetLive there.
  expect(validateReleaseProbe(artifact(true, false), { network: 'monad-mainnet', mainnetLive: false, writesOpen: false })).toEqual([])
  expect(validateReleaseProbe(artifact(false, true), { network: 'monad-mainnet', mainnetLive: true, writesOpen: true })).toEqual([])
  expect(validateReleaseProbe(artifact(false, true), { network: 'monad-mainnet', mainnetLive: false, writesOpen: false }))
    .toEqual(['release.json mainnetLive', 'release.json writesOpen'])
  expect(validateReleaseProbe(artifact(true, false), { network: 'monad-testnet', mainnetLive: false, writesOpen: true }))
    .toEqual(['release.json network', 'release.json writesOpen'])
  expect(validateReleaseProbe(artifact(true, false), { network: 'monad-mainnet', mainnetLive: 'false', writesOpen: false })).toEqual(['release.json mainnetLive'])
  expect(validateReleaseProbe(artifact(true, false), null)).toEqual(['release.json is not an object'])
  expect(validateReleaseProbe(artifact(true, false), 'ok')).toEqual(['release.json is not an object'])
})

const fake = (respond: (url: string) => Response | Promise<Response>) => {
  const urls: string[] = []
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    urls.push(url)
    return await respond(url)
  }) as typeof fetch
  return { fetcher, urls }
}

test('the probe GETs <origin>/release.json and compares it', async () => {
  const { fetcher, urls } = fake(() => Response.json({ network: 'monad-mainnet', mainnetLive: false, writesOpen: false }))
  expect(await probeRelease(artifact(true, false), 'https://sidequest.exchange', fetcher)).toEqual([])
  expect(urls).toEqual(['https://sidequest.exchange/release.json'])
  expect(await probeRelease(artifact(false, true), 'https://sidequest.exchange/', fetcher)).toEqual(['release.json mainnetLive', 'release.json writesOpen'])
})

test('a failed, non-OK or non-JSON probe, or a bad origin, refuses', async () => {
  expect(await probeRelease(artifact(true, false), 'https://sidequest.exchange', fake(() => new Response('not found', { status: 404 })).fetcher)).toEqual(['release.json unreachable'])
  expect(await probeRelease(artifact(true, false), 'https://sidequest.exchange', fake(() => new Response('<html>', { status: 200 })).fetcher)).toEqual(['release.json unreachable'])
  expect(await probeRelease(artifact(true, false), 'https://sidequest.exchange', fake(() => { throw new Error('offline') }).fetcher)).toEqual(['release.json unreachable'])
  expect(await probeRelease(artifact(true, false), 'not a url', fake(() => Response.json({})).fetcher)).toEqual(['release.json origin invalid'])
})

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const hasBun = spawnSync('bun', ['--version']).status === 0

test.skipIf(!hasBun)('the runbook command starts and judges the artifact (its imports resolve from scripts/)', () => {
  // The check runner sets FORCE_COLOR; without this, Bun colours stderr and the anchored match below misses.
  const { FORCE_COLOR: _, ...env } = process.env
  const run = spawnSync('bun', ['scripts/preflight-prod.ts', 'docs/p0-prod-artifact.json'], { cwd: repo, encoding: 'utf8', timeout: 60_000, env: { ...env, NO_COLOR: '1' } })
  expect(run.stderr).not.toContain('Cannot find module')
  // LAUNCH-AUDIT-FIX-003: once launch has filled the checked-in artifact in, it passes; until then it is rejected only for
  // what launch still fills in (./pre-launch.ts), never for its Explore pin or a structural label.
  if (run.status === 0) {
    expect(run.stdout).toMatch(/^Sidequest v1 production structural preflight passed/)
  } else {
    expect(run.status).toBe(1)
    const rejected = /^production preflight rejected: (.+)$/m.exec(run.stderr)
    expect(rejected).not.toBeNull()
    expect((rejected?.[1] ?? '').split(', ').filter(label => !preLaunch(label))).toEqual([])
  }
})
