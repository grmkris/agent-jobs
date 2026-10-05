/** Outbound-only Docker workers with separate credentials, durable journals and immutable source. */
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = join(root, '.crew')
const workers = [
  { slug: 'canvas', container: 'hireling-crew-grok', key: 'DEMO_CANVAS_PRIVATE_KEY' },
  { slug: 'studio', container: 'hireling-crew-grok-studio', key: 'DEMO_STUDIO_PRIVATE_KEY' },
]
const containers = [...workers.map(worker => worker.container), 'hireling-crew-demand', 'hireling-crew-codex']

function execute(program, args, options = {}) {
  const result = execFileSync(program, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
  return typeof result === 'string' ? result.trim() : result
}

function dockerState(name) {
  try {
    return JSON.parse(execute('docker', ['inspect', '--format', '{{json .State}}', name]))
  } catch {
    return null
  }
}

function localEnvironment(file) {
  const values = {}
  if (!existsSync(file)) return values
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line)
    if (match) values[match[1]] = match[2]
  }
  return values
}

function prepare() {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const common = resolve(root, execute('git', ['rev-parse', '--git-common-dir']))
  const sourceRoot = process.env.CREW_SOURCE_ROOT ?? dirname(common)
  const local = localEnvironment(join(sourceRoot, '.env.local'))
  const value = name => local[name] ?? process.env[name]
  const provider = value('CLIPROXY_API_KEY')
  if (!provider) throw new Error('CLIPROXY_API_KEY is required')
  // Give the workers repository credentials only; never mount the host gh configuration.
  const github = value('DEMO_GITHUB_TOKEN') ?? value('GH_TOKEN') ?? execute('gh', ['auth', 'token'])
  const source = process.env.CREW_JOURNAL_SOURCE ?? join(sourceRoot, '.demo-workers')
  if (!existsSync(join(source, 'journal.json'))) throw new Error('Existing worker journal is required; setup does not reset identities')
  for (const worker of workers) {
    if (dockerState(worker.container)?.Running) continue
    if (!value(worker.key)) throw new Error(`Missing ${worker.key}`)
    const state = join(directory, worker.slug)
    mkdirSync(state, { recursive: true, mode: 0o700 })
    if (!existsSync(join(state, 'journal.json'))) {
      // Keep the complete historical economic journal in both private worker snapshots.
      // Each process can sign only for its own profile, and future writes are isolated.
      for (const name of readdirSync(source)) {
        if (name === 'journal.json' || /\.(png|jpg|jpeg|txt|md)$/.test(name)) {
          copyFileSync(join(source, name), join(state, name))
          chmodSync(join(state, name), 0o600)
        }
      }
    }
    const environment = {
      [worker.key]: value(worker.key),
      CLIPROXY_API_KEY: provider,
      GH_TOKEN: github,
      MONAD_TESTNET_RPC_URL: value('MONAD_TESTNET_RPC_URL') ?? 'https://testnet-rpc.monad.xyz',
    }
    const file = join(directory, `${worker.slug}.env`)
    writeFileSync(file, Object.entries(environment).map(([key, entry]) => {
      if (/[\r\n]/.test(entry)) throw new Error('Worker environment must contain single-line values')
      return `${key}=${entry}\n`
    }).join(''), { mode: 0o600 })
    chmodSync(file, 0o600)
    const output = execute('flock', ['--nonblock', '--no-fork', join(state, 'journal.lock'), 'bun', 'packages/sdk/scripts/demo-workers.ts', 'migrate-policy'], {
      env: { ...process.env, ...environment, DEMO_JOURNAL_LOCKED: '1', DEMO_WORKER_STATE_DIR: state, DEMO_WORKER_SLUG: worker.slug },
    })
    console.log(output)
  }
}

function start() {
  prepare()
  if (execute('git', ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Commit reviewed crew source before starting containers')
  const sha = execute('git', ['rev-parse', 'HEAD'])
  const source = join(directory, 'source', sha)
  if (!existsSync(source)) {
    mkdirSync(source, { recursive: true, mode: 0o700 })
    const archive = execute('git', ['archive', sha, 'packages/sdk', 'contracts/config', 'package.json'], { encoding: null, maxBuffer: 32 * 1024 * 1024 })
    execFileSync('tar', ['-x', '-C', source], { input: archive })
  }
  // Docker cannot create nested mount points inside a read-only parent bind mount.
  mkdirSync(join(source, 'node_modules'), { recursive: true })
  mkdirSync(join(source, 'packages/sdk/node_modules'), { recursive: true })
  const bun = execute('readlink', ['-f', execute('which', ['bun'])])
  for (const worker of workers) {
    const existing = dockerState(worker.container)
    if (existing) {
      execute('docker', ['start', worker.container])
      console.log(`${worker.container}: existing immutable container started`)
      continue
    }
    execute('docker', ['run', '-d', '--name', worker.container, '--restart', 'unless-stopped', '--memory', '2g',
      '--network', 'host', '--user', `${process.getuid()}:${process.getgid()}`, '--stop-timeout', '180',
      '--label', `hireling.crew.source=${sha}`, '--label', 'hireling.crew.network=monad-testnet',
      '--env-file', join(directory, `${worker.slug}.env`),
      '-e', `DEMO_WORKER_SLUG=${worker.slug}`, '-e', 'DEMO_WORKER_STATE_DIR=/state',
      '-e', 'DEMO_JOURNAL_LOCKED=1',
      '-e', 'DEMO_MODEL_BASE_URL=http://127.0.0.1:8317/v1',
      '-v', `${source}:/workspace:ro`, '-v', `${root}/node_modules:/workspace/node_modules:ro`,
      '-v', `${root}/packages/sdk/node_modules:/workspace/packages/sdk/node_modules:ro`,
      '-v', `${directory}/${worker.slug}:/state`, '-v', `${bun}:/usr/local/bin/bun:ro`,
      '-v', '/usr/bin/gh:/usr/local/bin/gh:ro', '-w', '/workspace',
      'aj-worker:latest', 'flock', '--nonblock', '--no-fork', '/state/journal.lock', 'bun', 'packages/sdk/scripts/demo-workers.ts', 'start'])
    console.log(`${worker.container}: started at ${sha}`)
  }
  status()
}

function stop() {
  for (const name of containers) {
    if (!dockerState(name)?.Running) continue
    execute('docker', ['stop', '--time', '180', name], { timeout: 200_000 })
    console.log(`${name}: stopped; journal retained`)
  }
  status()
}

function status() {
  const report = { updatedAt: new Date().toISOString(), network: 'monad-testnet',
    containers: containers.map(name => ({ name, state: dockerState(name) })),
    workers: workers.flatMap(worker => {
      const file = join(directory, worker.slug, 'status.json')
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).workers.filter(entry => entry.name === (worker.slug === 'canvas' ? 'Grok Canvas' : 'Grok Studio')) : []
    }),
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(join(directory, 'status.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify(report, null, 2))
}

try {
  const command = process.argv[2] ?? 'status'
  if (command === 'start') start()
  else if (command === 'stop') stop()
  else if (command === 'status') status()
  else if (command === 'prepare') prepare()
  else throw new Error('Usage: pnpm crew start|status|stop|prepare')
} catch (error) {
  // Child-process errors can embed credential-bearing environment or RPC responses.
  console.error(error.constructor === Error && !/https?:|Bearer|0x[a-f0-9]{64}/i.test(error.message)
    ? error.message.slice(0, 200) : 'Crew command failed; inspect sanitized worker status')
  process.exitCode = 1
}
