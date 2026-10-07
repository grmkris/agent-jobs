import { describe, expect, test } from 'vitest'
import { aggregate, fromKnip, fromOxlint, renderMarkdown, ruleCode, safeFixCodes, workspaceOf } from '../report.ts'
import type { Finding } from '../report.ts'

describe('workspaceOf', () => {
  test('the longest workspace directory owns a file; everything else is (root)', () => {
    expect(workspaceOf('apps/arbiter/src/main.ts')).toBe('apps/arbiter')
    expect(workspaceOf('apps/explore/src/worker.ts')).toBe('apps/explore')
    expect(workspaceOf('scripts/stage.ts')).toBe('(root)')
    expect(workspaceOf('apps/explorex/a.ts')).toBe('(root)')
  })
})

describe('knip input', () => {
  test('each issue item is a finding under knip(<type>), positioned when knip gives a line', () => {
    const empty = { dependencies: [], exports: [], files: [], duplicates: [] }
    const output = {
      issues: [
        { ...empty, file: 'apps/api/src/a.ts', exports: [{ name: 'A', line: 3, col: 1, pos: 9 }] },
        { ...empty, file: 'apps/api/src/b.ts', files: [{ name: 'apps/api/src/b.ts' }] },
        { ...empty, file: 'apps/api/package.json', dependencies: [{ name: 'x', line: 7, col: 6, pos: 1 }] },
      ],
    }
    expect(fromKnip(output)).toEqual([
      { source: 'knip', rule: 'knip(exports)', file: 'apps/api/src/a.ts', line: 3, fixable: true },
      { source: 'knip', rule: 'knip(files)', file: 'apps/api/src/b.ts', line: 0, fixable: false },
      { source: 'knip', rule: 'knip(dependencies)', file: 'apps/api/package.json', line: 7, fixable: true },
    ])
  })
})

describe('oxlint input', () => {
  test('rule codes use the diagnostic spelling of the scope', () => {
    expect(ruleCode('jsx_a11y', 'alt-text')).toBe('jsx-a11y(alt-text)')
    const codes = safeFixCodes([
      { scope: 'eslint', value: 'no-var', fix: 'fixable_fix' },
      { scope: 'eslint', value: 'no-console', fix: 'fixable_suggestion' },
      { scope: 'typescript', value: 'consistent-type-imports', fix: 'conditional_fix' },
    ])
    expect([...codes].toSorted()).toEqual(['eslint(no-var)', 'typescript(consistent-type-imports)'])
  })

  test('diagnostics become findings with their first line and fixability', () => {
    const output = {
      diagnostics: [
        { code: 'eslint(no-var)', filename: 'apps/api/src/a.ts', labels: [{ span: { line: 3 } }], message: 'x' },
        { code: 'sidequest(require-disable-description)', filename: 'scripts/stage.ts' },
      ],
      number_of_files: 2,
    }
    expect(fromOxlint(output, (code) => code === 'eslint(no-var)')).toEqual([
      { source: 'oxlint', rule: 'eslint(no-var)', file: 'apps/api/src/a.ts', line: 3, fixable: true },
      {
        source: 'oxlint',
        rule: 'sidequest(require-disable-description)',
        file: 'scripts/stage.ts',
        line: 0,
        fixable: false,
      },
    ])
  })

  test('a diagnostic without a rule (an unused disable directive) still counts', () => {
    const output = {
      diagnostics: [{ message: 'Unused oxlint-disable directive (no problems were reported).', filename: 'a.ts' }],
    }
    expect(fromOxlint(output, () => false)).toEqual([
      { source: 'oxlint', rule: 'oxlint(unused-disable-directive)', file: 'a.ts', line: 0, fixable: false },
    ])
  })

  test('output that is not oxlint JSON fails loudly instead of reporting zero findings', () => {
    expect(() => fromOxlint({ errors: [] }, () => false)).toThrow()
  })
})

const finding = (rule: string, file: string, fixable = false): Finding => ({
  source: 'oxlint',
  rule,
  file,
  line: 1,
  fixable,
})

describe('aggregate', () => {
  const report = aggregate(
    [
      finding('a(x)', 'apps/api/src/1.ts', true),
      finding('a(x)', 'apps/api/src/2.ts', true),
      finding('a(x)', 'packages/sdk/src/stage.ts'),
      finding('b(y)', 'packages/sdk/src/stage.ts'),
      finding('b(y)', 'scripts/stage.ts'),
    ],
    ['oxlint'],
  )

  test('counts per rule and per workspace, largest first', () => {
    expect(report.total).toBe(5)
    expect(report.fixable).toBe(2)
    expect(report.rules.map((row) => [row.rule, row.count, row.fixable])).toEqual([
      ['a(x)', 3, 2],
      ['b(y)', 2, 0],
    ])
    expect(report.rules[0]?.workspaces).toEqual([
      ['apps/api', 2],
      ['packages/sdk', 1],
    ])
    expect(report.workspaces.map((row) => [row.workspace, row.count])).toEqual([
      ['apps/api', 2],
      ['packages/sdk', 2],
      ['(root)', 1],
    ])
  })

  test('renders both tables, and a one-line report when clean', () => {
    const markdown = renderMarkdown(report)
    expect(markdown).toContain('5 findings (2 with a safe autofix) in 3 workspaces. Sources: oxlint.')
    expect(markdown).toContain('| `a(x)` | 3 | 2 | apps/api 2, packages/sdk 1 |')
    expect(markdown).toContain('| packages/sdk | 2 | `a(x)` 1, `b(y)` 1 |')
    expect(renderMarkdown(aggregate([], ['oxlint']))).toBe(
      '# Lint report\n\n0 findings (0 with a safe autofix) in 0 workspaces. Sources: oxlint.\n',
    )
  })
})
