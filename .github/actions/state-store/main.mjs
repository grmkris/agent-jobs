import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const input = process.env.INPUT_CREDENTIALS ?? ''
const githubEnv = process.env.GITHUB_ENV
if (input === '' || githubEnv === undefined) {
  console.log('::error::state-store credentials and GITHUB_ENV are required')
  process.exit(1)
}
try {
  const value = JSON.parse(input)
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.url !== 'string' ||
    typeof value.authToken !== 'string' ||
    typeof value.accountId !== 'string'
  )
    throw new Error('invalid credential shape')
} catch {
  console.log('::error::state-store credential is not valid JSON')
  process.exit(1)
}
const directory = join(homedir(), '.alchemy', 'credentials', 'default')
const file = join(directory, 'cloudflare-state-store.json')
mkdirSync(directory, { recursive: true, mode: 0o700 })
chmodSync(directory, 0o700)
writeFileSync(file, input, { mode: 0o600 })
chmodSync(file, 0o600)
appendFileSync(githubEnv, `SIDEQUEST_STATE_STORE_CREDENTIAL=${file}\n`)
console.log('state-store: credential installed for this job')
