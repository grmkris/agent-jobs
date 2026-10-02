/** Linux durability barrier for the live runner; a save must finish before its transaction is broadcast. */
import * as fs from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { flowJson, type FlowState } from '../src/flow-journal.ts'

type JournalFs = Pick<typeof fs, 'existsSync' | 'mkdirSync' | 'openSync' | 'writeFileSync' | 'fsyncSync' | 'closeSync' | 'renameSync'>
function syncDirectory(path: string, io: JournalFs) {
  const fd = io.openSync(path, 'r')
  try { io.fsyncSync(fd) } finally { io.closeSync(fd) }
}
export function ensureFlowDirectory(directory: URL, io: JournalFs = fs) {
  const path = fileURLToPath(directory), missing: string[] = []
  let current = path.replace(/\/$/, '')
  while (!io.existsSync(current)) { missing.push(current); current = dirname(current) }
  for (const child of missing.toReversed()) {
    io.mkdirSync(child, { mode: 0o700 })
    syncDirectory(dirname(child), io)
    syncDirectory(child, io)
  }
  // Also sync an existing directory, covering a previous interrupted first-use mkdir.
  syncDirectory(path, io)
}
export function saveFlowState(directory: URL, next: FlowState, io: JournalFs = fs) {
  const temporary = new URL('journal.tmp', directory), target = new URL('journal.json', directory)
  const fd = io.openSync(temporary, 'w', 0o600)
  try { io.writeFileSync(fd, flowJson(next) + '\n'); io.fsyncSync(fd) } finally { io.closeSync(fd) }
  io.renameSync(temporary, target)
  syncDirectory(fileURLToPath(directory), io)
}
