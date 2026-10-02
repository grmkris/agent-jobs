import { createHash, createHmac, randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import { encodeDurableObjectTags, getDurableObjectTagMap } from 'alchemy/Cloudflare/Workers'
import { canonicalChange } from './approved-changes.mjs'

// Review B12-001: the apply digest commits to the payload the provider uploads for each Worker, not just to binding
// names and actions. Values (secret or plain text, JSON) enter as keyed commitments (HMAC under a private key that never
// leaves `.alchemy/recovery/`), so the printed packet carries no value and a low-entropy value cannot be guessed from it.
// Resource identities (database, bucket, Durable Object class, service) and Worker settings are in clear. Artifact
// bytes are the files of the provider's own build.

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** The private commitment key: 32 random bytes in a 0600 file, created once. Refuses a symlink or special file. */
export function commitmentKey(path) {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('commitment-key-invalid')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('commitment-key-invalid', { cause: error })
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeSync(fd, randomBytes(32).toString('hex')) } finally { closeSync(fd) }
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!fstatSync(fd).isFile()) throw new Error('commitment-key-invalid')
    const key = readFileSync(fd, 'utf8')
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('commitment-key-invalid')
    return Buffer.from(key, 'hex')
  } finally {
    closeSync(fd)
  }
}

/** Safe to print: identifies the key without revealing it, so a replaced key changes the digest. */
export const keyId = key => sha256(Buffer.concat([Buffer.from('agent-jobs/staging-release/commitment-key\n'), key]))

export const commit = (key, scope, value) => createHmac('sha256', key).update(canonicalChange({ scope, value })).digest('hex')

const isRedactedMarker = value => typeof value === 'object' && value !== null && value._tag === 'Redacted' && 'value' in value

/**
 * A JSON-stable copy for the digest, following the provider's own metadata hashing: Effects, functions, undefined and
 * class instances are dropped (they never reach an upload), dates become ISO strings, and every `Redacted` value is
 * replaced by its keyed commitment.
 */
export function materialize(value, seal, path = []) {
  if (value === undefined || typeof value === 'function' || Effect.isEffect(value)) return undefined
  if (Redacted.isRedacted(value)) return { commitment: seal(path, materialize(Redacted.value(value), seal, path)) }
  if (isRedactedMarker(value)) return { commitment: seal(path, materialize(value.value, seal, path)) }
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item, i) => materialize(item, seal, [...path, i]) ?? null)
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const out = {}
    for (const key of Object.keys(value).toSorted()) {
      const item = materialize(value[key], seal, [...path, key])
      if (item !== undefined) out[key] = item
    }
    return out
  }
  return undefined
}

const secretText = value => Redacted.isRedacted(value) ? (typeof Redacted.value(value) === 'string' ? Redacted.value(value) : undefined)
  : isRedactedMarker(value) && typeof value.value === 'string' ? value.value : undefined

/**
 * The wire bindings the pinned Worker provider uploads (`putWorker` in alchemy's WorkerProvider): the native binding
 * items with alchemy-only fields stripped, ASSETS when the Worker has assets, the five ALCHEMY_* runtime settings, then
 * every env entry not already bound (Redacted → secret_text, string → plain_text, anything else → json).
 */
export function wireBindings(node, { workerName, stack, accountId }) {
  const props = node.props ?? node.state?.props ?? {}
  const live = (node.bindings ?? []).filter(binding => binding.action !== 'delete')
  const wires = []
  for (const binding of live) {
    for (const item of binding.data?.bindings ?? []) {
      if (item.type === 'self_service') { wires.push({ type: 'service', name: item.name, service: workerName }); continue }
      if (item.type === 'durable_object_namespace' && item.transferredFrom !== undefined) {
        const { transferredFrom: _, ...rest } = item
        wires.push(rest)
        continue
      }
      if (item.type === 'queue' && (item.queueId !== undefined || item.shim !== undefined)) {
        const { queueId: _, shim: __, ...rest } = item
        wires.push(rest)
        continue
      }
      wires.push(item)
    }
  }
  if (props.assets) wires.push({ type: 'assets', name: 'ASSETS' })
  wires.push(
    { type: 'plain_text', name: 'ALCHEMY_PHASE', text: 'runtime' },
    { type: 'plain_text', name: 'ALCHEMY_WORKER_NAME', text: workerName },
    { type: 'plain_text', name: 'ALCHEMY_STACK_NAME', text: stack.name },
    { type: 'plain_text', name: 'ALCHEMY_STAGE', text: stack.stage },
    { type: 'plain_text', name: 'ALCHEMY_CLOUDFLARE_ACCOUNT_ID', text: accountId },
  )
  const env = { ...props.env }
  for (const binding of live) if (binding.data?.env) Object.assign(env, binding.data.env)
  for (const [name, value] of Object.entries(env)) {
    // Effect- or class-valued entries (resource references such as `DIRECTORY_DATABASE: Database`) are bound
    // through the resource's own binding, and the provider strips them from env (`stripEffects`).
    if (value === undefined || typeof value === 'function' || Effect.isEffect(value) || wires.some(wire => wire.name === name)) continue
    const secret = secretText(value)
    if (secret !== undefined) wires.push({ type: 'secret_text', name, text: secret })
    else if (typeof value === 'string') wires.push({ type: 'plain_text', name, text: value })
    else wires.push({ type: 'json', name, json: value })
  }
  return wires
}

/** One wire binding for the digest: `text` and `json` values as commitments, everything else (identities) in clear. */
export function normalizeWire(key, logicalId, wire) {
  const seal = (path, value) => commit(key, [logicalId, 'binding', wire.name, ...path], value)
  const out = {}
  for (const field of Object.keys(wire).toSorted()) {
    if (field === 'text' || field === 'json') out[field] = { commitment: seal([field], materialize(wire[field], seal, [field])) }
    else {
      const value = materialize(wire[field], seal, [field])
      if (value !== undefined) out[field] = value
    }
  }
  return out
}

/** The reviewed per-Worker payload. `artifact` comes from the provider's build (`artifactOf`). */
export function workerPayload({ key, logicalId, workerName, stack, accountId, node, artifact }) {
  const props = node.props ?? node.state?.props ?? {}
  const seal = (path, value) => commit(key, [logicalId, ...path], value)
  const { env: _env, ...settings } = props
  const bindings = wireBindings(node, { workerName, stack, accountId }).map(wire => normalizeWire(key, logicalId, wire))
    .toSorted((a, b) => (a.name === b.name ? canonicalChange(a).localeCompare(canonicalChange(b)) : a.name.localeCompare(b.name)))
  const bindingData = (node.bindings ?? []).filter(binding => binding.action !== 'delete').map(binding => {
    const { bindings: _b, env: _e, ...rest } = binding.data ?? {}
    return { sid: binding.sid, data: materialize(rest, (path, value) => seal(['bindingData', binding.sid, ...path], value)) ?? {} }
  }).toSorted((a, b) => a.sid.localeCompare(b.sid))
  return {
    workerName,
    action: node.action,
    bindings,
    bindingData,
    settings: materialize(settings, (path, value) => seal(['settings', ...path], value)) ?? {},
    artifact,
  }
}

const toBytes = async file => {
  const content = file.content ?? file.contents
  if (typeof content === 'string') return Buffer.from(content)
  if (content instanceof Uint8Array) return Buffer.from(content)
  if (typeof file.arrayBuffer === 'function') return Buffer.from(await file.arrayBuffer())
  throw new Error('artifact-file-unreadable')
}

/** The provider's bundle (`{ main?, files, hash }`), as the bytes it uploads: every file's name, size and sha256. */
export async function artifactOf(bundle) {
  if (!Array.isArray(bundle?.files) || bundle.files.length === 0) throw new Error('artifact-missing')
  const files = []
  for (const file of bundle.files) {
    const bytes = await toBytes(file)
    files.push({ name: file.name ?? file.path, size: bytes.length, sha256: sha256(bytes) })
  }
  return { kind: 'bundle', main: bundle.main ?? files[0].name, providerHash: bundle.hash ?? null, files: files.toSorted((a, b) => a.name.localeCompare(b.name)) }
}

/**
 * Every environment input of Explore's Vite build (review B12-003): the `process.env` reads in apps/explore/vite.config.ts
 * (`payload.test.mjs` scans Explore's build sources so a new read cannot go unlisted), NODE_ENV (Vite's mode), and
 * any VITE_* variable. Unset and empty commit differently.
 */
export const viteBuildEnv = ['AGENT_JOBS_NETWORK', 'HIRELING_PROD_PRIVY_APP_ID', 'NODE_ENV', 'PRIVY_APP_ID']

/** The pin of a Vite Worker, built only during upload: its build environment and Vite's `.env*` files, as keyed
 *  commitments; its sources are pinned by the tree. */
export function viteArtifact(key, logicalId, env, envFiles = {}) {
  const names = [...new Set([...viteBuildEnv, ...Object.keys(env).filter(name => name.startsWith('VITE_'))])].toSorted()
  return {
    kind: 'vite',
    pinnedBy: 'source tree, build environment and Vite env files',
    buildEnv: Object.fromEntries(names.map(name => [name, commit(key, [logicalId, 'buildEnv', name], env[name] ?? null)])),
    envFiles: Object.fromEntries(Object.keys(envFiles).toSorted().map(name => [name, commit(key, [logicalId, 'envFile', name], envFiles[name])])),
  }
}

// ---- review B12-002: the Durable Object migration the provider would derive ----

const localDurableObjects = (node, workerName) => {
  const seen = new Set()
  return (node.bindings ?? []).filter(binding => binding.action !== 'delete').flatMap(binding =>
    (binding.data?.bindings ?? []).flatMap(item => {
      if (item.type !== 'durable_object_namespace' || !item.className) return []
      if (item.scriptName !== undefined && item.scriptName !== workerName) return []
      const dedup = `${binding.sid}::${item.name}::${item.className}`
      if (seen.has(dedup)) return []
      seen.add(dedup)
      const transferredFrom = Array.isArray(item.transferredFrom) && item.transferredFrom.length === 0 ? undefined : item.transferredFrom
      return [{ logicalId: binding.sid, bindingName: item.name, className: item.className, transferredFrom }]
    }))
}

const bumpMigrationTag = old => {
  if (!old) return undefined
  const version = old.match(/^(alchemy:)?v(\d+)$/)?.[2]
  return version ? `alchemy:v${Number.parseInt(version, 10) + 1}` : 'alchemy:v1'
}

/**
 * Mirrors the pinned provider's reconcile (`putWorker`): the class migration and tags a Worker upload carries, derived
 * from the live script tags and bindings, the account's namespaces and the planned bindings. Engine `snapshot.actions`
 * never show this; it is computed during upload. `live` is the census entry (`{ name, tags, bindings }`).
 */
export function durableObjectTransition(node, live, namespaces) {
  const workerName = live.name
  const oldMap = getDurableObjectTagMap(live.tags ?? [])
  const current = localDurableObjects(node, workerName)
  const currentMap = Object.fromEntries(current.map(binding => [binding.logicalId, binding.className]))
  const hosted = className => namespaces.some(ns => ns.script === workerName && ns.className === className)
  const oldTag = (live.tags ?? []).flatMap(tag => tag.startsWith('alchemy:migration-tag:') ? [tag.slice('alchemy:migration-tag:'.length)] : [])[0]
  const candidates = Object.entries(oldMap).filter(([logicalId]) => !currentMap[logicalId]).map(([, className]) => className)
  if (Object.keys(oldMap).length === 0) {
    for (const old of live.bindings ?? []) {
      const owned = old.script_name === undefined || old.script_name === workerName
      if (old.type === 'durable_object_namespace' && old.class_name && owned && !current.some(binding => binding.bindingName === old.name)) candidates.push(old.class_name)
    }
  }
  const deletedClasses = candidates.filter(hosted).toSorted()
  const newSqliteClasses = []
  const renamedClasses = []
  const transferredClasses = []
  for (const binding of current) {
    let previous = oldMap[binding.logicalId]
    if (!previous) {
      const observed = (live.bindings ?? []).find(old => old.type === 'durable_object_namespace' && old.class_name &&
        (old.script_name === undefined || old.script_name === workerName) && old.name === binding.bindingName)
      previous = observed?.class_name
    }
    if (!previous) {
      if (binding.transferredFrom !== undefined) transferredClasses.push(binding.className)
      else newSqliteClasses.push(binding.className)
    } else if (previous !== binding.className) renamedClasses.push({ from: previous, to: binding.className })
  }
  return {
    oldTag: oldTag ?? null,
    newTag: bumpMigrationTag(oldTag) ?? null,
    durableObjectTags: encodeDurableObjectTags(current),
    newSqliteClasses: newSqliteClasses.toSorted(),
    renamedClasses: renamedClasses.toSorted((a, b) => a.to.localeCompare(b.to)),
    deletedClasses,
    transferredClasses: transferredClasses.toSorted(),
  }
}

/** A transition only re-tags (or does nothing); any class created, renamed, deleted or transferred is a migration. */
export const migratesClasses = transition => ['newSqliteClasses', 'renamedClasses', 'deletedClasses', 'transferredClasses'].some(field => transition[field].length > 0)

export const digestOf = (canonical, reviewed) => sha256(canonical(reviewed))
