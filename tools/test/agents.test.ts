import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { checkAll, markdownLinks } from '../agents.ts'

const VENDORED_SKILL = '---\nname: vend\ndescription: Upstream text of any length.\n---\n\nUpstream body.\n'
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** A minimal repository with every kind of agent file, consistent until a test breaks one thing. */
const fixture = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'agents-check-'))
  const write = (file: string, content: string): void => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), content)
  }
  write('AGENTS.md', '# Root\n\nSee [the app](apps/a/AGENTS.md) and [docs](docs/x.md).\n')
  // CLAUDE.md is a symlink to its sibling AGENTS.md (tools/agents.ts, scripts/agents-sync.ts).
  symlinkSync('AGENTS.md', path.join(root, 'CLAUDE.md'))
  write('apps/a/AGENTS.md', '# apps/a\n\nRead [docs](../../docs/x.md).\n')
  symlinkSync('AGENTS.md', path.join(root, 'apps/a/CLAUDE.md'))
  write('docs/x.md', '# X\n')
  write(
    '.agents/skills/mine/SKILL.md',
    '---\nname: mine\ndescription: Use when a fixture needs a repo-authored skill.\n---\n\n[x](../../../docs/x.md)\n',
  )
  write('.agents/skills/vend/SKILL.md', VENDORED_SKILL)
  write('.agents/skills/vend/LICENSE', 'MIT\n')
  write(
    '.agents/skills/sources.json',
    JSON.stringify({
      version: 1,
      reviewedAt: '2026-10-02',
      skills: {
        vend: {
          repository: 'owner/repo',
          commit: 'abc',
          path: 'skills/vend',
          sourceSha256: sha256(VENDORED_SKILL),
          licenses: ['LICENSE'],
          unchanged: true,
          adaptation: 'none',
        },
      },
    }),
  )
  mkdirSync(path.join(root, '.claude/skills'), { recursive: true })
  write('.claude/rules/docs.md', '---\npaths:\n  - "docs/**"\n---\n\n# Docs\n')
  write('.cursor/rules/x.mdc', '---\nalwaysApply: true\n---\n\nRead AGENTS.md.\n')
  execFileSync('git', ['init', '-q'], { cwd: root })
  return root
}

const roots: string[] = []
const fresh = (): string => {
  const root = fixture()
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('agents:check', () => {
  test('a consistent repository passes', () => {
    expect(checkAll(fresh(), ['apps/a'])).toEqual([])
  })

  test('a repo-authored description outside 20-220 characters fails', () => {
    const root = fresh()
    writeFileSync(
      path.join(root, '.agents/skills/mine/SKILL.md'),
      `---\nname: mine\ndescription: ${'x'.repeat(221)}\n---\n`,
    )
    expect(checkAll(root, ['apps/a'])).toEqual([
      '.agents/skills/mine/SKILL.md: the description has 221 characters; write 20-220 that say when to use the skill.',
    ])
  })

  test('vendored skills skip the repo-authored checks; agents-sync verifies them', () => {
    const root = fresh()
    writeFileSync(
      path.join(root, '.agents/skills/vend/SKILL.md'),
      '---\nname: vend\ndescription: Short.\n---\n\nTODO upstream.\n',
    )
    expect(checkAll(root, ['apps/a'])).toEqual([])
  })

  test('a nested AGENTS.md without its shim, or a workspace without AGENTS.md, fails', () => {
    const root = fresh()
    unlinkSync(path.join(root, 'apps/a/CLAUDE.md'))
    mkdirSync(path.join(root, 'apps/b'))
    expect(checkAll(root, ['apps/a', 'apps/b'])).toEqual([
      'apps/a/CLAUDE.md must be a symlink to AGENTS.md so Claude Code and Grok load apps/a/AGENTS.md. Run: bun scripts/agents-sync.ts',
      'apps/b has no AGENTS.md. Add one (role, checks, test floor, landmines) and a CLAUDE.md symlink.',
    ])
  })

  test('a dead relative link fails; links in code are ignored', () => {
    const root = fresh()
    writeFileSync(path.join(root, 'docs/x.md'), '# X\n')
    writeFileSync(
      path.join(root, 'apps/a/AGENTS.md'),
      '# apps/a\n\n[gone](../../docs/gone.md) `[code](nowhere.md)`\n\n```md\n[fenced](nowhere.md)\n```\n',
    )
    expect(checkAll(root, ['apps/a'])).toEqual([
      'apps/a/AGENTS.md links ../../docs/gone.md, which does not exist (docs/gone.md).',
    ])
  })

  test('a manual skill must be manual in Codex too', () => {
    const root = fresh()
    writeFileSync(
      path.join(root, '.agents/skills/mine/SKILL.md'),
      '---\nname: mine\ndescription: Use when a fixture needs a manual skill.\ndisable-model-invocation: true\n---\n',
    )
    expect(checkAll(root, ['apps/a'])[0]).toContain('Add agents/openai.yaml with')
  })
})

describe('markdownLinks', () => {
  test('keeps relative targets without anchors; drops URLs, anchors and code', () => {
    expect(markdownLinks('[a](x.md#h) [b](https://e.com) [c](#top) `[d](y.md)` [e](mailto:x@y.z)')).toEqual(['x.md'])
  })
})
