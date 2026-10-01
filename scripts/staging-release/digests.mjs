import { createHash } from 'node:crypto'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expected } from './evidence.mjs'
import { canonicalJson, fileByteLimit, packetByteLimit, readBoundedFile } from './guard.mjs'
import { sourceHashes } from './migration-fixtures.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const artifactRoot = resolve(scriptDir, 'review-artifacts')
const targetOrder = ['Api', 'Indexer', 'Explore']
const allowedExtensions = /\.(?:html|css|js|json|webmanifest|png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|txt|md)$/i
const unavailable = ['compiled-worker-provenance-unverified', 'compiled-directory-class-export-unverified', 'directory-namespace-tag-and-binding-unapproved', 'workerd-provider-rollback-unverified']

const byPath = (left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0

function fields(value, names) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name))
}

function refusal(code) {
  return { schemaVersion: 1, ok: false, artifactVerification: 'rejected', evidenceTier: 'offline-local-unverified', liveEvidence: false, releaseReady: false, applyAuthorized: false, deployCommand: null, mutation: 'forbidden', blockers: [code, ...unavailable] }
}

export function createDigestManifest(input) {
  try {
    if (!fields(input, ['schemaVersion', 'source', 'evidenceTier', 'targets']) || input.schemaVersion !== 1) throw new Error('shape')
    if (!fields(input.source, ['commit', 'tree']) || input.source.commit !== expected.commit || input.source.tree !== expected.tree) throw new Error('source')
    if (!['offline-synthetic', 'offline-local-unverified'].includes(input.evidenceTier) || !Array.isArray(input.targets) || input.targets.length !== 3) throw new Error('shape')
    let totalBytes = Buffer.byteLength(JSON.stringify(input), 'utf8')
    if (totalBytes > fileByteLimit) throw new Error('size')
    const seen = new Set()
    const targets = []
    for (const logicalId of targetOrder) {
      const matching = input.targets.filter((target) => target?.logicalId === logicalId)
      const target = matching[0]
      if (matching.length !== 1 || !fields(target, ['logicalId', 'resourceId', 'mainModule', 'modules', 'assets']) || target.resourceId !== expected.resources[logicalId]) throw new Error('target')
      if (!Array.isArray(target.modules) || target.modules.length === 0 || target.modules.length > 128 || !Array.isArray(target.assets) || target.assets.length > 4096) throw new Error('census')
      if (logicalId === 'Explore' ? !target.assets.some((asset) => typeof asset?.path === 'string' && basename(asset.path) === 'index.html') : target.assets.length !== 0) throw new Error('census')
      const hashFile = (descriptor, kind) => {
        if (!fields(descriptor, ['path']) || typeof descriptor.path !== 'string' || !descriptor.path.startsWith(`${logicalId}/`) || descriptor.path.includes('\\')) throw new Error('path')
        const filename = resolve(artifactRoot, descriptor.path)
        const inside = relative(artifactRoot, filename)
        if (inside !== descriptor.path || inside.startsWith('..') || seen.has(inside) || (kind === 'module' ? !inside.endsWith('.mjs') : !allowedExtensions.test(inside))) throw new Error('path')
        seen.add(inside)
        const bytes = readBoundedFile(filename)
        totalBytes += bytes.length
        if (totalBytes > packetByteLimit) throw new Error('size')
        return { path: inside, kind, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
      }
      const modules = target.modules.map((module) => hashFile(module, 'module')).toSorted(byPath)
      const assets = target.assets.map((asset) => hashFile(asset, 'asset')).toSorted(byPath)
      if (typeof target.mainModule !== 'string' || modules.filter((module) => module.path === target.mainModule).length !== 1) throw new Error('main')
      targets.push({ logicalId, resourceId: expected.resources[logicalId], mainModule: target.mainModule, modules, assets })
    }
    const toolSha256 = createHash('sha256').update(readBoundedFile('digests.mjs')).digest('hex')
    const build = {
      source: { ...input.source, verifiedCompiledProvenance: false },
      targets,
      sourceHashes,
      toolSha256,
      nodeVersion: process.version,
      sqliteVersion: process.versions.sqlite,
      compiledExports: { required: ['Board', 'DirectoryObject'], verified: false },
    }
    return {
      schemaVersion: 1,
      ok: true,
      artifactVerification: 'local-bytes-only',
      evidenceTier: input.evidenceTier,
      liveEvidence: false,
      releaseReady: false,
      applyAuthorized: false,
      deployCommand: null,
      mutation: 'forbidden',
      blockers: [...unavailable],
      build,
      manifestSha256: createHash('sha256').update(canonicalJson({ schemaVersion: 1, evidenceTier: input.evidenceTier, build })).digest('hex'),
    }
  } catch {
    return refusal('invalid-or-unavailable-build-artifacts')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2].startsWith('-')) throw new Error('argument')
    const input = JSON.parse(readBoundedFile(resolve(process.cwd(), process.argv[2])).toString('utf8'))
    const result = createDigestManifest(input)
    console.log(JSON.stringify(result))
    process.exitCode = result.ok ? 0 : 1
  } catch {
    console.log(JSON.stringify(refusal('invalid-or-unreadable-digest-input')))
    process.exitCode = 1
  }
}
