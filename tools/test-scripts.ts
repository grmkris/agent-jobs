/** `bun run test:scripts`: discover and run the repository's Node test suites, including nested operator scripts. */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { repoRoot, run } from './run.ts'

export const nodeTestFiles = (root: string): string[] =>
  [
    ...new Set(
      execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', 'scripts'], { cwd: root, encoding: 'utf8' })
        .split('\n')
        .filter((file) => /^scripts\/.*\.test\.mjs$/u.test(file) && existsSync(path.join(root, file))),
    ),
  ].toSorted()

if (import.meta.main) {
  const files = nodeTestFiles(repoRoot)
  if (files.length === 0) console.info('test:scripts: no Node suites remain under scripts/')
  else process.exitCode = (await run(['node', '--test', ...files], { heavy: true, inherit: true })).exitCode
}
