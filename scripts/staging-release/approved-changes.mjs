import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'

export const approvedChangesPath = 'approved-changes.json'
const manifestUrl = new URL(`./${approvedChangesPath}`, import.meta.url)
const maxBytes = 16_384
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

export function canonicalChange(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalChange).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).toSorted().map(key => `${JSON.stringify(key)}:${canonicalChange(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

const secretShape = value => exact(value, ['logicalId', 'name', 'action']) &&
  ['Api', 'Indexer'].includes(value.logicalId) && typeof value.name === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value.name) && ['add', 'rotate'].includes(value.action)
const settingShape = value => exact(value, ['logicalId', 'name', 'action', 'type']) &&
  value.logicalId === 'Api' && ['PRIVY_APP_ID', 'PRIVY_SIGNER_ID', 'PRIVY_POLICY_ID'].includes(value.name) &&
  value.action === 'add' && value.type === 'plain_text'
const domainShape = value => exact(value, ['logicalId', 'hostname', 'action', 'setting', 'value']) &&
  value.logicalId === 'Explore' && value.hostname === 'hireling.xyz' && value.action === 'release-alias' && value.setting === 'HIRELING_APEX_REDIRECT' && value.value === '0'
const unique = values => new Set(values.map(canonicalChange)).size === values.length

export function validateManifestShape(manifest) {
  return exact(manifest, ['schemaVersion', 'accountId', 'stage', 'network', 'secretChanges', 'settingsChanges', 'domainChanges']) &&
    manifest.schemaVersion === 1 && manifest.accountId === 'bceaeae4788dce3493514fde194b4a7e' && manifest.stage === 'staging' && manifest.network === 'monad-testnet' &&
    Array.isArray(manifest.secretChanges) && manifest.secretChanges.length <= 16 && manifest.secretChanges.every(secretShape) && unique(manifest.secretChanges) &&
    Array.isArray(manifest.settingsChanges) && manifest.settingsChanges.length <= 3 && manifest.settingsChanges.every(settingShape) && unique(manifest.settingsChanges) &&
    Array.isArray(manifest.domainChanges) && manifest.domainChanges.length <= 1 && manifest.domainChanges.every(domainShape)
}

/** Verify the actual wire value; return identifiers only. Payload commitments pin the value before upload. */
export function settingAddition(logicalId, wire) {
  const change = { logicalId, name: wire.name, action: 'add', type: wire.type }
  return settingShape(change) && typeof wire.text === 'string' && wire.text.trim().length > 0 ? change : undefined
}

/** Fixed repository file only. Refuse symlinks, special files, oversized input and extra fields (including values). */
export function readApprovedChanges() {
  const stat = lstatSync(manifestUrl)
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) throw new Error('approved-change-manifest-invalid')
  const fd = openSync(manifestUrl, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.size > maxBytes || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('approved-change-manifest-invalid')
    const bytes = readFileSync(fd)
    if (bytes.length > maxBytes) throw new Error('approved-change-manifest-invalid')
    const manifest = JSON.parse(bytes.toString('utf8'))
    if (!validateManifestShape(manifest)) throw new Error('approved-change-manifest-invalid')
    return { reference: { path: approvedChangesPath, sha256: createHash('sha256').update(bytes).digest('hex') }, manifest }
  } finally {
    closeSync(fd)
  }
}

/** The packet pins the file bytes; the enclosing release digest pins this reference and the exact change subset. */
export function validatePlanChanges(plan, reference) {
  const blockers = new Set()
  for (const field of ['migrations', 'resourceCreates', 'scheduleChanges']) {
    if (!Array.isArray(plan?.[field]) || plan[field].length !== 0) blockers.add('unapproved-additive-or-config-change')
  }
  let manifest
  const hasChanges = ['secretChanges', 'settingsChanges', 'domainChanges'].some(field => !Array.isArray(plan?.[field]) || plan[field].length !== 0)
  if (reference !== undefined || hasChanges) {
    try {
      const actual = readApprovedChanges()
      if (!exact(reference, ['path', 'sha256']) || reference.path !== actual.reference.path || reference.sha256 !== actual.reference.sha256) throw new Error('digest')
      manifest = actual.manifest
    } catch {
      blockers.add('approved-change-manifest-mismatch')
    }
  }
  for (const [field, shape] of [['secretChanges', secretShape], ['settingsChanges', settingShape], ['domainChanges', domainShape]]) {
    const changes = plan?.[field]
    if (!Array.isArray(changes) || !changes.every(shape) || !unique(changes)) {
      blockers.add('unapproved-additive-or-config-change')
      continue
    }
    if (changes.some(change => !manifest?.[field].some(allowed => canonicalChange(allowed) === canonicalChange(change)))) blockers.add('unapproved-additive-or-config-change')
  }
  return { ok: blockers.size === 0, blockers: [...blockers] }
}

/** Alias release changes only the planned Explore aliases; observed ownership is still verified before apply. */
export function plannedDomains(plan, reference, current) {
  const validation = validatePlanChanges(plan, reference)
  return validation.ok && plan.domainChanges.length === 1 ? current.filter(hostname => hostname !== 'hireling.xyz') : current
}
