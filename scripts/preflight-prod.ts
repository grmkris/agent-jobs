import { readFileSync } from 'node:fs'
import { validateProdConfig, type ProdArtifact } from '../apps/api/src/prod-config.ts'
import mainnet from '../contracts/config/monad-mainnet.json' with { type: 'json' }

const path = process.argv[2]
if (!path) throw new Error('pass a reviewed production artifact JSON path; no secret values')
let failures: string[]
try {
  const artifact = JSON.parse(readFileSync(path, 'utf8')) as ProdArtifact
  failures = validateProdConfig(mainnet, artifact)
} catch {
  console.error('production preflight rejected: artifact is unreadable or structurally invalid')
  process.exitCode = 1
  failures = []
}
if (failures.length > 0) {
  console.error(`production preflight rejected: ${failures.join(', ')}`)
  process.exitCode = 1
} else if (process.exitCode !== 1) {
  console.log('production structural preflight passed; this is not launch authorization or live contract proof')
}
