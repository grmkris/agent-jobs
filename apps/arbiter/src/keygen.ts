import { mkdir, open, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Schema } from 'effect'
import type { Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

interface KeygenOptions {
  readonly generateKey?: () => Hex
  readonly print?: (message: string) => void
}

/** Only Kris invokes the CLI. Unit tests supply a disposable key and temporary home. */
export async function generateModeratorKey(
  home = homedir(),
  stage = process.env.SIDEQUEST_STAGE ?? 'dev',
  options: KeygenOptions = {},
): Promise<string> {
  const selected = Schema.decodeUnknownSync(Schema.Literals(['local', 'dev', 'prod']))(stage)
  const file = path.join(home, '.config', 'sidequest', `${selected}.env`)
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const lockPath = `${file}.moderator-keygen.lock`
  const lock = await open(lockPath, 'wx', 0o600)
  try {
    const handle = await open(file, 'a+', 0o600)
    try {
      await handle.chmod(0o600)
      const existing = await handle.readFile('utf8')
      if (/^\s*(?:export\s+)?MODERATOR_PRIVATE_KEY\s*=/mu.test(existing))
        throw new Error('MODERATOR_PRIVATE_KEY is already set')
      const key = (options.generateKey ?? generatePrivateKey)()
      const address = privateKeyToAccount(key).address
      const separator = existing !== '' && !existing.endsWith('\n') ? '\n' : ''
      await handle.appendFile(`${separator}MODERATOR_PRIVATE_KEY=${key}\n`)
      await handle.sync()
      ;(options.print ?? console.log)(`moderator address: ${address}`)
      return address
    } finally {
      await handle.close()
    }
  } finally {
    await lock.close()
    await unlink(lockPath)
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const stage = args[0] === '--stage' ? args[1] : (process.env.SIDEQUEST_STAGE ?? 'dev')
  if ((args.length > 0 && args[0] !== '--stage') || (args[0] === '--stage' && args.length !== 2))
    throw new Error('usage: keygen:moderator [--stage local|dev|prod]')
  await generateModeratorKey(homedir(), stage)
}
