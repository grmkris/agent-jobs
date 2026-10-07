/**
 * `bun run agents:check`: the agent setup is consistent for every harness (docs/agents/agent-setup.md).
 *
 * - Skills: valid frontmatter, name equals folder, unique; repo-authored descriptions 20-220 characters, no TODO;
 *   manual-only in Claude Code exactly when manual-only in Codex.
 * - Vendored skills (sources.json): licences present and unchanged SKILL.md equal to upstream.
 * - Instructions: CLAUDE.md imports AGENTS.md; each workspace has instructions and an exact shim; links resolve.
 * Sidequest does not require the reference repository's Cursor, Claude skill links or test-floor tables.
 */
import { checkAll } from './agents.ts'
import { nodes } from './graph.ts'
import { repoRoot } from './run.ts'

const failures = checkAll(
  repoRoot,
  nodes.map((node) => node.dir),
)
for (const failure of failures) console.error(failure)
if (failures.length > 0) {
  console.error(`agents:check: ${failures.length} problem(s).`)
  process.exitCode = 1
} else {
  console.info('agents:check passed')
}
