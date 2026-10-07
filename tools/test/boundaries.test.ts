import path from 'node:path'
import { describe, expect, it, test } from 'vitest'
import { RuleTester } from 'oxlint/plugins-dev'
import { noCrossBoundaryImport, noRuntimeGlobal, placementOf } from '../oxlint/boundaries.ts'
import { repoRoot } from '../run.ts'

RuleTester.describe = describe
RuleTester.it = it
const tester = new RuleTester()
const at = (file: string): string => path.join(repoRoot, file)

tester.run('no-cross-boundary-import', noCrossBoundaryImport, {
  valid: [
    { code: "import { x } from '@sidequest/sdk'", filename: at('packages/board/src/a.ts') },
    { code: "import { x } from 'cloudflare:workers'", filename: at('apps/explore/worker.ts') },
    { code: "import { x } from 'bun'", filename: at('apps/arbiter/src/a.ts') },
    { code: "import { x } from 'node:fs'", filename: at('apps/explore/test/a.ts') },
    { code: "import { x } from 'node:crypto'", filename: at('packages/sdk/src/a.ts') },
  ],
  invalid: [
    {
      code: "import { x } from '@sidequest/board'", filename: at('packages/sdk/src/a.ts'),
      errors: [{ messageId: 'workspace' }],
    },
    { code: "import { x } from 'bun'", filename: at('apps/api/src/a.ts'), errors: [{ messageId: 'runtime' }] },
    { code: "import { x } from 'node:fs'", filename: at('packages/react/src/a.ts'), errors: [{ messageId: 'runtime' }] },
    {
      code: "import { x } from 'cloudflare:workers'", filename: at('packages/board/src/a.ts'),
      errors: [{ messageId: 'runtime' }],
    },
  ],
})
tester.run('no-runtime-global', noRuntimeGlobal, {
  valid: [
    { code: 'Bun.file("x")', filename: at('apps/arbiter/src/a.ts') },
    { code: 'const Bun = { file: () => 1 }; Bun.file()', filename: at('packages/sdk/src/a.ts') },
  ],
  invalid: [{ code: 'Bun.file("x")', filename: at('apps/explore/src/a.ts'), errors: [{ messageId: 'bun' }] }],
})
test('root configs are tooling, while explicit runtime zones take precedence', () => {
  expect(placementOf(at('apps/explore/vite.config.ts'))?.runtime).toBe('tooling')
  expect(placementOf(at('apps/explore/worker.ts'))?.runtime).toBe('cloud')
  expect(placementOf(at('packages/react/src/index.ts'))?.runtime).toBe('browser')
})
