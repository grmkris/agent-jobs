/** Standalone demand launcher, also used by the authorized testnet crew supervisor. */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reportCliFailure } from './cli-errors.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = join(root, '.crew')
const name = 'sidequest-crew-demand'
const environmentFile = join(directory, 'demand.env')

function execute(program, args, options = {}) {
  return execFileSync(program, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

function containerState() {
  try { return JSON.parse(execute('docker', ['inspect', '--format', '{{json .State}}', name])) } catch { return null }
}

function prepare() {
  if (containerState()?.Running) throw new Error('Stop demand before changing its private environment')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const values = {}
  const common = resolve(root, execute('git', ['rev-parse', '--git-common-dir']).trim())
  const sourceRoot = process.env.CREW_SOURCE_ROOT ?? dirname(common)
  const file = join(sourceRoot, '.env.local')
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line)
      if (match) values[match[1]] = match[2]
    }
  }
  const key = values.DEMAND_BOT_PRIVATE_KEY ?? process.env.DEMAND_BOT_PRIVATE_KEY
  if (!key || !existsSync(join(directory, 'demand/journal.json'))) throw new Error('Run demand-bot.ts setup first; never start with a fresh journal')
  const environment = {
    DEMAND_BOT_PRIVATE_KEY: key,
    MONAD_TESTNET_RPC_URL: values.MONAD_TESTNET_RPC_URL ?? process.env.MONAD_TESTNET_RPC_URL ?? 'https://testnet-rpc.monad.xyz',
  }
  for (const value of Object.values(environment)) if (/[\r\n]/.test(value)) throw new Error('Demand environment values must be single-line')
  writeFileSync(environmentFile, Object.entries(environment).map(([keyName, value]) => `${keyName}=${value}\n`).join(''), { mode: 0o600 })
  chmodSync(environmentFile, 0o600)
  console.log('Demand environment prepared (0600); only the demand key and testnet RPC are included')
}

function runSpec(sha) {
  const source = join(directory, 'demand-source', sha)
  const bun = execute('readlink', ['-f', execute('which', ['bun']).trim()]).trim()
  return ['run', '-d', '--name', name, '--restart', 'unless-stopped', '--memory', '2g',
    '--network', 'sidequest-crew', '--user', `${process.getuid()}:${process.getgid()}`, '--stop-timeout', '180',
    '--label', `sidequest.crew.source=${sha}`, '--label', 'sidequest.crew.network=monad-testnet',
    '--env-file', environmentFile, '-e', 'DEMAND_BOT_STATE_DIR=/state', '-e', 'DEMAND_BOT_LOCKED=1',
    '-v', `${source}:/workspace:ro`, '-v', `${root}/node_modules:/workspace/node_modules:ro`,
    '-v', `${root}/packages/sdk/node_modules:/workspace/packages/sdk/node_modules:ro`,
    '-v', `${directory}/demand:/state`, '-v', `${bun}:/usr/local/bin/bun:ro`, '-w', '/workspace',
    'aj-worker:latest', 'flock', '--nonblock', '--no-fork', '/state/journal.lock', 'bun', 'packages/sdk/scripts/demand-bot.ts', 'start']
}

function snapshot(sha) {
  const source = join(directory, 'demand-source', sha)
  if (!existsSync(source)) {
    mkdirSync(source, { recursive: true, mode: 0o700 })
    const archive = execute('git', ['archive', sha, 'packages/sdk', 'contracts/config', 'package.json'], { encoding: null, maxBuffer: 32 * 1024 * 1024 })
    execFileSync('tar', ['-x', '-C', source], { input: archive })
  }
  mkdirSync(join(source, 'node_modules'), { recursive: true })
  mkdirSync(join(source, 'packages/sdk/node_modules'), { recursive: true })
}

function start() {
  const sha = execute('git', ['rev-parse', 'HEAD']).trim()
  const files = ['scripts/demand-bot.mjs', ...execute('git', ['ls-files', 'packages/sdk/*demand*', 'packages/sdk/src/demand-bot*', 'packages/sdk/scripts/demand-bot*']).trim().split('\n')]
  if (execute('git', ['status', '--porcelain', '--', ...files]).trim()) throw new Error('Commit demand source before starting')
  let driver
  try { driver = execute('docker', ['network', 'inspect', '--format', '{{.Driver}}', 'sidequest-crew']).trim() }
  catch { execute('docker', ['network', 'create', '--driver', 'bridge', 'sidequest-crew']); driver = 'bridge' }
  if (driver !== 'bridge') throw new Error('Demand requires the dedicated bridge network')
  const existing = containerState()
  if (existing) {
    const config = JSON.parse(execute('docker', ['inspect', '--format', '{{json .HostConfig}}', name]))
    if (config.NetworkMode !== 'sidequest-crew' || config.Memory !== 2 * 1024 ** 3 || config.RestartPolicy.Name !== 'unless-stopped' || Object.keys(config.PortBindings ?? {}).length !== 0) throw new Error('Existing demand container does not match the reviewed bridge and resource policy')
    if (!existing.Running) {
      prepare()
      execute('docker', ['start', name])
    }
  }
  else {
    prepare()
    snapshot(sha)
    execute('docker', runSpec(sha))
  }
  console.log(`${name}: started; source is immutable and the journal is retained`)
}

function status() {
  const file = join(directory, 'demand/status.json')
  console.log(JSON.stringify({ name, container: containerState(), demand: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null }, null, 2))
}

try {
  const command = process.argv[2] ?? 'status'
  if (command === 'prepare') prepare()
  else if (command === 'spec') console.log(JSON.stringify({ program: 'docker', args: runSpec(execute('git', ['rev-parse', 'HEAD']).trim()), startsContainer: false }, null, 2))
  else if (command === 'start') start()
  else if (command === 'stop') { if (containerState()?.Running) execute('docker', ['stop', '--time', '180', name], { timeout: 200_000 }); status() }
  else if (command === 'status') status()
  else throw new Error('unknown demand container command')
} catch (error) {
  reportCliFailure('Demand container command failed', error)
  process.exitCode = 1
}
