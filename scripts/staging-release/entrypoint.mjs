import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateExistingStackRelease, readBoundedFile } from './guard.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const stagingScript = 'node scripts/staging-release/release.mjs'
const offlineScripts = { 'staging:review': 'node scripts/staging-release/guard.mjs', 'staging:digests': 'node scripts/staging-release/digests.mjs' }
const missingApprovals = ['live-directory-namespace-and-binding', 'approved-migration-tag-transition', 'compiled-class-and-provider-artifact-proof', 'workerd-and-provider-rollback-compatibility']

export function validatePackageBoundary(manifest) {
  const scripts = manifest?.scripts
  return scripts !== null && typeof scripts === 'object' && !Array.isArray(scripts)
    && scripts['deploy:staging'] === stagingScript
    && Object.entries(offlineScripts).every(([name, command]) => scripts[name] === command)
    && ['deploy:staging', ...Object.keys(offlineScripts)].every((name) => !Object.hasOwn(scripts, `pre${name}`) && !Object.hasOwn(scripts, `post${name}`))
}

export function evaluateStagingCommand(args, now = Date.now()) {
  let evidence = { ok: false, blockers: ['review-input-required'] }
  let packageSha256 = null
  try {
    const filename = resolve(repository, 'package.json')
    const stat = lstatSync(filename)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1_048_576) throw new Error('package')
    const bytes = readFileSync(filename)
    if (!validatePackageBoundary(JSON.parse(bytes.toString('utf8')))) throw new Error('package')
    packageSha256 = createHash('sha256').update(bytes).digest('hex')
    if (!Array.isArray(args) || args.length > 1 || args.some((argument) => typeof argument !== 'string' || argument.startsWith('-'))) {
      evidence = { ok: false, blockers: ['invalid-staging-arguments'] }
    } else if (args.length === 1) {
      evidence = evaluateExistingStackRelease(JSON.parse(readBoundedFile(resolve(process.cwd(), args[0])).toString('utf8')), now)
    }
  } catch {
    evidence = { ok: false, blockers: ['invalid-package-or-review-input'] }
  }
  return {
    ...evidence,
    schemaVersion: 1,
    ok: false,
    packetValid: evidence.ok === true,
    mode: 'release-held',
    evidenceTier: 'offline-saved-evidence-only',
    liveEvidence: false,
    applyAuthorized: false,
    releaseReady: false,
    deployCommand: null,
    mutation: 'forbidden',
    packageSha256,
    blockers: [...new Set([...(evidence.blockers ?? []), 'live-release-hold', ...missingApprovals])],
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(evaluateStagingCommand(process.argv.slice(2))))
  process.exitCode = 1
}
