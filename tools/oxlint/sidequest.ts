/**
 * The `sidequest` oxlint plugin: repository invariants from AGENTS.md that a generic linter cannot know.
 *
 * - `require-disable-description`: every disabled rule says why (`-- reason`).
 */
import { definePlugin, defineRule } from '@oxlint/plugins'
import type { Context } from '@oxlint/plugins'

const DIRECTIVE = /^\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?:\s|$)/
/** `@effect-diagnostics[-next-line] <name>:off` (effect:check); one that raises a severity needs no reason. */
const EFFECT_OFF = /^\s*@effect-diagnostics(?:-next-line)?\s[^-]*:off\b/
const MIN_REASON = 10

export const requireDisableDescription = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disable directives say why: `-- reason`.' },
    messages: {
      reason:
        'This disable directive has no reason. Write `{{directive}} {{target}} -- <why the rule is wrong here>` (at least 10 characters), or fix the code instead (docs/agents/lint-quality.md).',
    },
    schema: [],
  },
  create(context: Context) {
    return {
      Program: (): void => {
        for (const comment of context.sourceCode.getAllComments()) {
          const text = comment.value
          if (!DIRECTIVE.test(text) && !EFFECT_OFF.test(text)) continue
          const separator = text.indexOf('--')
          const reason = separator === -1 ? '' : text.slice(separator + 2).trim()
          if (reason.length >= MIN_REASON) continue
          const directive = text.trim().split(/\s/)[0] ?? 'oxlint-disable'
          const target = directive.startsWith('@effect') ? '<diagnostic>:off' : '<rule>'
          context.report({ messageId: 'reason', data: { directive, target }, loc: comment.loc })
        }
      },
    }
  },
})

export default definePlugin({
  meta: { name: 'sidequest' },
  rules: { 'require-disable-description': requireDisableDescription },
})
