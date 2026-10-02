import { lstatSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * KEYSTORE-SEC-003: the rule launch-testnet.sh and the runbook's `pwcheck` apply to a keystore password file, checked
 * before any signer starts. The file must be a regular file you own, with mode 600 or 400, and not a symlink. Its
 * directory must be yours and writable by nobody else, so it cannot be swapped. Messages name the path, never the
 * contents.
 */
export function checkPasswordFile(path: string): void {
  const uid = process.getuid?.()
  const file = lstatSync(path, { throwIfNoEntry: false })
  if (file === undefined) throw new Error(`password file ${path} does not exist`)
  if (file.isSymbolicLink() || !file.isFile()) throw new Error(`password file ${path} must be a regular file, not a symlink`)
  const mode = file.mode & 0o777
  if (file.uid !== uid || (mode !== 0o600 && mode !== 0o400)) throw new Error(`password file ${path} must be yours with mode 600 or 400`)
  const dir = lstatSync(dirname(path))
  if (dir.isSymbolicLink() || dir.uid !== uid || (dir.mode & 0o022) !== 0) {
    throw new Error(`the directory of password file ${path} must be yours and writable by nobody else`)
  }
}
