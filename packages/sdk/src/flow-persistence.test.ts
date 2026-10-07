import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { ensureFlowDirectory, saveFlowState } from '../scripts/flow-persistence.ts'
import { flowJson, parseFlowJson, type FlowState } from './flow-journal.ts'

it('durably creates first-use directories and orders file fsync, rename and directory fsync before broadcast', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'sidequest-flow-durable-'))
  const directory = pathToFileURL(`${root}/new/profile/`),
    events: string[] = [],
    paths = new Map<number, string>()
  const io = {
    ...fs,
    openSync: ((path, flags, mode) => {
      const fd = fs.openSync(path, flags, mode)
      paths.set(fd, String(path))
      return fd
    }) as typeof fs.openSync,
    mkdirSync: ((path, options) => {
      events.push(`mkdir:${String(path)}`)
      return fs.mkdirSync(path, options)
    }) as typeof fs.mkdirSync,
    fsyncSync: (fd: number) => {
      events.push(`fsync:${paths.get(fd)}`)
      fs.fsyncSync(fd)
    },
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      events.push('rename')
      fs.renameSync(from, to)
    },
  }
  try {
    ensureFlowDirectory(directory, io)
    expect(events).toContain(`fsync:${root}`)
    expect(events).toContain(`fsync:${root}/new`)
    events.length = 0
    const state: FlowState = { binding: 'test', values: { amount: 12n }, sends: {} }
    saveFlowState(directory, state, io)
    events.push('broadcast')
    expect(events).toEqual([
      `fsync:${new URL('journal.tmp', directory)}`,
      'rename',
      `fsync:${root}/new/profile/`,
      'broadcast',
    ])
    const journal = new URL('journal.json', directory)
    expect(parseFlowJson(fs.readFileSync(journal, 'utf8'))).toEqual(state)
    expect(fs.statSync(journal).mode & 0o777).toBe(0o600)
  } finally {
    fs.rmSync(root, { recursive: true })
  }
})
it('a directory fsync failure refuses broadcast; an acknowledged snapshot survives a simulated host restart', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'sidequest-flow-fault-')),
    directory = pathToFileURL(`${root}/`)
  let stable = '',
    fail = true,
    broadcasts = 0
  const io = {
    ...fs,
    fsyncSync: (fd: number) => {
      if (fs.fstatSync(fd).isDirectory()) {
        if (fail) throw new Error('directory durability barrier failed')
        stable = fs.readFileSync(new URL('journal.json', directory), 'utf8')
      }
      fs.fsyncSync(fd)
    },
  }
  const state: FlowState = {
    binding: 'test',
    values: {},
    sends: { stake: { raw: '0x12', hash: '0x34', nonce: 1, wallet: '0x1111111111111111111111111111111111111111' } },
  }
  const send = () => {
    saveFlowState(directory, state, io)
    broadcasts++
  }
  try {
    expect(send).toThrow('durability barrier')
    expect(broadcasts).toBe(0)
    expect(stable).toBe('')
    fail = false
    send()
    expect(broadcasts).toBe(1)
    // The fault harness restores only acknowledged directory snapshots, as after a filesystem restart.
    fs.writeFileSync(new URL('journal.json', directory), stable)
    expect(parseFlowJson(stable).sends.stake).toEqual(state.sends.stake)
    expect(fs.readFileSync(new URL('journal.json', directory), 'utf8')).toBe(flowJson(state) + '\n')
  } finally {
    fs.rmSync(root, { recursive: true })
  }
})
